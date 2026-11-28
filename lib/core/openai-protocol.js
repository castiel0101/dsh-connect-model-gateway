/**
 * 魔桥 OpenAI 网关 · 协议层（纯函数，无 I/O、无 ctx）。
 *
 * 职责边界：只做「OpenAI 协议 ↔ DSH 类型」的翻译与校验，不碰 HTTP、不碰登录、
 * 不碰 ctx.llm。HTTP server 在 `openai-gateway.js`，本文件可单独 import 做单测。
 *
 * 真源：`魔桥OpenAI协议规格.md`（§1.1 请求字段 / §1.3 错误信封 / §1.4 模型名解析）。
 * DSH 类型：`@deepseek-ai/dsh-llm` 的 GenerateOptions / RequestMessage / ToolSchema /
 * TokenUsage / FinishReason。
 *
 * 三条硬约束（后续工单不要放松）：
 * 1. 模型名**只做精确匹配**：`mg-auto`、`mg-<provider>:<model>`、别名精确命中，
 *    其余一律 400 model_not_found。禁止模糊匹配、禁止静默回退到 auto —— 静默回退
 *    会让用户以为在用 A 其实在用 B，扣错积分。
 * 2. 错误 message **必须脱敏**：不回显 Key、不回显上游堆栈、不回显 messages 正文。
 * 3. 图片没有附件服务时**显式报错**，不静默吞图（方案 §5）。
 *
 * @module dsh-connect-model-gateway/core/openai-protocol
 */

/** 图片附件服务不可用时的错误码。 */
export const CODE_IMAGE_UNSUPPORTED = 'image_not_supported'

/** 网关默认 owned_by（规格 §1.2 示例值）。 */
const DEFAULT_OWNED_BY = 'model-gateway'

/** 别名递归展开上限，防循环别名把进程拖死。 */
const ALIAS_MAX_DEPTH = 8

/** 错误 message 的长度上限：够排障，不至于把上游整段响应倒给客户端。 */
const ERROR_MESSAGE_MAX_CHARS = 300

/** DSH 支持的图片媒体类型（dsh-attachment `ImageMediaType`）。 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * 带 HTTP 语义的协议错误。网关把它转成 OpenAI 错误信封。
 *
 * 不继承 AggregateError 之类，保持 `instanceof ProtocolError` 可判。
 */
export class ProtocolError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} type OpenAI `error.type`
   * @param {string|null} param 出错字段路径
   * @param {string|null} code OpenAI `error.code`
   * @param {string} message 已脱敏的说明
   */
  constructor(status, type, param, code, message) {
    super(message)
    this.name = 'ProtocolError'
    this.status = status
    this.type = type
    this.param = param
    this.code = code
  }

  /** 对应的 OpenAI 错误信封。 */
  toEnvelope() {
    return errorEnvelope(this.status, this.type, this.param, this.code, this.message)
  }
}

/** 便捷构造：400 invalid_request_error。 */
function badRequest(param, code, message) {
  return new ProtocolError(400, 'invalid_request_error', param, code, message)
}

/**
 * HTTP 状态码 → OpenAI `error.type`（规格 §1.3）。
 *
 * @param {number} status
 * @returns {string}
 */
export function errorTypeForStatus(status) {
  if (status === 400) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'invalid_request_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 502) return 'api_error'
  return 'server_error'
}

/**
 * 脱敏一条错误 message。
 *
 * 规则：丢堆栈帧、抹 Bearer / Key 片段、去掉控制字符、截断到
 * {@link ERROR_MESSAGE_MAX_CHARS}。**不做**「猜测哪段是正文」这种聪明事 ——
 * 调用方本来就不该把 messages 正文传进来（网关侧只在固定文案里说明字段名）。
 *
 * @param {unknown} message
 * @returns {string}
 */
