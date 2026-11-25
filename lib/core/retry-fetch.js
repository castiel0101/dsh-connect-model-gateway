/**
 * 推理层重试友好 fetch（从 dsh-scnet-connect@1.3.2 逐字移植核心算法）。
 *
 * 三类上游抖动原本会被 DSH 判成「不可重试」，一次退避都不做就整轮失败：
 *  1. 5xx 却自称 `invalid_request_error`（路由切换 503+10008/10009）；
 *  2. 400 + 10013（参数错误码偶尔包装瞬时抖动）——同一请求体只自愈一次；
 *  3. SSE 流中途插 error 帧掐断（"The response stream was interrupted"）。
 * 另外在调用 pi-ai 之前净化 system.sections 里的 undefined —— pi-ai 的
 * `getSystemMessageText` 只把 null 当删除，undefined 会被 push 后 `.length` 崩。
 *
 * 刻意不碰：真 400（如 10006）、401/403/402/429、普通 2xx、正常 SSE 字节。
 *
 * @module dsh-connect-model-gateway/core/retry-fetch
 */

const RETRYABLE_UPSTREAM_CODES = new Set(['10008', '10009'])
const RETRY_ONCE_INVALID_PARAM_CODE = '10013'
const INVALID_PARAM_RETRY_WINDOW_MS = 10 * 60_000
const INVALID_PARAM_MEMORY_LIMIT = 128
const INTERRUPTED_RE = /response stream was interrupted|response stream (?:has )?been interrupted/i

function signatureOf(url, bodyText) {
  let hash = 2166136261
  const input = `${url}\n${bodyText}`
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function shouldNormalize(status, body) {
  if (status < 500) return false
  const error = body?.error
  return error?.type === 'invalid_request_error' && RETRYABLE_UPSTREAM_CODES.has(String(error?.code ?? ''))
}

function normalizeApiError(body, response) {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.delete('transfer-encoding')
  return new Response(
    JSON.stringify({ ...body, error: { ...body.error, type: 'api_error' } }),
    { status: response.status, statusText: response.statusText, headers },
  )
}

/** 400+10013 一次性自愈：status 400→500、type→api_error、message 去掉 "invalid request"/"400"，保留 request_id。 */
function normalizeRetryOnceInvalidParam(body, response) {
  const error = body?.error ?? {}
  const message = typeof error.message === 'string'
    ? error.message.replace(/\b400\b/gi, '').replace(/invalid\s+request/gi, '').trim()
    : ''
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.delete('transfer-encoding')
  return new Response(
    JSON.stringify({
      ...body,
      error: {
        ...error,
        type: 'api_error',
        code: error.code ?? RETRY_ONCE_INVALID_PARAM_CODE,
        message: message === ''
          ? 'Transient parameter rejection; retrying once.'
          : `${message} (transient; retrying once)`,
      },
    }),
    { status: 500, statusText: response.statusText, headers },
  )
}

/** SSE 帧边界：按 \n\n / \r\n\r\n 切，保留 separator。 */
function nextBoundary(buffer) {
  let index = buffer.indexOf('\n\n')
  let size = 2
  const crlf = buffer.indexOf('\r\n\r\n')
  if (crlf !== -1 && (index === -1 || crlf < index)) {
    index = crlf
    size = 4
  }
  return index === -1 ? null : { index, size }
}

function rewriteFrame(frame, state) {
  const line = frame.split(/\r?\n/).find((part) => part.startsWith('data:'))
  if (line === undefined || state.sawTerminal || !state.sawContent) return frame
  let payload
  try {
    payload = JSON.parse(line.slice(5).trim())
  } catch {
    return frame
  }
  if (payload?.error?.message === undefined || !INTERRUPTED_RE.test(payload.error.message)) return frame
  const original = payload.error.message
  payload.error = {
    ...payload.error,
    message: `SCNet stream ended before completion (upstream gateway interrupted the response). ${original}`,
  }
  return frame.replace(line, `data: ${JSON.stringify(payload)}`)
}

/** 包住 SSE 响应体：只在"已吐内容且未见终止帧"时改写中断帧。 */
function withInterruptionAwareBody(response) {
  const state = { sawContent: false, sawTerminal: false }
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body.getReader()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          for (;;) {
            const boundary = nextBoundary(buffer)
            if (boundary === null) break
            const frame = buffer.slice(0, boundary.index)
            // 观察正文/终止帧（只看 data 行）
            const dataLine = frame.split(/\r?\n/).find((part) => part.startsWith('data:'))
            if (dataLine !== undefined) {
              const text = dataLine.slice(5).trim()
              if (text === '[DONE]') state.sawTerminal = true
              else {
                try {
                  const payload = JSON.parse(text)
                  const choice = payload?.choices?.[0]
                  if (choice?.finish_reason) state.sawTerminal = true
                  if (choice?.delta?.content || choice?.text || choice?.delta?.reasoning_content ||
                      (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0)) {
                    state.sawContent = true
                  }
                } catch {
                  // 非 JSON data 行，忽略
                }
              }
            }
            controller.enqueue(encoder.encode(rewriteFrame(frame, state) + buffer.slice(boundary.index, boundary.index + boundary.size)))
            buffer = buffer.slice(boundary.index + boundary.size)
          }
          // 防 OOM：超过 1MB 还没有帧边界就整块吐出
          if (buffer.length > 1_048_576) {
            controller.enqueue(encoder.encode(buffer))
            buffer = ''
          }
        }
        if (buffer !== '') controller.enqueue(encoder.encode(rewriteFrame(buffer, state)))
      } catch (error) {
        controller.error(error)
      } finally {
        controller.close()
      }
    },
  })
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.delete('transfer-encoding')
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}

