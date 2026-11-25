/**
 * CodeArts 本地转发 shim。
 *
 * 为什么需要它：CodeArts 的推理端点要求华为云 AK/SK 签名（`SDK-HMAC-SHA256`），
 * 而 pi-ai 只会发 `Authorization: Bearer <key>`。签名逻辑没法塞进 Bearer 通道，
 * 所以这里起一个只绑 127.0.0.1 的 OpenAI 兼容端点：pi-ai 指向它，它负责
 * 补签名、补 `x-auth-token`，再转发给 snap-access。
 *
 * WorkBuddy 不需要这个：它直接吃 Bearer，直连即可。
 *
 * 加固（沿用同类插件的做法）：只绑回环、随机端口、校验 Host 回环、
 * 请求体上限、进程内随机 bearer。
 *
 * @module dsh-connect-model-gateway/core/shim
 */

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { signRequest } from './huawei-signer.js'

/** 单请求体上限：够放一个长会话，但挡住意外的大上传。 */
const BODY_LIMIT = 32 * 1024 * 1024

/** 上游硬上限，超出会被拒。 */
const MAX_TOKENS_CEILING = 65_536

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

function sendOpenAIError(response, status, code, message, extraHeaders) {
  sendJson(response, status, { error: { message, type: code, code } }, extraHeaders)
}

/**
 * 上游「并发会话数已达上限」的错误码（dsh-codearts 实测，见其 src/upstream.ts）。
 * 免费档 3 个会话、企业档 5 个，且中途打断不减免，槽位约 52 秒才释放。
 * 这不是额度不足 —— 不能归类成 quota_exceeded，否则界面会误报「额度已用尽」。
 */
const CONCURRENCY_CAP_CODE = 'TM.00001041'

/**
 * CodeArts 上游失败 → HTTP 状态。
 *
 * 401/403 续期失效、402 额度、429 限流归 429；并发会话上限单独归 409
 * （宿主把 429 显示成「额度已用尽」，而并发满只是要等，不是没钱）。
 * 模型不存在/无权限与 5xx 归 502，其余 400。
 * 429 / 409 都带 x-should-retry: false —— 上游说的是「等」，不是「马上重试」。
 */
function classifyCodeArts(status, text) {
  const lower = String(text ?? '').toLowerCase()
  if (/inferhub\.modelarts\.81003\.401|does not exist or you do not have access/.test(text ?? '')) return { status: 502, code: 'not_found' }
  if (status === 401 || status === 403) return { status: 401, code: 'session_dead' }
  if (status === 402) return { status: 402, code: 'hard_credit' }
  if (text?.includes(CONCURRENCY_CAP_CODE) || lower.includes('并发会话数已达上限')) {
    return { status: 409, code: 'concurrency_cap', retryable: false }
  }
  if (status === 429) return { status: 429, code: 'quota_exceeded', retryable: false }
  if (lower.includes('queued') || lower.includes('并发') || lower.includes('tpm')) {
    return { status: 429, code: 'quota_exceeded', retryable: false }
  }
  if (status === 404) return { status: 502, code: 'not_found' }
  if (status >= 500) return { status: 502, code: 'server' }
  return { status: 400, code: 'client' }
}

/** 并发队列最长等待：超过就明确报错，不无限挂起。 */
const MAX_QUEUE_WAIT_MS = 60_000

/**
 * 并发闸：同时最多 N 个推理请求，其余排队；上限可在运行时调整。
 * 等待带超时，避免上游一直占着槽位时请求永远挂着。
 */
function createConcurrencyGate(limit) {
  let running = 0
  let cap = limit
  const waiting = []
  const drain = () => {
    while (running < cap && waiting.length > 0) {
      const job = waiting.shift()
      clearTimeout(job.timer)
      running += 1
      job.resolve()
    }
  }
  const release = () => {
    running -= 1
    drain()
  }
  return {
    async run(task) {
      if (running >= cap) {
        await new Promise((resolve, reject) => {
          const job = { resolve, reject, timer: null }
          job.timer = setTimeout(() => {
            const index = waiting.indexOf(job)
            if (index >= 0) waiting.splice(index, 1)
            reject(new Error(`并发队列等待超过 ${Math.round(MAX_QUEUE_WAIT_MS / 1000)} 秒`))
          }, MAX_QUEUE_WAIT_MS)
          job.timer.unref?.()
          waiting.push(job)
        })
      } else {
        running += 1
      }
      try {
        return await task()
      } finally {
        release()
      }
    },
    setLimit(value) {
      if (!Number.isFinite(value)) return
      cap = Math.max(1, Math.floor(value))
      drain()
    },
  }
}