export function sanitizeErrorMessage(message) {
  let text = typeof message === 'string' ? message : String(message ?? '')
  // 堆栈帧整行丢弃：上游 error.stack 常被顺手拼进 message
  text = text
    .split('\n')
    .filter((line) => !/^\s*at\s+\S+/.test(line) && !/^\s*Error:\s*$/.test(line))
    .join('\n')
  // Bearer / 各家 Key 前缀
  text = text.replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi, '$1***')
  text = text.replace(/\b(sk-|mgw_(?:live|test)_|ghp_|xoxb-)[A-Za-z0-9._-]{4,}/gi, '$1***')
  // key=value / key: value 形式
  text = text.replace(
    /\b((?:api[_-]?key|access[_-]?key|secret|token|authorization|password)\s*[:=]\s*)[^\s,;]{4,}/gi,
    '$1***',
  )
  // 控制字符（保留换行）
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  text = text.trim()
  if (text.length > ERROR_MESSAGE_MAX_CHARS) text = `${text.slice(0, ERROR_MESSAGE_MAX_CHARS - 1)}…`
  return text
}

/**
 * 截断/中断类错误的固定文案（含中文说明 + 宿主可识别的英文关键词）。
 *
 * **为什么必须夹带英文**：DSH 宿主 `classifyPiAiError` 只按 message 文本匹配
 * 归因，不看 `code` 字段（`/stream ended (?:before|without)\b/i` 或
 * `connection|network|socket|fetch|terminated|premature close` → `TRANSPORT`）。
 * 文案若只有中文，就会被归成 `PI_AI_ERROR` —— **不可重试**，`llm-retry`
 * 一次都不会跑，用户看到的还是「本轮运行失败」。这两句同时命中两条正则。
 *
 * @param {string} [detail] 上游原始错误（会被 sanitizeErrorMessage 脱敏）
 * @returns {string}
 */
export function truncationMessage(detail) {
  const base = '上游模型流在给出终止帧之前中断了，本轮响应不完整。'
    + ' The connection closed before the model finished sending the response;'
    + ' the stream ended before completion.'
  if (typeof detail !== 'string' || detail.trim() === '') return base
  // 这里自己脱敏：shim 路径（workbuddy / CodeArts / 灵犀）直接把结果塞进
  // 响应体，不经过 errorEnvelope，不能指望下游再清洗一次。
  const clean = sanitizeErrorMessage(detail)
  return clean === '' ? base : `${base} (${clean})`
}

/**
 * 构造 OpenAI 错误信封（规格 §1.3）。
 *
 * `param` / `code` 按 OpenAI 惯例可为 null；`type` 传 null/undefined 时按 status 推导。
 *
 * @param {number} status
 * @param {string|null|undefined} type
 * @param {string|null|undefined} param
 * @param {string|null|undefined} code
 * @param {string} message
 * @returns {{error: {message: string, type: string, param: string|null, code: string|null}}}
 */
export function errorEnvelope(status, type, param, code, message) {
  const httpStatus = Number.isFinite(Number(status)) ? Number(status) : 500
  return {
    error: {
      message: sanitizeErrorMessage(message),
      type: typeof type === 'string' && type !== '' ? type : errorTypeForStatus(httpStatus),
      param: typeof param === 'string' && param !== '' ? param : null,
      code: typeof code === 'string' && code !== '' ? code : null,
    },
  }
}

/**
 * 解析模型名（规格 §1.4，优先级固定）。
 *
 * 1. `mg-auto`（以及裸 `auto`）→ `{provider:'auto', actualModel:'auto'}`
 * 2. `mg-<provider>:<model>` → 拆开。分隔符故意的：`mg-` 后面跟平台，
 *    平台与模型之间用**冒号**，因为模型 id 本身常带冒号/斜杠
 *    （`org/model:v2`），用横线会是灾难。
 * 3. 别名精确匹配 → 展开后回到 1/2
 * 4. 其它 → 抛 400 `model_not_found`
 *
 * 历史：0.x 曾用 `mg:<provider>:<model>`，与 provider 和 model 分隔符混用同一个
 * 字符，读起来分不清层级；0.15 起统一为 `mg-<provider>:<model>`，**旧的 `mg:`
 * 前缀不再接受**（不保留兼容别名，避免两套 id 并存）。
 *
 * 名字合法 ≠ 平台可用：`mg-nope:gpt-4o` 格式对，但 nope 根本没接入，
 * 放行会在 `ctx.llm.stream` 里炸成 500。传 `knownProviders` 可在入口就拦成
 * 400 model_not_found；不传则保持旧行为（纯函数可测性，调用方自行校验）。
 *
 * @param {string} model 客户端传的 model
 * @param {Record<string, string|{provider: string, model: string}>|Map<string, string|{provider: string, model: string}>} [aliases]
 * @param {Iterable<string>|Set<string>|Array<string>} [knownProviders] 已接入的 provider 键；不传则不校验
 * @returns {{provider: string, actualModel: string}}
 * @throws {ProtocolError} 400 invalid_request_error / model_not_found
 */
