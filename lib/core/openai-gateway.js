/**
 * 魔桥 OpenAI 网关 · HTTP server 骨架。
 *
 * 本文件只做「通道 + 路由 + 错误信封」三件事，协议翻译全在
 * `openai-protocol.js`（纯函数），推理在 `ctx.llm.stream`。
 *
 * 为什么独立 server 而不是挂 DSH 的 webServer：见方案 §3 —— webServer 与 GUI
 * 共用单实例，暴露它等于暴露整个设置页；这里沿用 `core/shim.js` 的加固套路
 * （独立端口、默认只听回环、Host 校验、请求体上限）。
 *
 * ## 本单（TK-0001）范围
 *
 * - `POST /v1/chat/completions`、`/chat/completions` → **501 + 错误信封**
 *   （真实实现是 TK-0002，通过 `options.chatHandler` 注入，换掉默认实现即可）
 * - `GET /v1/models`、`/models`、`GET /v1/models/:model` → 200
 * - `GET /healthz`（含 `/v1/healthz`）→ `ctx.llm` 可用 200，否则 503
 * - 未知路径 → 404 错误信封
 * - 鉴权默认**透传**（TK-0003 通过 `options.authenticate` 注入）
 *
 * ## 注入点（后续工单不要改签名，只换实现）
 *
 * | 钩子 | 签名 | 谁用 |
 * |---|---|---|
 * | `options.authenticate` | `async (request) => void`（抛 ProtocolError 即拒绝） | TK-0003 鉴权 |
 * | `options.rateLimiter` | `async (request) => void`（同上） | TK-0003 限流 |
 * | `options.chatHandler` | `async (call) => void`（自己写 response；call 带 protocolModule） | TK-0002 流式/非流式 |
 * | `options.modelsProvider` | `() => Array<string\|{id, owned_by, created}>` | 目录/别名 |
 * | `options.providers` | `Iterable<string>` 或 `() => Iterable<string>` | 已接入平台白名单；缺省从模型目录 + 别名推导 |
 *
 * 鉴权/限流钩子在 `/healthz` 之后执行：探针不带 Key，401 会被判成服务不可用。
 * `providers` 缺省推导：模型 id 的 `mg:<provider>:…` 前缀 + 别名指向的 provider。
 * 显式传空集合表示「一个都没接入」，连 `mg:auto` 也会被拒 —— 调用方自己负责。
 *
 * **图片**：`toGenerateOptions` 的 `imageResolver` 需要异步落盘（`attachments.saveImages`），
 * 本单在 chat 路径上还没接附件服务，所以带 `image_url` 的请求会按设计显式 400
 * `image_not_supported`。TK-0002 在 handler 里用 `extractImageParts` + resolver 补上即可
 * （协议层已把两步拆好，纯函数部分不用改）。
 *
 * @module dsh-connect-model-gateway/core/openai-gateway
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

import { createKeyStore } from './gateway-keys.js'
import { loadHostPackage } from './host-peers.js'
import {
  ProtocolError,
  errorEnvelope,
  errorTypeForStatus,
  extractImageParts,
  finishReasonOf,
  modelObject,
  modelsList,
  parseImageUrl,
  parseModel,
  sanitizeErrorMessage,
  streamOptionsOf,
  toGenerateOptions,
} from './openai-protocol.js'

/** 单请求体上限：与 shim 一致，32MB 够放一个长会话 + 几张图。 */
const BODY_LIMIT = 32 * 1024 * 1024

/** 默认监听地址：只回环，要内网访问必须显式配 `config.host`。 */
const DEFAULT_HOST = '127.0.0.1'

/** 回环主机名白名单（Host 头校验用）。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 每把 Key 的默认并发上限（规格 §1.5：本机自用，4 足够，超了直接 429）。 */
const DEFAULT_CONCURRENCY = 4

/** 每把 Key 的默认每分钟请求上限。 */
const DEFAULT_PER_MINUTE = 120

/**
 * 协议层打包，随 hook 一起下发：后续 TK-0002/0003 在 handler 里直接取用，
 * 不必再 import 一次（也就不会因为模块实例不同而出现两份常量表）。
 */
const protocolModule = {
  ProtocolError,
  errorEnvelope,
  errorTypeForStatus,
  sanitizeErrorMessage,
  parseModel,
  parseImageUrl,
  extractImageParts,
  toGenerateOptions,
  streamOptionsOf,
  finishReasonOf,
  modelsList,
  modelObject,
}

/**
 * 写 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(response, status, payload, extraHeaders) {
  if (response.writableEnded) return
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(extraHeaders ?? {}),
  })
  response.end(text)
}

/**
 * 写 OpenAI 错误信封。
 *
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {string|null} type
 * @param {string|null} param
 * @param {string|null} code
 * @param {string} message
 * @param {Record<string, string>} [extraHeaders]
 */
function sendError(response, status, type, param, code, message, extraHeaders) {
  sendJson(response, status, errorEnvelope(status, type, param, code, message), extraHeaders)
}

/**
 * 任意异常 → 错误信封。`ProtocolError` 按自带状态码，其余统一 500 且**不带**
 * 原始 message（只在 warn 里留一行，绝不回显堆栈）。
 *
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} error
 * @param {(message: string) => void} warn
 */