/** 常量时间比较。 */
function secretsEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 把 pi-ai 发来的 OpenAI 请求体改写成 CodeArts 认的形状。
 *
 * 与旧插件一致的几处必要改写：
 * - `developer` → `system`（上游不认 developer）
 * - `stream_options.include_usage` 强制 true
 * - `max_tokens` 钳制到上游硬上限
 * - 去掉 `tools[].function.strict`（上游不认）
 * - 补 `chat_id` / `prompt_cache_key` / `tool_stream`
 */
export function prepareBody(rawText, canonicalize) {
  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { body: rawText, model: '' }
  }
  const model = typeof parsed.model === 'string' ? canonicalize(parsed.model) : ''
  const body = {}
  for (const key of [
    'messages', 'temperature', 'top_p', 'max_tokens', 'stop',
    'presence_penalty', 'frequency_penalty', 'tools', 'tool_choice',
    'user', 'stream_options', 'reasoning_effort',
  ]) {
    if (parsed[key] !== undefined) body[key] = parsed[key]
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) =>
      message?.role === 'developer' ? { ...message, role: 'system' } : message,
    )
  }
  if (body.stream_options === null || typeof body.stream_options !== 'object') {
    body.stream_options = { include_usage: true }
  } else {
    body.stream_options.include_usage = true
  }
  if (body.max_tokens === undefined && typeof parsed.max_completion_tokens === 'number') {
    body.max_tokens = parsed.max_completion_tokens
  }
  if (typeof body.max_tokens === 'number') {
    body.max_tokens = Math.min(body.max_tokens, MAX_TOKENS_CEILING)
  }
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => {
      if (tool && typeof tool === 'object' && tool.function && typeof tool.function === 'object') {
        const fn = { ...tool.function }
        delete fn.strict
        return { ...tool, function: fn }
      }
      return tool
    })
  }
  const chatId = createHash('sha256').update(String(parsed.messages?.[0]?.content ?? randomBytes(8).toString('hex'))).digest('hex').slice(0, 32)
  body.model = model
  body.stream = true
  body.chat_id = chatId
  body.prompt_cache_key = chatId
  body.tool_stream = true
  return { body: JSON.stringify(body), model }
}

/**
 * 起一个 CodeArts 转发端点。
 *
 * @param {{adapter: object, canonicalize: (id:string)=>string, warn?: (m:string)=>void}} options
 * @returns {Promise<{url:string, token:string, close: () => Promise<void>}>}
 */