export function parseModel(model, aliases, knownProviders) {
  if (typeof model !== 'string' || model.trim() === '') {
    throw badRequest('model', 'model_not_found', 'model 字段缺失或不是字符串')
  }
  const raw = model.trim()
  const check = (result) => {
    if (knownProviders !== undefined && knownProviders !== null) {
      const set = knownProviders instanceof Set ? knownProviders : new Set(knownProviders)
      if (!set.has(result.provider)) {
        // 不回显内部平台清单，避免目录枚举；只说这个 provider 未接入
        throw badRequest('model', 'model_not_found', `模型所属平台未接入：${result.provider}`)
      }
    }
    return result
  }

  const direct = parsePrefixed(raw)
  if (direct !== undefined) return check(direct)

  const alias = aliasLookup(aliases, raw)
  if (alias !== undefined) {
    return check(resolveAliasValue(raw, alias, aliases, 0, new Set()))
  }

  throw badRequest('model', 'model_not_found', `未知模型：${raw}`)
}

/**
 * 前缀形式解析；不是前缀形式返回 undefined（交给别名）。
 *
 * @param {string} raw
 * @returns {{provider: string, actualModel: string}|undefined}
 */
function parsePrefixed(raw) {
  if (raw === 'mg-auto' || raw === 'auto') return { provider: 'auto', actualModel: 'auto' }
  if (!raw.startsWith('mg-')) return undefined
  const rest = raw.slice('mg-'.length)
  const split = rest.indexOf(':')
  if (split <= 0) return undefined
  const provider = rest.slice(0, split).trim()
  const actualModel = rest.slice(split + 1).trim()
  if (provider === '' || actualModel === '') return undefined
  // 平台名里不能再出现 `-` 以外的分隔歧义不重要；但 `auto` 不是平台通道，
  // `mg-auto:xxx` 不合法（auto 只有它自己）。
  if (provider === 'auto') return undefined
  return { provider, actualModel }
}

/** 别名表支持普通对象与 Map，两者都按**精确** key 取。 */
function aliasLookup(aliases, key) {
  if (aliases instanceof Map) return aliases.has(key) ? aliases.get(key) : undefined
  if (aliases !== null && typeof aliases === 'object' && Object.hasOwn(aliases, key)) return aliases[key]
  return undefined
}

/**
 * 展开别名值：字符串递归解析，对象取 `{provider, model|actualModel}`。
 *
 * @param {string} aliasName 别名本身，只用于错误文案
 * @param {unknown} value
 * @param {unknown} aliases
 * @param {number} depth
 * @param {Set<string>} seen 防循环别名
 * @returns {{provider: string, actualModel: string}}
 */
function resolveAliasValue(aliasName, value, aliases, depth, seen) {
  if (depth > ALIAS_MAX_DEPTH || seen.has(aliasName)) {
    throw badRequest('model', 'model_not_found', `别名配置有环：${aliasName}`)
  }
  seen.add(aliasName)

  if (typeof value === 'string') {
    const raw = value.trim()
    const direct = parsePrefixed(raw)
    if (direct !== undefined) return direct
    const nested = aliasLookup(aliases, raw)
    if (nested !== undefined) return resolveAliasValue(raw, nested, aliases, depth + 1, seen)
    throw badRequest('model', 'model_not_found', `别名指向未知模型：${aliasName}`)
  }

  if (value !== null && typeof value === 'object') {
    const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
    const actualModel = typeof value.model === 'string'
      ? value.model.trim()
      : typeof value.actualModel === 'string' ? value.actualModel.trim() : ''
    if (provider !== '' && actualModel !== '') return { provider, actualModel }
  }

  throw badRequest('model', 'model_not_found', `别名配置无效：${aliasName}`)
}

