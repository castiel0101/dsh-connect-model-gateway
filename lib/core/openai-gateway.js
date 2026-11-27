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
    sendError(response, error.status, error.type, error.param, error.code, error.message)
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
 * @param {(request: import('node:http').IncomingMessage) => Promise<void>|void} [options.authenticate] 鉴权钩子（TK-0003）
 * @param {(request: import('node:http').IncomingMessage) => Promise<void>|void} [options.rateLimiter] 限流钩子（TK-0003）
 * @param {(call: object) => Promise<void>|void} [options.chatHandler] chat/completions 实现（TK-0002）
 * @param {() => Array<string|{id: string, owned_by?: string, created?: number}>} [options.modelsProvider] 模型目录
 * @returns {{start: () => Promise<{host: string, port: number, url: string}>, stop: () => Promise<void>, address: () => {host: string, port: number, url: string}|undefined, server: import('node:http').Server, protocol: object}}
 */
export function createGateway(options = {}) {
  const {
    ctx,
    config = {},
    warn = () => {},
    authenticate,
    rateLimiter,
    chatHandler,
    modelsProvider,
    providers,
  } = options

  const bindHost = typeof config.host === 'string' && config.host !== '' ? config.host : DEFAULT_HOST
  const bindPort = Number.isInteger(config.port) && config.port >= 0 ? config.port : 0
  const aliases = config.aliases ?? {}

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
   * 默认实现返回 501：协议翻译（`toGenerateOptions`）已经跑通并在这里被调用，
   * **只差把 `streamOptionsOf(options)` 交给 `ctx.llm.stream` 再翻译回来** ——
   * 那是 TK-0002 的活。注入 `chatHandler` 即可整体替换。
   */
  async function handleChat(request, response) {
    const raw = await readBody(request)
    const body = parseJsonBody(raw)
    // 带白名单：`mg:nope:gpt-4o` 这类「格式合法但平台没接入」必须在这里 400，
    // 否则会一路传到 ctx.llm.stream 炸成 500（客户端以为是网关故障，不会改参数）。
    const parsed = parseModel(body.model, aliases, knownProviders())
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

    // ---- TK-0002 填这里：ctx.llm.stream(llmOptions) → SSE / 非流式 JSON ----
    // 默认实现只回 501。响应体必须是合法错误信封，解析结果因此只放进响应头。
    sendError(
      response,
      501,
      'server_error',
      null,
      'not_implemented',
      'chat/completions 尚未实现（TK-0002）',
      {
        'x-mgw-provider': encodeURIComponent(parsed.provider),
        'x-mgw-model': encodeURIComponent(parsed.actualModel),
      },
    )
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

    if (typeof authenticate === 'function') await authenticate(request)
    if (typeof rateLimiter === 'function') await rateLimiter(request)

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
  }
}

/** IPv6 地址要加方括号才能拼 URL。 */
function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}
