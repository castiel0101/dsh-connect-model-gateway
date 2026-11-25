/**
 * 灵犀本地转发端点（从 dsh-connect-lingxi@0.0.20 逐字移植核心协议）。
 *
 * 灵犀没有开放 API，走桌面客户端自己的私有 app-server：一次对话 = 三次握手
 * （建会话 → 领 run → chat/completions SSE）。请求体与响应帧都要翻译：
 * - content 分段 → 字符串；对象 tool_choice → 字符串（上游只吃字符串）
 * - 正文在 choices[].text（不是 delta.content）；无 [DONE]，靠 finish_reason
 * - tool_calls 按 index 聚合，arguments 字符串拼接
 * - reasoning_content / usage 直通
 *
 * 只监听 127.0.0.1 随机端口；Bearer token 防止本机其他进程误用。
 *
 * @module dsh-connect-model-gateway/core/lingxi-shim
 */

import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { AdapterError } from './adapter.js'

const BASE = 'https://lingxi.wps.cn'
const KDOCS_BASE = 'https://lingxi.kdocs.cn'
const DEVICE_ID = createHash('sha256').update('dsh-connect-model-gateway-lingxi-device').digest('hex')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const KSO = `x-kso-app-name=win-lingxi-desktop; x-kso-app-version=1.3.31; x-kso-device-id=${DEVICE_ID}`
const MAX_PROMPT_TOKENS = 1_048_576

function json(response, status, payload, extra = {}) {
  const text = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra })
  response.end(text)
}

function openAiError(response, status, code, message) {
  json(response, status, { error: { message, type: status >= 500 ? 'api_error' : 'invalid_request_error', code } })
}

function secretsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function baseHeaders(credential, extra = {}) {
  const cookie = `${credential.cookie ?? ''}; ${KSO}`
  const headers = { Cookie: cookie, 'User-Agent': UA, Referer: `${BASE}/`, Accept: 'application/json', ...extra }
  const branch = /copilot_server_branch=([^;]+)/.exec(credential.cookie ?? '')
  if (branch !== null) headers['X-Cc-Region'] = branch[1].trim()
  return headers
}

/** 上游 API 请求；两个域都试，401/403 且明确鉴权文案才算登录失效。 */
async function api(base, path, credential, options = {}) {
  const headers = baseHeaders(credential, options.headers ?? {})
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  const text = await response.text().catch(() => '')
  let payload
  try { payload = text ? JSON.parse(text) : {} } catch { payload = {} }
  if (response.status === 401 || response.status === 403) {
    const diagnostics = [payload?.code, payload?.message, payload?.errmsg, payload?.error, payload?.detail, payload?.reason]
      .filter((x) => typeof x === 'string').join(' ')
    if (/unauthor|登录|凭据|credential|cookie|sid/i.test(diagnostics)) {
      throw new AdapterError('灵犀登录态已失效，请重新登录', { status: 401, permanent: true })
    }
    // 其它 401/403 映射成"模型不存在"
    throw new AdapterError(`灵犀模型或参数不可用（http ${response.status}）：${diagnostics.slice(0, 120)}`, { status: 404 })
  }
  if (response.status >= 400 && response.status < 500) {
    throw new AdapterError(`灵犀参数错误（http ${response.status}）：${String(payload?.message ?? text).slice(0, 120)}`, { status: 404 })
  }
  if (!response.ok) {
    throw new AdapterError(`灵犀服务错误（http ${response.status}）：${String(payload?.message ?? text).slice(0, 120)}`, { status: response.status })
  }
  return payload
}

async function apiBoth(path, credential, options) {
  try {
    return await api(BASE, path, credential, options)
  } catch (error) {
    if (error instanceof AdapterError && error.status === 401) throw error
    return api(KDOCS_BASE, path, credential, options)
  }
}

/**
 * 归一请求体 —— 照抄旧插件 `src/protocol/normalize.ts`：
 * 1. `content` 只能是字符串（分段数组一律 400 InvalidArgument），
 *    非数组非字符串（null/对象）也要变成空串；
 * 2. `role: 'developer'` 要换成 `system`；
 * 3. `tool_choice` 只能是字符串（对象一律 400），指定函数时降级成 `required`。
 */