/**
 * 解析 `image_url`：只接受 base64 的 `data:` 与 http(s)。
 *
 * 纯解析，不下载。真正的取字节 + `attachments.saveImages()` 由网关侧异步做
 * （见 {@link extractImageParts}），协议层只负责判断 URL 是否合法。
 *
 * @param {unknown} url
 * @returns {{kind: 'data', mediaType: string, base64: string, bytes: number}|{kind: 'url', url: string}}
 * @throws {ProtocolError} 400 image_not_supported
 */
export function parseImageUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw badRequest('messages', CODE_IMAGE_UNSUPPORTED, 'image_url 为空或不是字符串')
  }
  const text = url.trim()
  if (/^data:/i.test(text)) {
    const match = /^data:([^;,]+)?(;[^,]*)?,(.*)$/is.exec(text)
    if (match === null) {
      throw badRequest('messages', CODE_IMAGE_UNSUPPORTED, 'data URI 格式无法解析')
    }
    const mediaType = (match[1] ?? '').toLowerCase()
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
      throw badRequest('messages', CODE_IMAGE_UNSUPPORTED, `不支持的图片类型：${mediaType || '未声明'}`)
    }
    if (!/;base64/i.test(match[2] ?? '')) {
      throw badRequest('messages', CODE_IMAGE_UNSUPPORTED, '仅支持 base64 编码的 data URI')
    }
    const base64 = match[3] ?? ''
    if (base64 === '') throw badRequest('messages', CODE_IMAGE_UNSUPPORTED, 'data URI 没有图片数据')
    return { kind: 'data', mediaType, base64, bytes: Buffer.byteLength(base64, 'base64') }
  }
  if (/^https?:\/\//i.test(text)) return { kind: 'url', url: text }
  throw badRequest('messages', CODE_IMAGE_UNSUPPORTED, 'image_url 只支持 data: 或 http(s)')
}

/**
 * 取出请求里所有图片 part，供网关**先**异步落盘再同步组装 GenerateOptions。
 *
 * 为什么拆两步：DSH 的 image block 必须是已持久化的 `ImageAttachmentRef`
 * （`attachments.saveImages()` 是异步的），而 `toGenerateOptions` 要保持纯同步、
 * 可单测。网关侧流程：
 *
 *   const parts = extractImageParts(body)
 *   const refs = await Promise.all(parts.map(p => admit(p)))
 *   const resolver = (part) => refs.get(part.key)
 *   const options = toGenerateOptions(body, parsed, { imageResolver: resolver })
 *
 * @param {object} body OpenAI 请求体
 * @returns {Array<{key: string, messageIndex: number, partIndex: number, url: string, parsed: ReturnType<typeof parseImageUrl>}>}
 */
export function extractImageParts(body) {
  const parts = []
  const messages = body?.messages
  if (!Array.isArray(messages)) return parts
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message?.content)) return
    message.content.forEach((part, partIndex) => {
      if (part === null || typeof part !== 'object') return
      if (part.type !== 'image_url' && part.type !== 'input_image') return
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      parts.push({
        key: imagePartKey(messageIndex, partIndex),
        messageIndex,
        partIndex,
        url: typeof url === 'string' ? url : '',
        parsed: parseImageUrl(url),
      })
    })
  })
  return parts
}

/** 图片 part 的稳定键：messageIndex:partIndex。 */
function imagePartKey(messageIndex, partIndex) {
  return `${messageIndex}:${partIndex}`
}

/**
 * OpenAI 请求体 → DSH `GenerateOptions`。
 *
 * 返回对象上额外挂一个 `mgw` 命名空间（**不属于 GenerateOptions**，不要整个丢给
 * `ctx.llm.stream`；用 {@link streamOptionsOf} 剥掉）：
 *
 *   mgw.stream        客户端是否要 SSE
 *   mgw.includeUsage  stream_options.include_usage
 *   mgw.toolChoice    归一后的 tool_choice（DSH GenerateOptions 没有这个槽位）
 *   mgw.requestedModel 客户端原始 model 字符串（回给客户端时原样回显）
 *
 * @param {object} body OpenAI 请求体
 * @param {{provider: string, actualModel: string}} parsed {@link parseModel} 的结果
 * @param {{imageResolver?: (part: {key: string, messageIndex: number, partIndex: number, url: string, parsed: object}) => object|undefined}} [options]
 *   `imageResolver` 返回 DSH `ImageAttachmentRef`；没配或返回 undefined → 400 显式报错
 * @returns {object} GenerateOptions + mgw
 * @throws {ProtocolError} 400 各字段非法
 */
