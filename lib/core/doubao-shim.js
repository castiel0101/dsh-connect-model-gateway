/**
 * 本机豆包 shim：OpenAI Chat Completions ⇄ 豆包私有协议。
 *
 * 为什么魔桥必须给豆包起 shim（而不是像小浣熊那样直连）：
 *
 * - 端点不是 OpenAI 格式：`/chat/completion` 收的是 `completion_option` /
 *   `ext` / `client_meta`，回的是字节三行帧。
 * - cookie 认证 + 风控身份：请求头要拼一整套 `sec-ch-ua`、UA 后缀，还要套
 *   浏览器身份；这些不该漏到网关层。
 * - 逐模型思考档位：OpenAI 的 `reasoning_effort` 是 `low|medium|high`，豆包
 *   是 3/4/5/6/7 且**每个模型的菜单不同**，这层翻译只能在 shim 里做。
 * - 生图：没有独立端点，靠 `ext.input_skill` 的 JSON 字符串，返回的图片没有
 *   OpenAI 助手侧的位置，只能落地成 Markdown 图片。
 *
 * 安全：只绑 127.0.0.1，校验 Host / Origin（防 DNS rebinding），
 * bearer 是进程随机串，不复用任何账号密码。
 *
 * @module dsh-connect-model-gateway/core/doubao-shim
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHAT_AGENT_MODE, DEFAULT_MODEL_ID, DEFAULT_REASONING_LEVEL,
  findReasoningLevel, isImageModelId, SKILL_CARRIER_MODEL_ID,
} from './doubao-catalog.js'
import {
  buildHeaders, buildQueryUrl, chat, classifyDoubaoFailure, DoubaoUpstreamError,
  ERROR_HINTS, isContentModerationNotice, isContinuation,
} from './doubao-upstream.js'
import { currentFingerprint } from './doubao-fingerprint.js'
import { discoverModels, levelOfId, refreshDiscovery } from './doubao-discovery.js'
import { loadCredentials } from './doubao-auth.js'

/** 哪些消息里的文字是 DSH 框架自己加的，生图时必须剔掉。 */
const FRAMEWORK_MARKERS = [
  'Current runtime context',
  'Current working directory:',
  'Time sampled while preparing',
  'Elapsed since the preceding',
  'Available skills:',
]

/**
 * 给生图挑最后一条「干净」的用户消息。
 *
 * 为什么不能把整段 transcript 直接发：框架的 system 提示里有
 * 「Current working directory: ...」「Available skills: ...」这类文字，
 * 生图模型会**照字面**把它们画进图里；更糟的是提示太长时服务端会卡住，
 * 实测一次要 114 秒才回。所以这里只取最后一条不含框架标记的用户消息。
 */
export function buildImagePrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = flattenContent(message.content).trim()
    if (text === '') continue
    if (FRAMEWORK_MARKERS.some((marker) => text.includes(marker))) continue
    // 框架注入的块是整段被标签包起来的（<system-reminder>…</system-reminder>），
    // 单看「以 < 开头」不够：中间有内容，`^<[^>]+>$` 匹配不到。
    if (/^<[\s\S]*>$/u.test(text) || /^\[[\s\S]*\]$/u.test(text)) continue
    return text
  }
  // 全是框架消息：用最后一条用户消息兜底，至少不会空着发
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue
    return flattenContent(messages[index].content).trim()
  }
  return ''
}