function sendUnknownError(response, error, warn) {
  if (error instanceof ProtocolError) {
    const headers = Number.isFinite(error.retryAfter) ? { 'retry-after': String(error.retryAfter) } : undefined
    sendError(response, error.status, error.type, error.param, error.code, error.message, headers)
    return
  }
  warn(`网关内部错误：${error instanceof Error ? error.message : String(error)}`)
  sendError(response, 500, 'server_error', null, 'internal_error', '网关内部错误')
}

/**
 * 读请求体（上限 {@link BODY_LIMIT}）。
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Buffer>}
 * @throws {ProtocolError} 413 / 400
 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) {
      throw new ProtocolError(413, 'invalid_request_error', null, 'body_too_large', '请求体超过 32MB 上限')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 解析 JSON 请求体。
 *
 * @param {Buffer} buffer
 * @returns {object}
 * @throws {ProtocolError} 400
 */
function parseJsonBody(buffer) {
  const text = buffer.toString('utf8')
  if (text.trim() === '') throw new ProtocolError(400, 'invalid_request_error', null, 'invalid_json', '请求体为空')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ProtocolError(400, 'invalid_request_error', null, 'invalid_json', '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    // 不回显 JSON.parse 的原文（含请求体片段）
    throw new ProtocolError(400, 'invalid_request_error', null, 'invalid_json', '请求体不是合法 JSON')
  }
}

/**
 * 规范化路径：去掉尾部斜杠（根路径除外）。
 *
 * @param {string} pathname
 * @returns {string}
 */
function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '')
  return pathname
}

/** 去掉 `/v1` 前缀，得到逻辑路由（兼容规格 §1.5 的双挂）。 */
function logicalRoute(pathname) {
  const normalized = normalizePath(pathname)
  if (normalized === '/v1') return '/'
  if (normalized.startsWith('/v1/')) return normalized.slice('/v1'.length)
  return normalized
}

/**
 * Host 头校验：只放行回环名，挡 DNS rebinding。
 *
 * 配了非回环 `config.host` 时仍要求 Host 与配置的地址一致（或回环），
 * 否则一个内网暴露就会被任意域名打进来。
 *
 * @param {string|undefined} hostHeader
 * @param {string} bindHost
 * @returns {boolean}
 */
function hostAllowed(hostHeader, bindHost) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  const hostname = hostHeader.includes(']')
    // IPv6 字面量：[::1]:8080
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0]
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true
  if (LOOPBACK_HOSTNAMES.has(bindHost)) return false
  return hostname === bindHost
}

// ---------------------------------------------------- chat/completions 翻译
// TK-0002：把 ctx.llm.stream 的 StreamChunk 翻译成 OpenAI 的两种响应。
// 这里只做「逐片搬运 + 聚合」，协议字段的判定仍在 openai-protocol.js。

/** 背压高水位：累计待写超过 64KB 就先等 drain，慢客户端不能把网关内存吃穿。 */
const WRITE_HIGH_WATER = 64 * 1024

/** SSE 响应头：四项是硬要求（规格 §1.1）；另关 nginx 缓冲，否则帧会被攒成一坨。 */
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * 内置聚合器：宿主 `BlockAssembler` 的等价最小实现。
 *
 * 只在宿主包解析失败（单测、非 DSH 环境）时兜底；算法照抄
 * `@deepseek-ai/dsh-llm` 的 BlockAssembler（容忍 delta-only、max-tokens 丢 tool-call），
 * 所以两条路径产出的 blocks/usage/finish 语义一致。
 */
class LocalBlockAssembler {
  constructor() {
    /** @type {Map<number, object>} */
    this.partials = new Map()
    /** @type {number[]} */
    this.order = []
    this.tokenUsage = undefined
    this.finishReason = undefined
  }

  ensure(index, blockType) {
    let partial = this.partials.get(index)
    if (partial === undefined) {
      partial = { blockType, text: '', callId: undefined, callName: undefined, args: '', block: undefined }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  push(chunk) {
    switch (chunk?.type) {
      case 'block-start':
        this.ensure(chunk.index, chunk.blockType)
        return
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block !== undefined) return
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block !== undefined) return
        partial.callId = chunk.id
        if (chunk.name) partial.callName = chunk.name
        partial.args += chunk.argumentsDelta ?? ''
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block?.type ?? 'text')
        if (partial.block === undefined) partial.block = chunk.block
        return
      }
      case 'usage':
        this.tokenUsage = chunk.usage
        return
      case 'finish':
        this.finishReason = chunk.reason
        return
      default:
    }
  }

  assemble(index) {
    const partial = this.partials.get(index)
    if (partial?.block !== undefined) return partial.block
    switch (partial.blockType) {
      case 'text':
        return { type: 'text', text: partial.text }
      case 'reasoning':
        return { type: 'reasoning', text: partial.text }
      case 'tool-call':
        return {
          type: 'tool-call',
          id: partial.callId ?? `call-${index}`,
          name: partial.callName ?? '',
          arguments: partial.args,
        }
      default:
        throw new Error(`无法聚合未完成的 ${partial.blockType} 块`)
    }
  }

  /** 与宿主一致：max-tokens 截断时丢掉工具调用（执行不了）。 */
  blocks() {
    const all = this.order.map((index) => this.assemble(index))
    if (this.finish.kind !== 'max-tokens') return all
    return all.filter((block) => block.type !== 'tool-call')
  }

  get usage() {
    return this.tokenUsage
  }

  get finish() {
    return this.finishReason ?? { kind: 'stop' }
  }
}