export function toGenerateOptions(body, parsed, options = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest(null, 'invalid_body', '请求体必须是 JSON 对象')
  }
  if (parsed === null || typeof parsed !== 'object'
    || typeof parsed.provider !== 'string' || typeof parsed.actualModel !== 'string') {
    throw new ProtocolError(500, 'server_error', null, 'internal_error', '内部错误：模型解析结果缺失')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw badRequest('messages', 'messages_required', 'messages 不能为空')
  }

  const imageResolver = typeof options.imageResolver === 'function' ? options.imageResolver : undefined
  const messages = body.messages.map((message, index) =>
    toRequestMessage(message, index, parsed, imageResolver))

  const toolChoice = toToolChoice(body.tool_choice)
  const tools = toToolSchemas(body.tools)
  const temperature = toTemperature(body.temperature)
  const maxTokens = toMaxTokens(body)
  const stop = toStop(body.stop)

  const result = {
    provider: parsed.provider,
    model: parsed.actualModel,
    messages,
    ...(tools !== undefined && toolChoice !== 'none' ? { tools } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(stop !== undefined ? { stop } : {}),
  }
  // 网关私有字段：不属于 GenerateOptions，交宿主前用 streamOptionsOf 剥掉
  result.mgw = {
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
    toolChoice,
    requestedModel: typeof body.model === 'string' ? body.model : `${parsed.provider}:${parsed.actualModel}`,
  }
  return result
}

/**
 * 剥掉网关私有字段，得到可以交给 `ctx.llm.stream` 的 GenerateOptions。
 *
 * @param {object} request {@link toGenerateOptions} 的返回值
 * @returns {object}
 */
export function streamOptionsOf(request) {
  const { mgw: _mgw, ...options } = request
  return options
}

/**
 * 单条 OpenAI message → DSH RequestMessage。
 *
 * role 映射：`system`/`developer` → system（上游不认 developer，沿用 shim 的做法）、
 * `user`、`assistant`、`tool`。其余（含 legacy `function`）→ 400。
 *
 * @param {object} message
 * @param {number} index
 * @param {{provider: string, actualModel: string}} parsed
 * @param {((part: object) => object|undefined)|undefined} imageResolver
 * @returns {object}
 */
function toRequestMessage(message, index, parsed, imageResolver) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw badRequest(`messages[${index}]`, 'invalid_messages', `messages[${index}] 不是对象`)
  }
  const role = message.role
  const param = `messages[${index}].role`

  if (role === 'system' || role === 'developer') {
    return {
      id: messageIdOf(message, index),
      role: 'system',
      content: toContentBlocks(message.content, 'system', index, imageResolver),
      source: { kind: 'system-prompt' },
    }
  }

  if (role === 'user') {
    return {
      id: messageIdOf(message, index),
      role: 'user',
      content: toContentBlocks(message.content, 'user', index, imageResolver),
      source: { kind: 'user' },
    }
  }

  if (role === 'assistant') {
    const blocks = toContentBlocks(message.content, 'assistant', index, imageResolver)
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((call, callIndex) => blocks.push(toToolCallBlock(call, index, callIndex)))
    }
    return {
      id: messageIdOf(message, index),
      role: 'assistant',
      content: blocks,
      source: { kind: 'model', provider: parsed.provider, model: parsed.actualModel },
    }
  }

  if (role === 'tool') {
    const callId = message.tool_call_id
    if (typeof callId !== 'string' || callId.trim() === '') {
      throw badRequest(`messages[${index}].tool_call_id`, 'missing_tool_call_id', 'tool 消息必须带 tool_call_id')
    }
    return {
      id: messageIdOf(message, index),
      role: 'tool',
      toolCallId: callId,
      content: toContentBlocks(message.content, 'tool', index, imageResolver),
      source: { kind: 'tool', callId },
      isError: message.is_error === true ? true : undefined,
    }
  }

  throw badRequest(param, 'invalid_role', `不支持的 role：${String(role)}`)
}