export function normalizeAgentBody(raw) {
  const body = { ...raw }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      if (message === null || typeof message !== 'object') return message
      const role = message.role === 'developer' ? 'system' : message.role
      const content = message.content
      if (typeof content === 'string') {
        return role === message.role ? message : { ...message, role }
      }
      if (!Array.isArray(content)) {
        // null / undefined / 对象都不被上游接受，缺内容就发空串
        return { ...message, role, content: '' }
      }
      const parts = content
        .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : null))
        .filter((text) => text !== null)
      return { ...message, role, content: parts.join('\n') }
    })
  }
  if (body.tool_choice !== null && typeof body.tool_choice === 'object') {
    body.tool_choice = body.tool_choice?.type === 'function' ? 'required' : 'auto'
  }
  if (typeof body.max_tokens === 'number') {
    body.base_llm_arguments = { ...(body.base_llm_arguments ?? {}), max_tokens: body.max_tokens }
    delete body.max_tokens
  }
  if (typeof body.reasoning_effort === 'string') {
    body.llm_arguments = { ...(body.llm_arguments ?? {}), reasoning_effort: body.reasoning_effort }
  }
  return body
}

/** 三步握手：建会话 + 领 run，返回后续 chat 需要的头。 */
async function handshake(credential, model, lastUserText) {
  const session = await apiBoth('/api/aioffice/v1/cowork/sessions', credential, {
    method: 'POST',
    body: {
      session_type: 'cowork_client',
      agent_version: 2,
      env: { device_id: DEVICE_ID, device_name: 'dsh-connect-model-gateway', work_space_dir: '/tmp' },
    },
  })
  const sessionId = session?.data?.session_id
  if (typeof sessionId !== 'string') throw new AdapterError('灵犀没有返回 session_id', { status: 502 })
  const run = await apiBoth('/api/public/v1/credits/runs', credential, {
    method: 'POST',
    body: {
      client_request_id: String(Date.now()),
      session_id: sessionId,
      model_provider: 'lingxi',
      model_id: model,
      agent_input: {
        text: lastUserText, files: [], file_ids: [], expect_model: model, refs: [],
        permission_mode: 'default', current_mode: 'agent', browser_plugin_enabled: false,
      },
    },
  })
  const runId = run?.data?.run_id
  if (typeof runId !== 'string') throw new AdapterError('灵犀没有返回 run_id', { status: 502 })
  return {
    sessionId,
    groupId: run?.data?.group_id ?? runId,
    headers: {
      'X-Client-Type': 'lingxi_claw',
      'X-Client-Lang': 'zh-CN',
      'X-Cc-Agent-Type': 'lingxi_claw',
      'X-Request-Id': randomUUID(),
      'X-Cc-Session-ID': sessionId,
      'X-Cc-Run-ID': runId,
    },
  }
}

/** 把灵犀 SSE 帧翻译成 OpenAI SSE。 */
function translateFrame(payload, state) {
  const out = []
  const choice = payload?.choices?.[0]
  const base = { id: `chatcmpl-lingxi-${Date.now()}`, object: 'chat.completion.chunk' }
  if (typeof choice?.text === 'string' && choice.text !== '') {
    out.push({ ...base, choices: [{ index: 0, delta: { content: choice.text } }] })
  }
  if (typeof choice?.reasoning_content === 'string' && choice.reasoning_content !== '') {
    out.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: choice.reasoning_content } }] })
  }
  if (Array.isArray(choice?.tool_calls)) {
    const calls = choice.tool_calls.map((call, index) => {
      const key = typeof call.index === 'number' ? call.index : index
      const prev = state.tools.get(key) ?? { id: '', name: '', args: '' }
      const id = typeof call.id === 'string' && call.id !== '' ? call.id : prev.id
      const name = typeof call.function?.name === 'string' && call.function.name !== '' ? call.function.name : prev.name
      const args = prev.args + (typeof call.function?.arguments === 'string' ? call.function.arguments : '')
      state.tools.set(key, { id, name, args })
      return { index: key, id, type: 'function', function: { name, arguments: call.function?.arguments ?? '' } }
    })
    out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: calls } }] })
  }
  if (choice?.finish_reason) {
    out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })
  }
  if (payload?.usage !== undefined) {
    const usage = payload.usage
    out.push({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        ...(usage.prompt_tokens_details !== undefined ? { prompt_tokens_details: usage.prompt_tokens_details } : {}),
      },
    })
  }
  return out
}