/**
 * 净化 pi-ai context：去掉 system 消息 sections 里非字符串的值。
 * 纯函数；没有改动时返回同一引用（零开销）。
 */
export function sanitizePiContext(context) {
  if (context === null || typeof context !== 'object' || !Array.isArray(context.messages)) return context
  let changed = false
  const messages = context.messages.map((message) => {
    if (message === null || typeof message !== 'object' || message.role !== 'system') return message
    const sections = message.sections
    if (sections === null || typeof sections !== 'object') return message
    let keptAny = false
    const kept = {}
    for (const [key, value] of Object.entries(sections)) {
      if (typeof value === 'string') {
        kept[key] = value
        keptAny = true
      } else {
        changed = true
      }
    }
    if (!changed) return message
    const { sections: _dropped, ...rest } = message
    return keptAny ? { ...rest, sections: kept } : rest
  })
  return changed ? { ...context, messages } : context
}

/** 包住 openAICompletionsApi() 的 api 对象：注入重试友好 fetch + context 净化。 */
export function withRetryFriendlyApi(api, options = {}) {
  if (options.enabled === false) return api
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const healed = new Map()
  const wrappedFetch = async (input, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '')
    const signature = signatureOf(url, bodyText)
    const response = await fetchImpl(input, init)
    if (response.ok) {
      const contentType = response.headers.get('content-type') ?? ''
      return contentType.includes('text/event-stream') ? withInterruptionAwareBody(response) : response
    }
    let body
    try {
      body = JSON.parse(await response.clone().text())
    } catch {
      return response
    }
    const isInvalidParam = response.status === 400 && String(body?.error?.code ?? '') === RETRY_ONCE_INVALID_PARAM_CODE
    if (isInvalidParam) {
      const now = Date.now()
      for (const [key, at] of healed) if (now - at > INVALID_PARAM_RETRY_WINDOW_MS) healed.delete(key)
      if (!healed.has(signature)) {
        healed.set(signature, now)
        while (healed.size > INVALID_PARAM_MEMORY_LIMIT) healed.delete(healed.keys().next().value)
        return normalizeRetryOnceInvalidParam(body, response)
      }
      return response
    }
    if (shouldNormalize(response.status, body)) return normalizeApiError(body, response)
    return response
  }
  return {
    ...api,
    stream: (model, context, options_) => api.stream(model, sanitizePiContext(context), { ...options_, fetch: wrappedFetch }),
    streamSimple: (model, context, options_) =>
      api.streamSimple(model, sanitizePiContext(context), { ...options_, fetch: wrappedFetch }),
    complete: api.complete
      ? (model, context, options_) => api.complete(model, sanitizePiContext(context), { ...options_, fetch: wrappedFetch })
      : undefined,
  }
}