/** message 自带 id 就用，否则生成一个稳定可复现的（纯函数，不用 randomUUID）。 */
function messageIdOf(message, index) {
  return typeof message.id === 'string' && message.id !== '' ? message.id : `mgw-msg-${index}`
}

/**
 * OpenAI content → DSH ContentBlock[]。
 *
 * 支持字符串、part 数组（`text`/`input_text`/`image_url`/`input_image`）。
 * 未知 part 类型 → 400（不静默丢，丢了模型会少看内容）。
 *
 * @param {unknown} content
 * @param {'system'|'user'|'assistant'|'tool'} role
 * @param {number} messageIndex
 * @param {((part: object) => object|undefined)|undefined} imageResolver
 * @returns {object[]}
 */
function toContentBlocks(content, role, messageIndex, imageResolver) {
  if (content === undefined || content === null) return []
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) {
    throw badRequest(`messages[${messageIndex}].content`, 'invalid_content', 'content 必须是字符串或 part 数组')
  }

  const blocks = []
  content.forEach((part, partIndex) => {
    const param = `messages[${messageIndex}].content[${partIndex}]`
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part })
      return
    }
    if (part === null || typeof part !== 'object') {
      throw badRequest(param, 'invalid_content', 'content part 必须是对象或字符串')
    }
    const type = part.type
    if (type === 'text' || type === 'input_text') {
      const text = part.text
      if (typeof text !== 'string') throw badRequest(`${param}.text`, 'invalid_content', 'text part 缺少 text 字符串')
      blocks.push({ type: 'text', text })
      return
    }
    if (type === 'image_url' || type === 'input_image') {
      blocks.push(toImageBlock(part, role, messageIndex, partIndex, imageResolver))
      return
    }
    throw badRequest(`${param}.type`, 'unsupported_content_part', `不支持的 content part：${String(type)}`)
  })
  return blocks
}

/**
 * 单个 image part → DSH image block。
 *
 * 没有附件服务 / resolver 给不出 ref 时显式 400，绝不静默吞图。
 *
 * @param {object} part
 * @param {string} role
 * @param {number} messageIndex
 * @param {number} partIndex
 * @param {((part: object) => object|undefined)|undefined} imageResolver
 * @returns {{type: 'image', attachment: object}}
 */
function toImageBlock(part, role, messageIndex, partIndex, imageResolver) {
  const param = `messages[${messageIndex}].content[${partIndex}].image_url`
  if (role === 'system' || role === 'tool') {
    throw badRequest(param, CODE_IMAGE_UNSUPPORTED, `${role} 消息不支持图片`)
  }
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
  const parsed = parseImageUrl(url)
  const descriptor = {
    key: imagePartKey(messageIndex, partIndex),
    messageIndex,
    partIndex,
    url: typeof url === 'string' ? url : '',
    parsed,
  }
  const ref = imageResolver === undefined ? undefined : imageResolver(descriptor)
  if (ref === undefined || ref === null || typeof ref !== 'object') {
    throw badRequest(param, CODE_IMAGE_UNSUPPORTED, '网关未启用图片附件服务，无法接收 image_url')
  }
  return { type: 'image', attachment: ref }
}

/** assistant.tool_calls[] → DSH tool-call block。 */
function toToolCallBlock(call, messageIndex, callIndex) {
  const param = `messages[${messageIndex}].tool_calls[${callIndex}]`
  if (call === null || typeof call !== 'object') throw badRequest(param, 'invalid_tool_call', 'tool_call 不是对象')
  const id = typeof call.id === 'string' && call.id !== '' ? call.id : undefined
  if (id === undefined) throw badRequest(`${param}.id`, 'invalid_tool_call', 'tool_call 缺少 id')
  const fn = call.function ?? call
  const name = typeof fn?.name === 'string' ? fn.name : ''
  if (name === '') throw badRequest(`${param}.function.name`, 'invalid_tool_call', 'tool_call 缺少函数名')
  const args = fn.arguments
  const text = typeof args === 'string'
    ? args
    : args === undefined || args === null ? '{}' : JSON.stringify(args)
  return { type: 'tool-call', id, name, arguments: text }
}