/** 把 OpenAI 的多段 content 拼成纯文本。 */
function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const item of content) {
    if (typeof item === 'string') parts.push(item)
    else if (typeof item?.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

/** 普通对话的 prompt：保留整段 transcript，但给每段标出角色。 */
export function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const turns = []
  for (const message of messages) {
    const text = flattenContent(message?.content)
    if (text === '') continue
    const role = message?.role ?? 'user'
    turns.push(role === 'user' ? text : `[${role}] ${text}`)
  }
  return turns.join('\n\n')
}

/** 下载图片到本地，返回可点开的 Markdown。 */
export async function imageMarkdownLocal(images) {
  const out = []
  let index = 0
  for (const image of Array.isArray(images) ? images : []) {
    if (typeof image?.url !== 'string' || image.url === '') continue
    index += 1
    let target = image.url
    try {
      const response = await fetch(image.url, {
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })
      if (response.ok) {
        const body = Buffer.from(await response.arrayBuffer())
        if (body.length > 0) {
          const dir = join(homedir(), '.dsh', 'doubao-images')
          mkdirSync(dir, { recursive: true })
          const suffix = image.url.toLowerCase().includes('.png') ? 'png' : 'jpg'
          const path = join(dir, `image-${Date.now()}-${index}.${suffix}`)
          writeFileSync(path, body)
          target = path
        }
      }
    } catch {
      // 落盘失败就退回远端 URL，至少图还能看见（只是可能带水印/过期）
    }
    out.push(`![豆包生图 ${index}](${markdownSafeUrl(target)})`)
  }
  return out.join('\n\n')
}

/** URL 里裸的 `(` `)` `~` 会截断 Markdown 图片语法，编码掉。 */
export function markdownSafeUrl(url) {
  if (typeof url !== 'string') return ''
  return url.replace(/~/g, '%7E').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20')
}

/** 续聊会话：按「首条用户消息」做 key，避免所有会话撞到同一条系统提示上。 */
function sessionKeyOf(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const opening = messages.find((message) => message?.role === 'user') ?? messages[0]
  const text = flattenContent(opening?.content)
  if (text === '') return undefined
  return `${opening?.role ?? 'user'}\u0000${text.slice(0, 256)}`
}

/**
 * 每次请求解析出的上游参数。
 *
 * 单独暴露是为了测试：把「请求里选了什么模型/档位」和「怎么发请求」分开，
 * 生图与思考的坑就能在单元测试里锁住。
 */
export function requestOptions(parsed) {
  const model = typeof parsed?.model === 'string' && parsed.model !== '' ? parsed.model : DEFAULT_MODEL_ID
  const imageTurn = isImageModelId(model)
  let level = levelOfId(parsed?.reasoning_effort)
  if (level === undefined) level = findReasoningLevel(DEFAULT_REASONING_LEVEL).level

  const models = discoverModels()
  const selected = models.find((item) => item.id === model)
  // 「豆包 快速」**不能思考**：实测开关开着、档位拉高，回复依然 thinking:false。
  // 声明 reasoning:false 是唯一诚实的做法。
  let deepThink = !imageTurn && selected?.reasoning !== false
  if (deepThink && (level < 3 || level > 7)) deepThink = false

  return {
    modelKey: imageTurn ? SKILL_CARRIER_MODEL_ID : model,
    skill: imageTurn ? 'imageGen' : undefined,
    isImageTurn: imageTurn,
    reasoningLevel: level,
    deepThink,
  }
}

/** 一条豆包上游错误 → OpenAI 错误信封。 */
function errorEnvelope(error) {
  const kind = classifyDoubaoFailure(error)
  const status = {
    rate_limited: 429, quota_exhausted: 429, session_dead: 401,
    network: 502, upstream: 502, content_blocked: 400,
    context_overflow: 400, task_runtime_unavailable: 409,
  }[kind] ?? 502
  const message = error instanceof DoubaoUpstreamError && error.message !== ''
    ? error.message
    : ERROR_HINTS[kind] ?? '豆包请求失败'
  return { status, kind, payload: { error: { message, type: kind, code: kind } } }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 只绑 loopback 且校验 Host / Origin，防 DNS rebinding 打到本地 shim。 */
function requestAllowed(req) {
  const host = String(req.headers.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase())) return false
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(String(origin)).hostname.toLowerCase())
  } catch {
    return false
  }
}

const sessions = new Map()
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_MAX = 256

function sessionRemember(key, conversationId, messageCount) {
  if (key === undefined || conversationId === '' || conversationId === undefined) return
  sessions.delete(key)
  sessions.set(key, { conversationId, messageCount, at: Date.now() })
  for (const [stored, value] of sessions) {
    if (Date.now() - value.at <= SESSION_TTL_MS) break
    sessions.delete(stored)
  }
  while (sessions.size > SESSION_MAX) {
    const oldest = sessions.keys().next().value
    sessions.delete(oldest)
  }
}

function sessionForget(key) {
  if (key !== undefined) sessions.delete(key)
}

/** 生图轮不复用会话；普通对话且 transcript 变长了才续聊。 */
function sessionPlan(key, messages, isImageTurn) {
  const previous = sessions.get(key)
  if (isImageTurn || previous === undefined || !isContinuation(messages, previous)) {
    return { state: undefined, messages }
  }
  return {
    state: previous,
    messages: messages.slice(Math.min(Math.max(previous.messageCount, 0), messages.length)),
  }
}

/**
 * 创建 shim。
 *
 * 与魔桥另三个 shim 保持同样的接口：`baseUrl()` / `token()` / `close()`，
 * 另外多一个 `quota()` 供 manager 取额度（其它 shim 的额度走 adapter）。
 */
