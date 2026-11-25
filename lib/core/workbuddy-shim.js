/**
 * WorkBuddy 本地转发端点。
 *
 * 为什么需要它：渠道校验看的是**正文指纹 + 请求头自称**，两者都必须在发出前改写，
 * 而 pi-ai 只会发普通 Bearer 与原始正文。所以这里起一个只绑 127.0.0.1 的
 * OpenAI 兼容端点：正文过 `prepareChatBody`，头用 `chatHeaders`，
 * 再转发到 copilot / workbuddy.ai。
 *
 * 重试阶梯（照抄旧插件的行为）：11128 → 强行中性开头 → 句读处插入零宽空格
 * → 更密的插入。同一凭证重试，因为网关看的是请求内容而不是账号。
 *
 * @module dsh-connect-model-gateway/core/workbuddy-shim
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { prepareChatBody, forceNeutralHead, perturbChannelFingerprints } from './workbuddy-gate.js'
import { classifyUpstreamError, hostErrorCode, KIND_STATUS } from './workbuddy-errors.js'
import { chatBase, chatHeaders } from './workbuddy-wire.js'

const BODY_LIMIT = 64 * 1024 * 1024

function sendJson(response, status, payload, extraHeaders) {
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(extraHeaders ?? {}),
  })
  response.end(text)
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: { message, type: code, code } })
}

function secretsEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** 上游失败体里是否是渠道校验。 */
function isChannelReject(status, text) {
  if (status !== 400) return false
  return text.includes('11128') || text.includes('unapproved channel') || text.includes('Illegal API invocation')
}

/**
 * 上游失败 → HTTP 状态。
 *
 * 分类用旧插件那张表：额度不足必须 402（不是 429），否则宿主会把它当普通限流
 * 原地重试，白烧重试预算；429 还要把 code 翻成 quota_exceeded 才落到不重试集合。
 */
function statusForUpstream(failure) {
  const kind = classifyUpstreamError(failure.status, failure.body)
  return { status: KIND_STATUS[kind] ?? 502, kind, code: hostErrorCode(kind) }
}

/**
 * 起端点。
 *
 * @param {{
 *   credential: () => Promise<object>,
 *   warn?: (m: string) => void,
 * }} options
 */
export async function startWorkBuddyShim(options) {
  const bearer = randomBytes(32).toString('hex')
  const warn = options.warn ?? (() => {})

  /** 发一次。返回 {ok, status, body, response}。 */
  async function send(credential, bodyText, signal) {
    // chatHeaders 不含 Authorization（旧插件同样由调用方补上这一行）
    const headers = {
      ...chatHeaders(credential, {}),
      Authorization: `Bearer ${credential.accessToken}`,
    }
    let response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers,
        body: bodyText,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      return { ok: false, status: 0, body: `transport: ${String(error)}` }
    }
    if (response.ok) return { ok: true, status: response.status, response }
    const text = (await response.text()).slice(0, 4096)
    return { ok: false, status: response.status, body: text }
  }

  const server = createServer(async (request, response) => {
    try {
      const hostname = (request.headers.host ?? '').split(':')[0]
      if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
        sendError(response, 403, 'forbidden', 'shim only serves loopback')
        return
      }
      const url = request.url ?? '/'

      if (request.method === 'GET' && url.startsWith('/healthz')) {
        sendJson(response, 200, { ok: true })
        return
      }

      if (request.method === 'GET' && url.includes('/models')) {
        sendJson(response, 200, { object: 'list', data: [] })
        return
      }

      if (request.method !== 'POST' || !url.includes('/chat/completions')) {
        sendError(response, 404, 'not_found', `no such route: ${request.method} ${url}`)
        return
      }

      const authorization = request.headers.authorization ?? ''
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!secretsEqual(presented, bearer)) {
        sendError(response, 401, 'unauthorized', 'missing or invalid bearer')
        return
      }

      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > BODY_LIMIT) {
          sendError(response, 413, 'too_large', 'request body too large')
          return
        }
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString('utf8')

      const controller = new AbortController()
      response.on('close', () => controller.abort())

      options.onChat?.()
      const credential = await options.credential()

      // 正文归一化：与旧插件同样的顺序与阶梯
      const prepared = prepareChatBody(raw)
      let attempt = await send(credential, prepared, controller.signal)

      if (!attempt.ok && isChannelReject(attempt.status, attempt.body)) {
        warn('WorkBuddy 渠道校验拦截，按旧插件的阶梯重试（强制中性开头）')
        const forced = forceNeutralHead(prepared)
        if (forced !== undefined) attempt = await send(credential, forced, controller.signal)
      }
      if (!attempt.ok && isChannelReject(attempt.status, attempt.body)) {
        warn('WorkBuddy 仍被拦截，改用句读处插入零宽空格')
        const perturbed = perturbChannelFingerprints(prepared, false)
        if (perturbed !== undefined) attempt = await send(credential, perturbed, controller.signal)
      }
      if (!attempt.ok && isChannelReject(attempt.status, attempt.body)) {
        warn('WorkBuddy 仍被拦截，改用更密的插入')
        const dense = perturbChannelFingerprints(prepared, true)
        if (dense !== undefined) attempt = await send(credential, dense, controller.signal)
      }

      if (!attempt.ok) {
        const { status, kind, code } = statusForUpstream(attempt)
        // 429 明确告诉客户端别原地重试（上游说的是「等几分钟」，不是「马上重试」）
        const headers = status === 429 ? { 'x-should-retry': 'false', allow: 'POST' } : undefined
        sendJson(
          response,
          status,
          { error: { message: `workbuddy 上游失败（http ${attempt.status}，${kind}）：${attempt.body.slice(0, 360)}`, type: kind, code } },
          headers,
        )
        return
      }

      // 上游是 OpenAI 兼容 SSE，直接转发
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const upstream = Readable.fromWeb(attempt.response.body)
      upstream.on('data', (chunk) => {
        if (response.writable) response.write(chunk)
      })
      upstream.on('end', () => {
        if (response.writable) response.end()
      })
      upstream.on('error', (error) => {
        warn(`WorkBuddy 流转发中断：${String(error)}`)
        if (response.writable) response.end()
      })
      response.on('close', () => upstream.destroy())
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, 500, 'internal', error instanceof Error ? error.message : String(error))
      } else if (response.writable) {
        response.end()
      }
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    token: bearer,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        setTimeout(resolve, 500).unref?.()
      }),
  }
}