/** 宿主 BlockAssembler 只解析一次（宿主包可能不在，失败就回落内置实现）。 */
let cachedBlockAssembler

/**
 * 取聚合器构造函数：优先宿主 `@deepseek-ai/dsh-llm` 的 BlockAssembler。
 *
 * @param {{blockAssembler?: Function}} [overrides] 显式注入（测试用）
 * @returns {Promise<Function>}
 */
async function resolveBlockAssembler(overrides = {}) {
  if (typeof overrides.blockAssembler === 'function') return overrides.blockAssembler
  if (cachedBlockAssembler !== undefined) return cachedBlockAssembler
  try {
    const llm = await loadHostPackage('@deepseek-ai/dsh-llm')
    cachedBlockAssembler = typeof llm.BlockAssembler === 'function' ? llm.BlockAssembler : LocalBlockAssembler
  } catch {
    cachedBlockAssembler = LocalBlockAssembler
  }
  return cachedBlockAssembler
}

/**
 * 拿异步迭代器；`ctx.llm.stream` 必须返回 AsyncIterable<StreamChunk>。
 *
 * @param {unknown} iterable
 */
function toIterator(iterable) {
  if (iterable !== null && typeof iterable === 'object' && typeof iterable[Symbol.asyncIterator] === 'function') {
    return iterable[Symbol.asyncIterator]()
  }
  throw new TypeError('ctx.llm.stream 必须返回 AsyncIterable<StreamChunk>')
}