/**
 * OpenAI tools[] → DSH ToolSchema[]。
 *
 * @param {unknown} tools
 * @returns {object[]|undefined}
 */
function toToolSchemas(tools) {
  if (tools === undefined || tools === null) return undefined
  if (!Array.isArray(tools)) throw badRequest('tools', 'invalid_tools', 'tools 必须是数组')
  return tools.map((tool, index) => {
    const param = `tools[${index}]`
    if (tool === null || typeof tool !== 'object') throw badRequest(param, 'invalid_tools', 'tool 不是对象')
    if (tool.type !== undefined && tool.type !== 'function') {
      throw badRequest(`${param}.type`, 'unsupported_tool_type', `不支持的 tool 类型：${String(tool.type)}`)
    }
    const fn = tool.function ?? tool
    const name = typeof fn?.name === 'string' ? fn.name.trim() : ''
    if (name === '') throw badRequest(`${param}.function.name`, 'invalid_tools', 'tool 缺少函数名')
    const parameters = fn.parameters
    if (parameters !== undefined
      && (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters))) {
      throw badRequest(`${param}.function.parameters`, 'invalid_tools', 'parameters 必须是 JSON Schema 对象')
    }
    return {
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: parameters ?? { type: 'object', properties: {} },
    }
  })
}

/**
 * `tool_choice` 归一。
 *
 * DSH GenerateOptions 没有 tool_choice 槽位，所以只归一 + 记录：
 * - `none`  → 同时把 tools 从 GenerateOptions 里去掉（语义等价）
 * - `auto` / `required` / 指定函数 → 原样记录在 `mgw.toolChoice`，由适配层决定怎么表达
 *
 * @param {unknown} value
 * @returns {'auto'|'none'|'required'|{name: string}|undefined}
 */
function toToolChoice(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none' || value === 'required') return value
    throw badRequest('tool_choice', 'invalid_tool_choice', `不支持的 tool_choice：${value}`)
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const name = value.function?.name ?? value.name
    if (value.type !== undefined && value.type !== 'function') {
      throw badRequest('tool_choice.type', 'invalid_tool_choice', 'tool_choice 只支持 function')
    }
    if (typeof name === 'string' && name.trim() !== '') return { name: name.trim() }
  }
  throw badRequest('tool_choice', 'invalid_tool_choice', 'tool_choice 格式非法')
}

/** temperature：只校验有限数，不做区间钳制（各家上游口径不同）。 */
function toTemperature(value) {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw badRequest('temperature', 'invalid_temperature', 'temperature 必须是数字')
  return number
}

/** max_tokens（兼容新 SDK 的 max_completion_tokens）。 */
function toMaxTokens(body) {
  const raw = body.max_tokens ?? body.max_completion_tokens
  if (raw === undefined || raw === null) return undefined
  const number = Number(raw)
  if (!Number.isInteger(number) || number < 1) {
    throw badRequest(body.max_tokens !== undefined ? 'max_tokens' : 'max_completion_tokens', 'invalid_max_tokens', 'max_tokens 必须是正整数')
  }
  return number
}

/** stop：字符串或字符串数组 → 字符串数组。 */
function toStop(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value === '' ? undefined : [value]
  if (Array.isArray(value)) {
    const list = []
    value.forEach((item, index) => {
      if (typeof item !== 'string' || item === '') {
        throw badRequest(`stop[${index}]`, 'invalid_stop', 'stop 只能是字符串或字符串数组')
      }
      list.push(item)
    })
    return list.length === 0 ? undefined : list
  }
  throw badRequest('stop', 'invalid_stop', 'stop 只能是字符串或字符串数组')
}

/**
 * DSH FinishReason → OpenAI finish_reason。
 *
 * `aborted` / `error` 返回 null：DSH 这两种情况不吐正常结束帧，网关应直接
 * `[DONE]` 或发错误帧（规格 §1.1 映射表）。
 *
 * @param {{kind?: string}|string|undefined} reason
 * @returns {'stop'|'tool_calls'|'length'|null}
 */