/** 转发一条 chat 请求（非流式聚合 / 流式 SSE 翻译）。 */
async function handleChat(request, response, credential, body) {
  const model = typeof body.model === 'string' ? body.model : 'plan_pro'
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user')
  const lastText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.filter((p) => p?.type === 'text').map((p) => p.text).join('')
      : ''
  const handshakeInfo = await handshake(credential, model, lastText)
  const agentBody = normalizeAgentBody({ ...body, model, stream: body.stream !== false })
  const upstream = await fetch(`${BASE}/api/public/v1/agent-runtime/chat/completions`, {
    method: 'POST',
    headers: baseHeaders(credential, {
      'content-type': 'application/json',
      accept: body.stream === false ? 'application/json' : 'text/event-stream',
      ...handshakeInfo.headers,
    }),
    body: JSON.stringify(agentBody),
    signal: request.signal ?? AbortSignal.timeout(300_000),
  })
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    openAiError(response, upstream.status === 401 ? 401 : 502, 'lingxi_upstream', text.slice(0, 300))
    return
  }

  if (body.stream === false) {
    const text = await upstream.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = {} }
    const choice = payload?.choices?.[0]
    const message = {
      role: 'assistant',
      content: choice?.text ?? '',
      ...(typeof choice?.reasoning_content === 'string' ? { reasoning_content: choice.reasoning_content } : {}),
    }
    json(response, 200, {
      id: `chatcmpl-lingxi-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model, choices: [{ index: 0, message, finish_reason: choice?.finish_reason ?? 'stop' }],
      usage: payload?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
    return
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const state = { tools: new Map() }
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const write = (obj) => response.write(`data: ${JSON.stringify(obj)}\n\n`)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const line = frame.split(/\r?\n/).find((part) => part.startsWith('data:'))
        if (line === undefined) continue
        const text = line.slice(5).trim()
        if (text === '[DONE]') continue
        let payload
        try { payload = JSON.parse(text) } catch { continue }
        const diagnostic = [payload?.code, payload?.message, payload?.errmsg, payload?.error, payload?.detail, payload?.reason]
          .filter((x) => typeof x === 'string').join(' ')
        if (/audit|敏感|违规|sensitive/i.test(diagnostic)) {
          write({ error: { message: `灵犀审核拦截：${diagnostic.slice(0, 160)}`, type: 'invalid_request_error', code: 'audit_blocked' } })
          continue
        }
        for (const chunk of translateFrame(payload, state)) write(chunk)
      }
    }
  } catch (error) {
    write({ error: { message: `灵犀流中断：${error instanceof Error ? error.message : String(error)}`, type: 'api_error', code: 'stream' } })
  } finally {
    write({ choices: [], usage: {} })
    response.write('data: [DONE]\n\n')
    response.end()
  }
}

/**
 * 启动本地灵犀转发端点。
 * @returns {Promise<{url:string, token:string, close:()=>Promise<void>}>}
 */
export async function startLingxiShim(options) {
  const token = randomBytes(24).toString('base64url')
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/v1/chat/completions') {
      json(response, 404, { error: 'not found' })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    const auth = request.headers.authorization ?? ''
    if (!secretsEqual(auth.replace(/^Bearer\s+/i, ''), token)) {
      openAiError(response, 401, 'invalid_token', 'invalid shim token')
      return
    }
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw new Error('request too large')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const credential = await options.credential()
      if (credential === undefined) throw new AdapterError('灵犀还没有登录', { permanent: true })
      await handleChat(request, response, credential, body)
      options.onChat?.()
    } catch (error) {
      if (response.headersSent === false) {
        const status = error instanceof AdapterError ? (error.status === 401 ? 401 : 502) : 400
        openAiError(response, status, 'lingxi_error', error instanceof Error ? error.message : String(error))
      }
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  // 踩过的坑：以前把 Promise 的 resolve 直接当 listen 回调，resolve() 不带参数，
  // port 恒为 undefined，shim.url 变成 http://127.0.0.1:undefined —— 灵犀整条链路
  // 因此一直连不上。端口必须从 server.address() 取。
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