export async function startCodeArtsShim(options) {
  const bearer = randomBytes(32).toString('hex')
  const { adapter, canonicalize } = options
  const clampLimit = (value) => {
    const n = Math.floor(Number(value))
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 16) : 2
  }
  // 每账号并发上限（默认 2），运行时可调
  const gate = createConcurrencyGate(clampLimit(options.maxConcurrent ?? 2))

  const server = createServer(async (request, response) => {
    try {
      // 只认回环 Host，挡住 DNS rebinding
      const host = request.headers.host ?? ''
      const hostname = host.split(':')[0]
      if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
        sendOpenAIError(response, 403, 'forbidden', 'shim only serves loopback')
        return
      }
      const url = request.url ?? '/'

      if (request.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        sendJson(response, 200, { ok: true })
        return
      }

      if (request.method === 'GET' && (url.endsWith('/models') || url.endsWith('/models/'))) {
        const models = await adapter.listModels()
        sendJson(response, 200, {
          object: 'list',
          data: models.map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: 'codearts' })),
        })
        return
      }

      if (request.method !== 'POST' || !url.includes('/chat/completions')) {
        sendOpenAIError(response, 404, 'not_found', `no such route: ${request.method} ${url}`)
        return
      }

      // 入站 bearer 校验：pi-ai 会带我们注入的 apiKey
      const authorization = request.headers.authorization ?? ''
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!secretsEqual(presented, bearer)) {
        sendOpenAIError(response, 401, 'unauthorized', 'missing or invalid bearer')
        return
      }

      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > BODY_LIMIT) {
          sendOpenAIError(response, 413, 'too_large', 'request body too large')
          return
        }
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const prepared = prepareBody(raw, canonicalize)

      options.onChat?.()
      const credential = await adapter.credentialForShim()
      const bodyBuffer = Buffer.from(prepared.body)
      const upstream = new Request(adapter.chatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-auth-token': credential.token,
          'X-Security-Token': credential.securityToken,
          'X-Language': 'zh-cn',
          'app-id': 'CodeAgent3.0',
          'is_confidential': 'false',
          'x-snap-traceid': randomBytes(16).toString('hex'),
        },
        body: bodyBuffer,
      })
      signRequest(upstream, bodyBuffer, {
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        securityToken: credential.securityToken,
      })

      let answer
      try {
        answer = await gate.run(() => fetch(upstream))
      } catch (error) {
        const queued = error instanceof Error && error.message.startsWith('并发队列等待')
        sendOpenAIError(
          response,
          queued ? 409 : 502,
          queued ? 'concurrency_cap' : 'transport',
          queued ? error.message : `upstream transport error: ${String(error)}`,
          queued ? { 'x-should-retry': 'false' } : undefined,
        )
        return
      }

      if (!answer.ok) {
        const text = await answer.text().catch(() => '')
        const verdict = classifyCodeArts(answer.status, text)
        sendOpenAIError(
          response,
          verdict.status,
          verdict.code,
          `codearts 上游失败（http ${answer.status}，${verdict.code}）：${text.slice(0, 360)}`,
          verdict.retryable === false ? { 'x-should-retry': 'false' } : undefined,
        )
        return
      }

      // 上游是 OpenAI 兼容 SSE，但仍可能给出累积全文快照，需要转成增量
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      const reader = answer.body.getReader()
      const decoder = new TextDecoder()
      let carry = ''
      let lastText = ''
      let sawDone = false

      const write = (payload) => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`)
      }

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          carry += decoder.decode(value, { stream: true })
          const lines = carry.split('\n')
          carry = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') {
              if (!sawDone) {
                sawDone = true
                response.write('data: [DONE]\n\n')
              }
              continue
            }
            if (payload === '') continue
            let event
            try {
              event = JSON.parse(payload)
            } catch {
              continue
            }
            if (event.error_code !== undefined && event.error_code !== '0' && event.error_code !== 0) {
              write({
                choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
                error: { code: event.error_code, message: event.error_msg ?? 'upstream error' },
              })
              response.write('data: [DONE]\n\n')
              response.end()
              return
            }
            if (Array.isArray(event.choices)) {
              response.write(`data: ${JSON.stringify(event)}\n\n`)
              continue
            }
            if (typeof event.delta?.content === 'string') {
              write({ model: prepared.model, choices: [{ index: 0, delta: { content: event.delta.content }, finish_reason: null }] })
              continue
            }
            // 累积全文快照形态：只在前缀延伸时取增量
            if (typeof event.text === 'string' && event.text !== '[DONE]') {
              if (event.text.length > lastText.length && event.text.startsWith(lastText)) {
                write({
                  model: prepared.model,
                  choices: [{ index: 0, delta: { content: event.text.slice(lastText.length) }, finish_reason: null }],
                })
              }
              lastText = event.text
            }
          }
        }
      } catch (error) {
        options.warn?.(`CodeArts 流转发中断：${String(error)}`)
      } finally {
        if (!sawDone && response.writable) response.write('data: [DONE]\n\n')
        if (response.writable) response.end()
        reader.cancel().catch(() => {})
      }
    } catch (error) {
      if (!response.headersSent) {
        sendOpenAIError(response, 500, 'internal', error instanceof Error ? error.message : String(error))
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
    setMaxConcurrent: (value) => gate.setLimit(clampLimit(value)),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        // 有长连接时不无限等
        setTimeout(resolve, 500).unref?.()
      }),
  }
}