/** 释放迭代器（断连/出错/提前退出都要调，否则上游连接泄漏）。 */
async function releaseIterator(iterator, warn) {
  if (iterator === null || iterator === undefined || typeof iterator.return !== 'function') return
  try {
    await iterator.return()
  } catch (error) {
    warn(`释放模型流失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** TokenUsage → OpenAI usage；prompt = input + cacheRead + cacheWrite（规格 §1.1）。 */
function usagePayload(usage) {
  const count = (value) => (Number.isFinite(value) ? value : 0)
  const prompt = count(usage?.inputTokens) + count(usage?.cacheReadTokens) + count(usage?.cacheWriteTokens)
  const completion = count(usage?.outputTokens)
  const total = Number.isFinite(usage?.totalTokens) ? usage.totalTokens : prompt + completion
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
}

/** 上游 failure → 502 信封（code 保留上游语义，便于排障；message 会被脱敏）。 */
function upstreamEnvelope(failure) {
  const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code.toLowerCase() : 'upstream_error'
  const message = typeof failure?.message === 'string' && failure.message !== '' ? failure.message : '上游模型调用失败'
  return errorEnvelope(502, 'api_error', null, code, message)
}

/**
 * SSE 写通道：负责背压、断连感知和统一帧格式。
 *
 * @param {import('node:http').ServerResponse} response
 */
function createSseChannel(response) {
  let closed = false
  let pendingBytes = 0

  response.on('close', () => {
    // 正常结束也会 close，用 writableEnded 区分
    if (!response.writableEnded) closed = true
  })

  /** 等 drain；没有待写数据时让出一轮事件循环，避免死等。 */
  function whenDrained() {
    return new Promise((resolve) => {
      if (response.writableEnded || closed) return resolve()
      if (response.writableNeedDrain !== true && response.writableLength === 0) {
        setImmediate(resolve)
        return
      }
      const done = () => {
        response.off('drain', done)
        response.off('close', done)
        resolve()
      }
      response.once('drain', done)
      response.once('close', done)
    })
  }

  async function write(text) {
    if (response.writableEnded || closed) return false
    pendingBytes += Buffer.byteLength(text)
    const accepted = response.write(text)
    if (!accepted || pendingBytes >= WRITE_HIGH_WATER) {
      await whenDrained()
      pendingBytes = 0
    }
    return !response.writableEnded && !closed
  }

  return {
    get closed() {
      return closed || response.writableEnded
    },
    write,
    /** 写一帧 `data: <json>\n\n`。 */
    frame(payload) {
      return write(`data: ${JSON.stringify(payload)}\n\n`)
    },
    end() {
      if (!response.writableEnded) response.end()
    },
  }
}

/**
 * 流式实现（`stream: true`）。
 *
 * 顺序固定：role 首帧 → 内容/工具帧 → finish 帧 → （include_usage 时）usage 帧 → `[DONE]`。
 * `aborted` 不发结束帧；已发 200 后出错只追加 error chunk + `[DONE]`，不改状态码。
 *
 * @param {object} call handleChat 组装的调用上下文
 */
async function streamChat(call) {
  const { response, body, parsed, llmOptions, protocol, ctx, warn } = call
  const model = typeof body.model === 'string' ? body.model : `${parsed.provider}:${parsed.actualModel}`
  const includeUsage = protocol?.mgw?.includeUsage === true || body.stream_options?.include_usage === true
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  /** 拼一帧 chunk：id/created/model 恒定，只有 choices/usage 变。 */
  const frameOf = (choices, usage) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices,
    ...(usage === undefined ? {} : { usage }),
  })

  let iterator
  let pending
  try {
    iterator = toIterator(ctx.llm.stream(llmOptions))
    // 先拉第一片：上游鉴权/限流/参数错通常在首片就炸，这时还没发 200，
    // 可以回标准错误信封（客户端能拿到 4xx/5xx，而不是一个空流）。
    pending = await iterator.next()
  } catch (error) {
    await releaseIterator(iterator, warn)
    sendUnknownError(response, error, warn)
    return
  }

  response.writeHead(200, {
    ...SSE_HEADERS,
    'x-mgw-provider': encodeURIComponent(parsed.provider),
    'x-mgw-model': encodeURIComponent(parsed.actualModel),
  })
  const sse = createSseChannel(response)

  // DSH 的 chunk.index 是块序号，OpenAI 的 tool_calls[].index 是「第几个工具调用」，
  // 两者不同域：这里做一次稳定映射（首次出现顺序），保证同一工具调用 index 不变。
  const toolIndexes = new Map()
  let usage
  let finishReason
  let failure

  await sse.frame(frameOf([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]))

  try {
    while (pending !== undefined && pending.done !== true && !sse.closed) {
      const chunk = pending.value
      switch (chunk?.type) {
        case 'text-delta':
          if (typeof chunk.text === 'string' && chunk.text !== '') {
            await sse.frame(frameOf([{ index: 0, delta: { content: chunk.text }, finish_reason: null }]))
          }
          break
        case 'reasoning-delta':
          // 独立字段：绝不塞进 content，否则客户端会把思考过程当正文
          if (typeof chunk.text === 'string' && chunk.text !== '') {
            await sse.frame(frameOf([{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }]))
          }
          break
        case 'tool-call-delta': {
          const first = !toolIndexes.has(chunk.index)
          if (first) toolIndexes.set(chunk.index, toolIndexes.size)
          const index = toolIndexes.get(chunk.index)
          const toolCall = first
            ? {
                index,
                id: chunk.id,
                type: 'function',
                function: { name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' },
              }
            : { index, function: { arguments: chunk.argumentsDelta ?? '' } }
          await sse.frame(frameOf([{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }]))
          break
        }
        case 'usage':
          // 审计用：挂在 response 上（不写进响应体，是否回给客户端仍由 include_usage 决定）
          usage = chunk.usage
          response.mgwUsage = chunk.usage
          break
        case 'finish': {
          const kind = chunk.reason?.kind
          if (kind === 'error') {
            failure = upstreamEnvelope(chunk.reason?.failure)
          } else {
            // aborted → finishReasonOf 返回 null，不发结束帧（只 [DONE]）
            finishReason = finishReasonOf(chunk.reason)
          }
          break
        }
        default:
          // block-start / block-end 在 OpenAI 协议里没有对应帧，忽略
      }
      pending = await iterator.next()
    }
  } catch (error) {
    failure = error
  } finally {
    await releaseIterator(iterator, warn)
  }

  if (failure !== undefined) {
    // 已发 200：只能追加一个 error chunk + [DONE]（规格 §1.1），不改状态码
    let envelope
    if (failure instanceof ProtocolError) {
      envelope = errorEnvelope(failure.status, failure.type, failure.param, failure.code, failure.message)
    } else if (failure !== null && typeof failure === 'object' && failure.error !== undefined) {
      envelope = failure // 上游 finish(kind:'error') 已转成信封
    } else {
      warn(`chat 流式失败：${failure instanceof Error ? failure.message : String(failure)}`)
      envelope = errorEnvelope(500, 'server_error', null, 'internal_error', '网关内部错误')
    }
    await sse.write(`data: ${JSON.stringify(envelope)}\n\n`)
    await sse.write('data: [DONE]\n\n')
    sse.end()
    return
  }

  if (finishReason !== null && finishReason !== undefined && !sse.closed) {
    await sse.frame(frameOf([{ index: 0, delta: {}, finish_reason: finishReason }]))
  }
  if (includeUsage && !sse.closed) {
    // OpenAI 约定：usage 帧在 [DONE] 之前，且 choices 为空数组
    await sse.frame(frameOf([], usagePayload(usage)))
  }
  if (!sse.closed) await sse.write('data: [DONE]\n\n')
  sse.end()
}

/**
 * 非流式实现（`stream: false` 或缺失）。
 *
 * @param {object} call
 * @param {{blockAssembler?: Function}} [overrides]
 */
async function bufferedChat(call, overrides = {}) {
  const { response, body, parsed, llmOptions, protocol, ctx, warn } = call
  const model = typeof body.model === 'string' ? body.model : `${parsed.provider}:${parsed.actualModel}`

  const Assembler = await resolveBlockAssembler(overrides)
  const assembler = new Assembler()

  let iterator
  try {
    iterator = toIterator(ctx.llm.stream(llmOptions))
    for (;;) {
      const { value, done } = await iterator.next()
      if (done === true) break
      assembler.push(value)
    }
  } catch (error) {
    sendUnknownError(response, error, warn)
    return
  } finally {
    await releaseIterator(iterator, warn)
  }

  const finishKind = assembler.finish?.kind
  // 审计用：不管成功/失败都留一份 usage（assembler 没收到 usage 时是 undefined）
  response.mgwUsage = assembler.usage
  if (finishKind === 'error') {
    sendJson(response, 502, upstreamEnvelope(assembler.finish.failure), {
      'x-mgw-provider': encodeURIComponent(parsed.provider),
      'x-mgw-model': encodeURIComponent(parsed.actualModel),
    })
    return
  }

  let blocks
  try {
    blocks = assembler.blocks()
  } catch (error) {
    sendUnknownError(response, error, warn)
    return
  }

  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
  const reasoning = blocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
  const toolCalls = blocks
    .filter((block) => block.type === 'tool-call')
    .map((block, index) => ({
      index,
      id: block.id,
      type: 'function',
      function: {
        name: block.name,
        // 空参数要合法 JSON：客户端会直接 JSON.parse
        arguments: typeof block.arguments === 'string' && block.arguments !== '' ? block.arguments : '{}',
      },
    }))

  const message = {
    role: 'assistant',
    content: text,
    ...(reasoning !== '' ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }

  sendJson(response, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonOf(assembler.finish) ?? 'stop',
        logprobs: null,
      },
    ],
    usage: usagePayload(assembler.usage),
  }, {
    'x-mgw-provider': encodeURIComponent(parsed.provider),
    'x-mgw-model': encodeURIComponent(parsed.actualModel),
  })
}

/**
 * 从 `Authorization: Bearer <token>` 取 token。
 *
 * 只认 Bearer（OpenAI 客户端都用它）；格式不合法返回 undefined，**不回显客户端给的值**。
 *
 * @param {string|string[]|undefined} header
 * @returns {string|undefined}
 */
function bearerTokenOf(header) {
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw !== 'string') return undefined
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(raw)
  return match === null ? undefined : match[1]
}

/** 401 鉴权失败（message 固定文案，绝不回显 Key 片段）。 */
function unauthorized() {
  return new ProtocolError(401, 'authentication_error', null, 'invalid_api_key', '缺少或无效的 API Key')
}

/**
 * 429 限流错误。`extra` 里带 `retryAfter`，由 dispatch 转成 `Retry-After` 头。
 *
 * @param {string} message
 * @param {number} retryAfter 秒
 */
function rateLimited(message, retryAfter) {
  const error = new ProtocolError(429, 'rate_limit_error', null, 'rate_limited', message)
  error.retryAfter = Math.max(1, Math.ceil(retryAfter))
  return error
}

/**
 * 按 Key 维度的并发闸 + 每分钟计数（思路同 `core/shim.js:81` 的 createConcurrencyGate，
 * 但**不复用**：那是进程级单实例，网关要的是「每把 Key 一个独立闸」）。
 *
 * 并发超限**不排队**：直接 429 + Retry-After，排队会让客户端等到超时，
 * 不如让它立刻退避重试（规格 §1.3 的 429 语义）。
 *
 * @param {object} options
 * @param {number} options.concurrency 每把 Key 的并发上限
 * @param {number} options.perMinute 每把 Key 的每分钟请求数上限
 * @param {() => number} [options.now] 现在（毫秒），测试可注入
 */
function createRateLimiter(options) {
  const concurrency = Math.max(1, Math.floor(options.concurrency))
  const perMinute = Math.max(1, Math.floor(options.perMinute))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const WINDOW_MS = 60_000

  /** @type {Map<string, {running: number, windowStart: number, count: number}>} */
  const buckets = new Map()

  /** 取（并按需重置）某个 key 的桶。 */
  function bucketOf(scope) {
    let bucket = buckets.get(scope)
    const timestamp = now()
    if (bucket === undefined) {
      bucket = { running: 0, windowStart: timestamp, count: 0 }
      buckets.set(scope, bucket)
    }
    if (timestamp - bucket.windowStart >= WINDOW_MS) {
      bucket.windowStart = timestamp
      bucket.count = 0
    }
    return bucket
  }

  return {
    /**
     * 占一个槽位；超限直接抛 429（不排队）。
     *
     * @param {import('node:http').IncomingMessage} request
     * @returns {{scope: string, release: () => void}} 必须在 finally 里 release
     */
    acquire(request) {
      // 鉴权失败时也走桶（scope 用 IP 兜底），否则未鉴权请求可以无限刷
      const scope = request?.mgwKey?.id !== undefined
        ? `key:${request.mgwKey.id}`
        : `anon:${request?.socket?.remoteAddress ?? 'unknown'}`
      const bucket = bucketOf(scope)
      if (bucket.running >= concurrency) {
        throw rateLimited(`该 Key 并发请求已达上限（${concurrency}），请稍后重试`, 1)
      }
      if (bucket.count >= perMinute) {
        const waitMs = WINDOW_MS - (now() - bucket.windowStart)
        throw rateLimited(`该 Key 每分钟请求数已达上限（${perMinute}），请稍后重试`, Math.ceil(waitMs / 1000))
      }
      bucket.running += 1
      bucket.count += 1
      let released = false
      return {
        scope,
        release() {
          if (released) return
          released = true
          bucket.running = Math.max(0, bucket.running - 1)
        },
      }
    },

    /** 当前各 scope 的快照（排障/测试用，不含任何 Key 信息）。 */
    snapshot() {
      return [...buckets.entries()].map(([scope, bucket]) => ({
        scope,
        running: bucket.running,
        count: bucket.count,
      }))
    },
  }
}

/**
 * 创建网关（**不启动**）。`start()` 才 listen。
 *
 * @param {object} options
 * @param {object} [options.ctx] DSH 上下文（只读 `ctx.llm`）
 * @param {object} [options.config] 插件配置里的 `openaiGateway` 段
 * @param {string} [options.config.host] 监听地址，默认 127.0.0.1
 * @param {number} [options.config.port] 监听端口，默认 0（随机）
 * @param {Record<string, unknown>} [options.config.aliases] 模型别名表
 * @param {string[]} [options.config.models] `/v1/models` 的静态条目（缺省只给 `mg:auto`）
 * @param {(message: string) => void} [options.warn]
 * @param {string} [options.keysPath] Key 存储路径，默认 `~/.dsh/model-pool/gateway.json`
 * @param {string} [options.auditPath] 审计 ndjson 路径，默认同级 `gateway-audit.ndjson`
 * @param {{concurrency?: number, perMinute?: number}} [options.limits] 每把 Key 的限流上限（默认 4 / 120）
 * @param {object} [options.keyStore] 直接注入 Key 门面（测试/宿主已有实例时用）；给了就忽略 keysPath/auditPath
 * @param {(request: import('node:http').IncomingMessage) => Promise<void>|void} [options.authenticate] 鉴权钩子（默认 Bearer + Key 校验）
 * @param {(request: import('node:http').IncomingMessage) => Promise<void>|void} [options.rateLimiter] 限流钩子（默认按 Key 的并发 + 每分钟计数）
 * @param {(call: object) => Promise<void>|void} [options.chatHandler] chat/completions 实现（TK-0002）
 * @param {() => Array<string|{id: string, owned_by?: string, created?: number}>} [options.modelsProvider] 模型目录
 * @returns {{start: () => Promise<{host: string, port: number, url: string}>, stop: () => Promise<void>, address: () => {host: string, port: number, url: string}|undefined, server: import('node:http').Server, protocol: object, keys: object}}
 */
export function createGateway(options = {}) {
  const {
    ctx,
    config = {},
    warn = () => {},
    keysPath,
    auditPath,
    limits,
    keyStore,
    authenticate,
    rateLimiter,
    chatHandler,
    blockAssembler,
    modelsProvider,
    providers,
  } = options

  const bindHost = typeof config.host === 'string' && config.host !== '' ? config.host : DEFAULT_HOST
  const bindPort = Number.isInteger(config.port) && config.port >= 0 ? config.port : 0
  const aliases = config.aliases ?? {}

  /** Key 存储门面：构造期不碰盘，第一次鉴权/建 Key 才读文件。 */
  const keys = keyStore ?? createKeyStore({ keysPath, auditPath, warn })

  /** 限流参数：`options.limits` > `config.limits` > 默认 4 并发 / 120 每分钟。 */
  const limitConfig = limits ?? (config.limits !== null && typeof config.limits === 'object' ? config.limits : {})
  const limiter = createRateLimiter({
    concurrency: Number(limitConfig?.concurrency) > 0 ? Number(limitConfig.concurrency) : DEFAULT_CONCURRENCY,
    perMinute: Number(limitConfig?.perMinute) > 0 ? Number(limitConfig.perMinute) : DEFAULT_PER_MINUTE,
  })

  /** 默认鉴权：Bearer token + 恒时校验；成功把 Key 记录挂到 request.mgwKey（审计用）。 */
  async function defaultAuthenticate(request) {
    const token = bearerTokenOf(request.headers.authorization ?? request.headers['x-api-key'])
    if (token === undefined) throw unauthorized()
    let record
    try {
      record = await keys.verifyKey(token)
    } catch (error) {
      // 存储坏了不能把 500 暴露成「Key 无效」，也不能回显错误细节
      warn(`网关 Key 校验失败：${error instanceof Error ? error.message : String(error)}`)
      throw new ProtocolError(503, 'server_error', null, 'key_store_unavailable', '网关暂时无法校验 API Key')
    }
    if (record === undefined) throw unauthorized()
    // 挂上去给审计用：只有 id/name/suffix，不含 hash
    request.mgwKey = record
  }

  /**
   * 默认限流：占槽位，把 release 挂到 request 上。
   *
   * 释放点在 `dispatch` 的 finally：并发闸要覆盖「读体 → 调上游 → 写完响应」整段，
   * 只在鉴权那一瞬占着等于没限流。
   */
  async function defaultRateLimiter(request) {
    const slot = limiter.acquire(request)
    request.mgwRelease = slot.release
  }

  /** 网关启动时间：`/v1/models` 的 `created` 兜底值（规格 §1.2 要求不能省略）。 */
  const startedAt = Math.floor(Date.now() / 1000)

  /**
   * 当前已接入的 provider 集合。
   *
   * 显式 `options.providers` 优先（函数则每次调用现取，平台开关运行期可变）；
   * 否则从 `/v1/models` 的条目（`mg:<provider>:<model>` 前缀）和别名目标推导。
   * 推导不出任何东西时不传白名单给 parseModel（保持旧行为，纯函数可测性）。
   *
   * @returns {Set<string>|undefined}
   */
  function knownProviders() {
    if (providers !== undefined && providers !== null) {
      const value = typeof providers === 'function' ? providers() : providers
      return value === undefined || value === null ? undefined : new Set(value)
    }
    const found = new Set()
    for (const entry of currentModelEntries()) {
      const id = typeof entry === 'string' ? entry : entry?.id
      if (typeof id !== 'string') continue
      const match = /^mg:([^:]+):/.exec(id)
      if (match !== null && match[1] !== '') found.add(match[1])
    }
    if (aliases instanceof Map) {
      for (const value of aliases.values()) addAliasProvider(value, found)
    } else if (aliases !== null && typeof aliases === 'object') {
      for (const value of Object.values(aliases)) addAliasProvider(value, found)
    }
    return found.size > 0 ? found : undefined
  }

  /** 别名值可能是 `mg:<provider>:<model>` 字符串或 `{provider, model}` 对象。 */
  function addAliasProvider(value, found) {
    if (typeof value === 'string') {
      const match = /^mg:([^:]+):/.exec(value.trim())
      if (match !== null && match[1] !== '') found.add(match[1])
      return
    }
    if (value !== null && typeof value === 'object' && typeof value.provider === 'string' && value.provider !== '') {
      found.add(value.provider)
    }
  }

  /** 当前地址；未启动时 undefined。 */
  let address

  /** `ctx.llm` 是否可用（healthz 就绪判据）。 */
  function llmReady() {
    return ctx?.llm !== undefined && ctx.llm !== null
  }

  /** 当前模型目录条目。 */
  function currentModelEntries() {
    if (typeof modelsProvider === 'function') {
      const entries = modelsProvider()
      if (Array.isArray(entries)) return entries
    }
    if (Array.isArray(config.models) && config.models.length > 0) return config.models
    return ['mg:auto']
  }

  /**
   * GET /models 与 /models/:model。
   *
   * `rest` 是 `/models/` 之后的**整段**（不再按 `/` 切）：模型 id 本身就常带
   * 斜杠（`meta/llama-3`、`org/model:v2`），切开会把合法 id 判成 404。
   *
   * @param {import('node:http').ServerResponse} response
   * @param {string|undefined} rest 未解码的模型 id；undefined 表示列表请求
   */
  function handleModels(response, rest) {
    const entries = currentModelEntries()
    if (rest === undefined) {
      // startedAt 必须是真实的网关启动时间：规格 §1.2 要求 created 不能省略
      sendJson(response, 200, modelsList(entries, { created: startedAt }))
      return
    }
    let wanted
    try {
      wanted = decodeURIComponent(rest)
    } catch {
      sendError(response, 400, 'invalid_request_error', 'model', 'invalid_model_path', '模型名无法解码')
      return
    }
    const match = entries.find((entry) => (typeof entry === 'string' ? entry : entry?.id) === wanted)
    if (match === undefined) {
      sendError(response, 404, 'not_found_error', 'model', 'model_not_found', `未知模型：${wanted}`)
      return
    }
    sendJson(response, 200, modelObject(match, { created: startedAt }))
  }

  /** GET /healthz。 */
  function handleHealthz(response) {
    if (llmReady()) {
      sendJson(response, 200, { status: 'ok' })
      return
    }
    sendJson(response, 503, { status: 'unavailable' })
  }

  /**
   * POST /chat/completions。
   *
   * chat 处理完（成功/失败）写一条审计；审计失败只 warn，绝不影响主流程。
   * 字段只取 usage 与解析后的 model/account，不碰 body.messages。
   */
  async function handleChat(request, response) {
    let auditBody
    let auditParsed
    /** 抛错时状态码还没写进 response，先记下来给审计用。 */
    let thrownStatus
    try {
      const raw = await readBody(request)
      const body = parseJsonBody(raw)
    // 带白名单：`mg:nope:gpt-4o` 这类「格式合法但平台没接入」必须在这里 400，
    // 否则会一路传到 ctx.llm.stream 炸成 500（客户端以为是网关故障，不会改参数）。
      const parsed = parseModel(body.model, aliases, knownProviders())
      auditBody = body
      auditParsed = parsed
      // 解析在这里就做（而不是留给 TK-0002）：model 非法要立刻 400，
      // 且这一步能顺手把「协议层翻译是否成功」暴露给单测。
      const protocol = toGenerateOptions(body, parsed)
      const llmOptions = streamOptionsOf(protocol)

      if (typeof chatHandler === 'function') {
        await chatHandler({
          request,
          response,
          body,
          parsed,
          llmOptions,
          protocol,
          protocolModule,
          config,
          ctx,
          warn,
        })
        return
      }

      // 默认实现（TK-0002）：stream 走 SSE，否则一次性组装成 chat.completion。
      if (ctx?.llm === undefined || ctx.llm === null || typeof ctx.llm.stream !== 'function') {
        sendError(response, 503, 'server_error', null, 'llm_unavailable', '模型服务不可用', {
          'x-mgw-provider': encodeURIComponent(parsed.provider),
          'x-mgw-model': encodeURIComponent(parsed.actualModel),
        })
        return
      }

      const call = {
        request,
        response,
        body,
        parsed,
        llmOptions,
        protocol,
        protocolModule,
        config,
        ctx,
        warn,
      }
      if (body.stream === true) await streamChat(call)
      else await bufferedChat(call, { blockAssembler })
    } catch (error) {
      // 交给 server 层写信封；这里只把状态码捞出来，好让审计记到真实结果
      thrownStatus = error instanceof ProtocolError ? error.status : 500
      throw error
    } finally {
      await writeAudit(request, response, auditBody, auditParsed, thrownStatus)
    }
  }

  /**
   * chat 结束写一条审计。**任何失败都被吞掉**：审计是旁路，不能影响主流程。
   *
   * usage 从 `response.mgwUsage` 取（streamChat / bufferedChat 收到 usage chunk 时挂上）；
   * status 取 HTTP 状态码；account 取解析出的 provider 名（不含账号凭据）。
   * 字段白名单由 `gateway-keys.js` 的 appendAudit 把守（多传的字段会被丢弃）。
   */
  async function writeAudit(request, response, body, parsed, thrownStatus) {
    try {
      const usage = response.mgwUsage
      const count = (value) => (Number.isFinite(value) ? value : 0)
      const promptTokens = count(usage?.inputTokens)
        + count(usage?.cacheReadTokens)
        + count(usage?.cacheWriteTokens)
      await keys.appendAudit({
        at: new Date().toISOString(),
        keyId: request?.mgwKey?.id ?? '',
        keySuffix: request?.mgwKey?.suffix ?? '',
        model: typeof body?.model === 'string' ? body.model : parsed?.actualModel ?? '',
        account: typeof parsed?.provider === 'string' ? parsed.provider : '',
        promptTokens,
        completionTokens: count(usage?.outputTokens),
        // 已发头就用真实状态码；抛错时头还没发，用 thrownStatus 兜住
        status: response.headersSent ? response.statusCode : (thrownStatus ?? response.statusCode ?? 500),
      })
    } catch (error) {
      warn(`审计写入失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 统一分发。 */
  async function dispatch(request, response) {
    const url = request.url ?? '/'
    let pathname
    try {
      pathname = new URL(url, 'http://gateway.invalid').pathname
    } catch {
      sendError(response, 400, 'invalid_request_error', null, 'invalid_url', '请求路径无法解析')
      return
    }

    if (!hostAllowed(request.headers.host, bindHost)) {
      sendError(response, 403, 'permission_error', null, 'forbidden_host', 'Host 头不被允许')
      return
    }

    const route = logicalRoute(pathname)
    const method = request.method ?? 'GET'

    // 就绪探针在鉴权之前：LiteLLM / Docker / K8s 的探针不带 Key，
    // 让它 401 会被判成「服务不可用」。探针只回 ok/unavailable，不泄漏任何配置。
    if (route === '/healthz' || route === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(response, 405, 'invalid_request_error', null, 'method_not_allowed', '只支持 GET')
        return
      }
      handleHealthz(response)
      return
    }

    // 鉴权/限流：默认实现就是本单（TK-0003）的真实实现，显式传钩子则整体替换。
    // 顺序固定「先认证后限流」：限流按 key.id 分桶，没认证就拿不到分桶依据。
    // 鉴权/限流失败时槽位根本没拿到，不需要释放（异常交给 server 的 catch 转信封）。
    if (typeof authenticate === 'function') await authenticate(request)
    else await defaultAuthenticate(request)
    if (typeof rateLimiter === 'function') await rateLimiter(request)
    else await defaultRateLimiter(request)

    try {
      await routeRequest(request, response, route, method)
    } finally {
      // 并发闸必须在这一层释放：覆盖「读体 → 调上游 → 写完响应」整段
      request.mgwRelease?.()
    }
  }

  /** 鉴权/限流之后的路由分派；槽位释放由 dispatch 的 finally 负责。 */
  async function routeRequest(request, response, route, method) {
    if (route === '/models' || route.startsWith('/models/')) {
      if (method !== 'GET') {
        sendError(response, 405, 'invalid_request_error', null, 'method_not_allowed', '只支持 GET')
        return
      }
      const rest = route === '/models' ? undefined : route.slice('/models/'.length)
      handleModels(response, rest === '' ? undefined : rest)
      return
    }

    if (route === '/chat/completions') {
      if (method !== 'POST') {
        sendError(response, 405, 'invalid_request_error', null, 'method_not_allowed', '只支持 POST')
        return
      }
      await handleChat(request, response)
      return
    }

    sendError(response, 404, 'not_found_error', null, 'not_found', '未知路径')
  }

  const server = createServer((request, response) => {
    dispatch(request, response).catch((error) => {
      // 头已发出（流式已开始）时不能再改状态码，只能记日志
      if (response.headersSent) {
        warn(`网关响应中途失败：${error instanceof Error ? error.message : String(error)}`)
        if (!response.writableEnded) response.end()
        return
      }
      sendUnknownError(response, error, warn)
    })
  })

  return {
    /** 起监听；重复调用返回同一个地址。 */
    async start() {
      if (address !== undefined) return address
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(bindPort, bindHost)
      })
      const info = server.address()
      const port = typeof info === 'object' && info !== null ? info.port : bindPort
      const host = typeof info === 'object' && info !== null && typeof info.address === 'string'
        ? info.address
        : bindHost
      address = { host, port, url: `http://${formatHost(host)}:${port}` }
      return address
    },

    /** 关监听；未启动时是 no-op。 */
    async stop() {
      if (address === undefined) return
      address = undefined
      // 先断 keep-alive，再 close：顺序反了会让 close 的回调一直等不到。
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },

    /** 当前地址（未启动 undefined）。 */
    address() {
      return address
    },

    /** 暴露底层 server，方便测试里 `server.address().port`。 */
    server,

    /** 暴露协议层，方便装配方（lib/index.js）不再单独 import。 */
    protocol: {
      ...protocolModule,
      /** 当前 provider 白名单（undefined 表示未启用校验）。 */
      knownProviders,
    },

    /** 暴露 Key 门面（createKey/listKeys/setEnabled/appendAudit），装配方下发 Key 用。 */
    keys,

    /** 限流快照（排障用，不含任何 Key 信息）。 */
    limits: () => limiter.snapshot(),
  }
}

/** IPv6 地址要加方括号才能拼 URL。 */
function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}