export function finishReasonOf(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind
  switch (kind) {
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    case 'aborted':
    case 'error':
      return null
    case 'stop':
    default:
      return 'stop'
  }
}

/**
 * 模型目录 → OpenAI `/v1/models` 响应（规格 §1.2）。
 *
 * `object:"list"` 与每项 `object:"model"`、`created`、`owned_by` 都是硬要求；
 * **不加**任何非标准扩展字段（严格客户端会解析失败）。
 *
 * @param {Array<string|{id: string, owned_by?: string, created?: number}>} entries
 * @param {{created?: number, ownedBy?: string}} [options] `created` 默认 0（调用方传网关启动时间）
 * @returns {{object: 'list', data: Array<{id: string, object: 'model', created: number, owned_by: string}>}}
 */
/**
 * 把别名表套到模型目录上：**一个模型最多一个别名，有别名就只报别名**。
 *
 * 之所以要替换而不是追加：如果既报原名又报别名，调用方在模型选择器里会
 * 看到同一个模型出现两次（`mg-workbuddy:claude-sonnet-4` 与 `my-model`），
 * 用户不知道该选哪个。
 *
 * @param {Array<string|{id: string}>} entries 原始目录（含要发布的名字）
 * @param {Record<string,string>} aliases 别名 → 目标
 * @returns {Array<string|{id: string}>} 替换后的目录，顺序与原目录一致
 */
export function applyAliases(entries, aliases) {
  const aliasOf = new Map()
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    if (typeof target !== 'string') continue
    if (!aliasOf.has(target)) aliasOf.set(target, alias)
  }
  const out = []
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id !== 'string') { out.push(entry); continue }
    const alias = aliasOf.get(id)
    if (alias === undefined) { out.push(entry); continue }
    out.push(typeof entry === 'string' ? alias : { ...entry, id: alias })
  }
  return out
}

export function modelsList(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('modelsList: entries 必须是数组')
  const fallbackCreated = Number.isFinite(options.created) ? Math.floor(options.created) : 0
  const fallbackOwnedBy = typeof options.ownedBy === 'string' && options.ownedBy !== ''
    ? options.ownedBy
    : DEFAULT_OWNED_BY
  const data = []
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id !== 'string' || id.trim() === '') continue
    const created = Number.isFinite(entry?.created) ? Math.floor(entry.created) : fallbackCreated
    const ownedBy = typeof entry?.owned_by === 'string' && entry.owned_by !== ''
      ? entry.owned_by
      : fallbackOwnedBy
    const item = { id: id.trim(), object: 'model', created, owned_by: ownedBy }
    // 上下文窗口与能力：OpenAI 官方 /v1/models 只给 id/object/created/owned_by，
    // 但真实调用方（Cherry Studio、LobeChat、各类 Agent 框架）普遍靠这几个字段
    // 算上下文预算与是否允许贴图。给了不破坏兼容，缺了才难用。
    // 只在**确定有值**时输出，不编造默认值（宁可缺字段也不给错的）。
    if (Number.isFinite(entry?.context_length) && entry.context_length > 0) {
      item.context_length = Math.floor(entry.context_length)
    }
    if (Number.isFinite(entry?.max_output_tokens) && entry.max_output_tokens > 0) {
      item.max_output_tokens = Math.floor(entry.max_output_tokens)
    }
    if (typeof entry?.supports_vision === 'boolean') item.supports_vision = entry.supports_vision
    if (typeof entry?.supports_tools === 'boolean') item.supports_tools = entry.supports_tools
    if (typeof entry?.supports_reasoning === 'boolean') item.supports_reasoning = entry.supports_reasoning
    data.push(item)
  }
  return { object: 'list', data }
}

/**
 * 单个模型条目（`GET /v1/models/:model` 用）。
 *
 * @param {{id: string, owned_by?: string, created?: number}} entry
 * @param {{created?: number, ownedBy?: string}} [options]
 * @returns {{id: string, object: 'model', created: number, owned_by: string}}
 */
export function modelObject(entry, options = {}) {
  const list = modelsList([entry], options)
  if (list.data.length === 0) throw new TypeError('modelObject: 缺少合法 id')
  return list.data[0]
}