export function createDoubaoShim(options = {}) {
  const token = options.token ?? randomBytes(32).toString('base64url')
  const credentials = options.credentials ?? loadCredentials
  const fingerprint = options.fingerprint ?? currentFingerprint
  const idleMs = options.idleTimeoutMs ?? 300_000
  /** 每次真正上行一轮时通知上层（manager.markUsed），用于「最近使用」排序。 */
  const onChat = options.onChat
  let server
  let listening

  const handleChat = async (req, res, body) => {
    const parsed = typeof body === 'object' && body !== null ? body : {}
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const opts = requestOptions(parsed)
    const key = sessionKeyOf(messages)
    const plan = sessionPlan(key, messages, opts.isImageTurn)
    const prompt = opts.isImageTurn
      ? buildImagePrompt(messages)
      : buildPrompt(plan.messages)

    if (prompt.trim() === '') {
      writeJson(res, 400, { error: { message: '消息为空', type: 'invalid_request', code: 'invalid_request' } })
      return
    }

    const upstreamOptions = {
      modelKey: opts.modelKey,
      skill: opts.skill,
      deepThink: opts.deepThink,
      reasoningLevel: opts.reasoningLevel,
      conversationId: plan.state?.conversationId,
      continueConversation: plan.state !== undefined,
      // 普通对话模式；「工作任务」的运行时在客户端进程里，外部接不上
      taskMode: false,
      agentMode: CHAT_AGENT_MODE,
      messages: opts.isImageTurn ? undefined : plan.messages,
      credentials: credentials(),
      fingerprint: fingerprint(),
    }

    const abort = new AbortController()
    let gone = false
    const onClose = () => {
      if (res.writableEnded) return
      gone = true
      abort.abort()
    }
    res.on('close', onClose)
    let idleTimer
    const touch = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        abort.abort(new Error(`豆包 ${Math.round(idleMs / 1000)} 秒没有返回数据，已中止`))
      }, idleMs)
      idleTimer.unref?.()
    }
    touch()

    try {
      onChat?.()
      const result = await chat(prompt, { ...upstreamOptions, signal: abort.signal })
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      if (gone) return

      if (!opts.isImageTurn) sessionRemember(key, result.conversationId, messages.length)
      else sessionForget(key)

      let text = result.text
      if (isContentModerationNotice(text)) {
        // 审核通知不是回答；作为错误抛出，别让用户以为模型真的拒答了
        throw new DoubaoUpstreamError(text, 0, false, { kind: 'content_blocked', status: 400 })
      }
      const markdown = await imageMarkdownLocal(result.images)
      if (markdown !== '') text = `${text}${text === '' ? '' : '\n\n'}${markdown}`

      if (parsed.stream === false) {
        writeJson(res, 200, {
          id: `chatcmpl-${randomBytes(8).toString('hex')}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: parsed.model ?? DEFAULT_MODEL_ID,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const chunk = (delta, finishReason = null) => {
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-${randomBytes(8).toString('hex')}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: parsed.model ?? DEFAULT_MODEL_ID,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`)
      }
      chunk({ role: 'assistant', content: '' })
      // 整段发：豆包的增量块里含大量重复快照，逐字节转发会重复文本；
      // 上游客户端已经完成了去重，这里发最终文本才是正确的。
      chunk({ content: text === '' ? ' ' : text })
      chunk({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      if (gone) return
      const { status, payload } = errorEnvelope(error)
      if (classifyDoubaoFailure(error) === 'session_dead') sessionForget(key)
      if (res.headersSent) {
        // SSE 已开始，错误只能塞进流里，否则 pi-ai 当作空回复
        res.write(`data: ${JSON.stringify({ error: payload.error })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        writeJson(res, status, payload)
      }
    } finally {
      res.off('close', onClose)
    }
  }

  const handleQuota = async (_req, res) => {
    try {
      const { fetchQuota } = await import('./doubao-quota.js')
      const data = await fetchQuota({ credentials: credentials(), fingerprint: fingerprint() })
      writeJson(res, 200, data)
    } catch (error) {
      writeJson(res, 502, { error: { message: error?.message ?? String(error), type: 'upstream', code: 'upstream' } })
    }
  }

  const handleModels = async (_req, res) => {
    try {
      const result = await refreshDiscovery(credentials(), { fingerprint: fingerprint() })
      writeJson(res, 200, { object: 'list', data: result.models, source: result.source })
    } catch (error) {
      writeJson(res, 502, { error: { message: error?.message ?? String(error), type: 'upstream', code: 'upstream' } })
    }
  }

  const handler = async (req, res) => {
    if (!requestAllowed(req)) {
      writeJson(res, 403, { error: { message: 'Host / Origin 不允许', type: 'forbidden', code: 'forbidden' } })
      return
    }
    const auth = String(req.headers.authorization ?? '')
    if (auth !== `Bearer ${token}`) {
      writeJson(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res)
      return
    }
    if (url.pathname === '/quota' && req.method === 'GET') {
      await handleQuota(req, res)
      return
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw = ''
      try {
        for await (const piece of req) raw += piece
        const body = JSON.parse(raw === '' ? '{}' : raw)
        await handleChat(req, res, body)
      } catch (error) {
        if (!res.headersSent) {
          writeJson(res, 400, { error: { message: `请求无效：${error?.message ?? error}`, type: 'invalid_request', code: 'invalid_request' } })
        }
      }
      return
    }
    writeJson(res, 404, { error: { message: 'not found', type: 'invalid_request', code: 'not_found' } })
  }

  server = createServer((req, res) => {
    void handler(req, res)
  })
  // 只绑 loopback。写死，杜绝被动暴露到局域网的可能。
  listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

  let base = undefined
  return {
    token: () => token,
    baseUrl: async () => base ?? (base = await listening),
    baseUrlSync: () => base,
    async close() {
      await new Promise((resolve) => {
        try { server.close(resolve) } catch { resolve() }
      })
    },
  }
}

void tmpdir
