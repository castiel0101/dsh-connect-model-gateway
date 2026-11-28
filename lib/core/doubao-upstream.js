/**
 * 豆包私有协议客户端。
 *
 * 端点不是 OpenAI 兼容的 —— `POST /chat/completion` 用的是字节自研的三行帧：
 *
 *     id: 1
 *     event: CHUNK_DELTA
 *     data: {"text": "你", "id": "xxx"}
 *     <空行>
 *
 * 所以魔桥不能像 raccoon 那样直连，必须在本机起 shim 把标准 OpenAI 请求翻成
 * 这种帧、再把回复翻回去。这个文件就是「发什么、怎么解」的那一半。
 *
 * 三件必须做对的事（每一件都是实测踩出来的，不是猜的）：
 *
 * 1. `duration_ms` / `tt_first_token` 之类的 telemetry 字段缺失会被判非法参数，
 *    所以即使拿不到真值也要填。
 * 2. 回复文本散落在多种块里（`text_block.text`、`CHUNK_DELTA` 的 `text`、
 *    思考块），`collectBlocks` 是按**语义**遍历整棵树，不是按固定路径取值。
 * 3. `710022004` 是风控要滑块，不是限流。绝不能重试 —— 重试只会加重风控，
 *    而且每次都真的消耗额度。
 *
 * @module dsh-connect-model-gateway/core/doubao-upstream
 */

import {
  CHAT_AGENT_MODE, CHAT_ENDPOINT, CLIENT_PARAMS, CREATION_BLOCK_TYPE, DEFAULT_BOT_ID, DOUBAO_VERSION,
  IMAGE_MODEL_ID, THINKING_BLOCK_TYPE, inputSkillOf, withImagePrefix,
} from './doubao-catalog.js'
import { applyFingerprintHeaders } from './doubao-fingerprint.js'

/** 上游业务错误。`kind` 是给 shim/网关用的分类。 */
export class DoubaoUpstreamError extends Error {
  constructor(message, code, rateLimited = false, extra = {}) {
    super(message)
    this.name = 'DoubaoUpstreamError'
    this.code = code
    this.rateLimited = rateLimited
    this.kindHint = extra.kind
    this.httpStatus = extra.status
    this.transport = extra.transport === true
    this.local = extra.local === true
    this.body = extra.body
  }
}

export const CODE_SESSION_DEAD = 710012001
export const CODE_RATE_LIMITED = 710022004
export const CODE_INVALID_PARAM = 710020202
export const CODE_CONTENT_BLOCKED = 710022002

/** 单次请求体上限（实测 256 KiB 被拒），留 8 KiB 给信封与插件加的字段。 */
export const MAX_BODY_BYTES = 256 * 1024
export const BODY_SAFETY_BYTES = 8 * 1024
export const PROMPT_BUDGET_BYTES = 220_000

/** 连续两次 Node 请求的最小间隔。风控会看频率，这是明确的刹车。 */
const DEFAULT_MIN_INTERVAL_MS = 2_000
const DEFAULT_RISK_COOLDOWN_MS = 60 * 60 * 1000

function envDuration(name, fallback) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/* ------------------------------------------------------------------ 请求构造 */

/**
 * 出站请求头。
 *
 * `sec-ch-ua` 必须是**真实的 Chromium 版本串**，不能用占位符：上游会把它与
 * UA 里的版本对齐，不一致就是风控特征。UA 后缀 `SamanthaDoubao/<version>`
 * 是客户端自己的标识，缺了会被当成网页版走另一条（更严的）限流。
 */
export function buildHeaders(credentials, options = {}) {
  const headers = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json; charset=utf-8',
    origin: 'https://www.doubao.com',
    referer: 'https://www.doubao.com/chat/',
    'user-agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) `
      + `Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/${DOUBAO_VERSION}`,
    'sec-ch-ua': `"Chromium";v="147", "Not.A/Brand";v="24", "Google Chrome";v="147"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-flow-trace': `04-${randomHex(32)}`,
    ...(options.extra ?? {}),
  }
  if (typeof credentials?.header === 'string' && credentials.header !== '') {
    headers.cookie = options.cookieOverride ?? credentials.header
  }
  // 浏览器抓到的身份覆盖默认值：同一账号在两个身份下发的请求会被判异常
  return applyFingerprintHeaders(headers, options.fingerprint)
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 把客户端身份拼到 URL 上。缺字段会被判非法参数，所以要一次拼全。 */
export function buildQueryUrl(endpoint, extra = {}) {
  const url = new URL(endpoint)
  const merged = { ...CLIENT_PARAMS, ...extra }
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * 组装 chat 请求体。
 *
 * 这是整个移植里**最不能简化**的一段。豆包的服务端只认它自己客户端发的那份
 * 结构（2026-11-28 用 CDP 从运行中的客户端抓包逐字核对），少一层都会 400：
 *
 * - `messages[]` 不是 OpenAI 的 `{role, content}`，而是
 *   `{local_message_id, message_status, content_block: [{block_type:10000, content:{text_block:{text}}}]}`；
 * - 模型、档位、模式在 `option` 里**声明三次**（`conversation_init_ext` /
 *   `model_config` / `aggregate_params`），只写一处服务端会取默认；
 * - `need_create_conversation` 是「续聊」的开关（取反），不是 `conversation_id` 有没有值；
 * - `sse_recv_event_options.support_chunk_delta` 打开才有增量块；
 * - `option` 里是对象、`ext` 里是同一份东西的**字符串**，这个不对称是客户端的。
 */
export function buildChatBody(prompt, options = {}) {
  const {
    modelKey = '0',
    conversationId,
    continueConversation = false,
    botId = DEFAULT_BOT_ID,
    skill,
    deepThink = false,
    reasoningLevel,
    taskMode = false,
  } = options

  const isImageTurn = skill === 'imageGen' || isImageTurnModel(modelKey)
  const text = withImagePrefix(prompt, isImageTurn)
  const now = Date.now()
  const agentMode = taskMode ? 1 : CHAT_AGENT_MODE
  const modeId = taskMode ? '3' : '1'
  // 深度思考是「开关 + 档位」两件事：只发档位不发开关，服务端开个空壳不思考
  const needDeepThink = deepThink && typeof reasoningLevel === 'number' ? 10_000 + reasoningLevel : 0
  const level = typeof reasoningLevel === 'number' ? reasoningLevel : 5
  const localMessageId = randomUuid()
  const taskParam = { server_do_compare: true }
  const inputSkill = inputSkillOf(skill)

  return {
    messages: [{
      local_message_id: localMessageId,
      message_status: 0,
      content_block: [{
        block_type: 10000,
        block_id: randomUuid(),
        parent_id: '',
        meta_info: [],
        append_fields: [],
        content: {
          text_block: { text, icon_url: '', icon_url_dark: '', summary: '' },
          pc_event_block: '',
        },
      }],
    }],
    option: {
      send_message_scene: '',
      create_time_ms: now,
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      agent_mode: agentMode,
      tts_switch: false,
      need_deep_think: needDeepThink,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: '',
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUuid(),
      start_seq: 0,
      /**
       * 续聊：false + 服务端给过的 id；其余一律开新会话。
       *
       * 生图轮**永远**开新会话，即使上层说这是续聊：同一个 conversation 里
       * 第二次生图会命中上一轮图的占位，拿回来的是旧图而不是新图。
       */
      need_create_conversation: isImageTurn ? true : continueConversation !== true,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: {
        model_item_key: modelKey,
        reasoning_effort: String(level),
        mode_id: modeId,
      },
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: '',
      shared_app_id: '',
      // 没有这个就拿不到增量，只会在最后收到一整段
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_ai_playground: false,
      is_old_user: true,
      general_task_param: taskParam,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(now / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
      model_config: {
        model_item_key: modelKey,
        model_extra_params: {},
        reasoning_effort: level,
      },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        // 深度思考时这里是 "1"；空串表示普通轮。不传的话 10040 块会出现但内容是空的
        conversation_mode: deepThink ? '1' : '',
        mode_id: modeId,
        model_item_key: modelKey,
        agent_mode: String(agentMode),
        reasoning_effort: String(level),
        provider_id: '',
      },
    },
    client_meta: {
      local_conversation_id: `local_${randomUuid()}`,
      conversation_id: !isImageTurn && continueConversation === true && typeof conversationId === 'string'
        ? conversationId : '',
      bot_id: botId,
      last_section_id: '',
      last_message_index: null,
      local_permissions: [
        { permission_name: 'ACCESS_COARSE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_FINE_LOCATION', status: 1 },
        { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 1 },
      ],
    },
    user_context: [],
    ext: {
      agent_mode: String(agentMode),
      use_deep_think: String(needDeepThink),
      sub_conv_firstmet_type: '1',
      general_task_param: JSON.stringify(taskParam),
      collection_id: '',
      is_finish: '1',
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      commerce_credit_config_enable: '0',
      // 技能轴：缺省是普通对话；生图是这段 JSON 字符串，嵌套对象服务端没见过
      ...(inputSkill === undefined ? {} : { input_skill: inputSkill }),
    },
  }
}

/** UUIDv4；用 crypto 而不是手搓，避免与客户端的 id 形态不一致。 */
function randomUuid() {
  return globalThis.crypto.randomUUID()
}

function isImageTurnModel(modelKey) {
  return modelKey === IMAGE_MODEL_ID
}

/* ------------------------------------------------------------------ 帧解析 */

/**
 * 解析字节的三行帧。
 *
 * 标准 SSE 用 `data:` + 空行，这里多一层 `id:` / `event:`，而且 **event 名
 * 承载语义**（`CHUNK_DELTA` 是增量，`SSE_REPLY_END` 之类是收尾）。用标准
 * SSE 解析器读会丢事件名，然后就分不清「增量文本」和「整段快照」。
 */
export function* parseFrames(text) {
  for (const rawBlock of text.split(/\n\n+/)) {
    const block = rawBlock.trim()
    if (block === '') continue
    let event = ''
    let id = ''
    const dataLines = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    const data = dataLines.join('\n')
    if (data === '[DONE]') {
      yield { event, id, done: true }
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    yield { event, id, data: parsed }
  }
}

/** 思考块里那些「正在思考…」的占位标题，不能当正文。 */
const PLACEHOLDER_THINKING_TITLE_RE = /^(正在)?(深度)?思考(中|过程)?\.{0,3}$/

function nonPlaceholderTitle(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || PLACEHOLDER_THINKING_TITLE_RE.test(trimmed)) return undefined
  return trimmed
}

/** 新建一次遍历的收集状态。 */
export function createBlockCollectState() {
  return {
    thinkingIds: new Set(),
    activeTarget: undefined,
    sawThinkingBlock: false,
    hasFullThinkingText: false,
    seenTitles: new Set(),
    lastTitles: new Map(),
    lastSummaries: new Map(),
  }
}

/**
 * 把一个图片块条目变成 `{url,width,height}`。
 *
 * 优先级是**不看画质看水印**：`image_ori_raw` 是未压缩原图且无水印，
 * `image_ori` 已压过，`image_preview`/`image_thumb` 是缩略图。发原图给用户是
 * 唯一正确的选择 —— 拿缩略图当结果是这个插件早期最常被投诉的问题。
 */
export function toDoubaoImage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined

  /**
   * 一条 creation 的图片挂在 `creation.image` 下面，不是直接挂在 creation 上。
   *
   * 实测帧（2026-11-28）：
   *   creations: [{ type:1, id, gen_detail, can_publish:true,
   *                 image: { key, image_thumb:{url,width,height},
   *                          image_ori:{url,width,height},
   *                          image_ori_raw:{...} } }]
   * 只看 creation 这一层会一个 URL 都取不到 —— 回复里明明写着「已生成图片」，
   * 界面上却什么都没有。
   *
   * 另有两种真实的「无图帧」必须跳过：一是只带 `image.placeholder`
   * （{width,height,description:"Seedream 5.0 Flash"}）的占位帧，二是 `image.status`
   * 还在生成中的帧。它们都没有 URL，靠 extractImageUrl 自然落空。
   */
  const holders = [raw, raw.image, raw.creation, raw.data]
  for (const holder of holders) {
    if (holder === null || typeof holder !== 'object') continue
    const candidates = [
      holder.image_ori_raw, holder.image_ori, holder.image_preview, holder.image_thumb,
    ]
    for (const candidate of candidates) {
      const url = extractImageUrl(candidate)
      if (url !== undefined) {
        return {
          url,
          width: positiveInt(candidate?.width ?? candidate?.image_width ?? holder.width ?? holder.height),
          height: positiveInt(candidate?.height ?? candidate?.image_height ?? holder.height),
          key: typeof holder.key === 'string' && holder.key !== '' ? holder.key : undefined,
        }
      }
    }
  }
  return undefined
}

function extractImageUrl(value) {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return value
  if (value === null || typeof value !== 'object') return undefined
  for (const key of ['url', 'image_url', 'uri', 'download_url']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate
  }
  // 有的版本把 URL 数组塞在 urls[0]
  if (Array.isArray(value.url_list)) {
    const first = value.url_list.find((item) => typeof item === 'string' && /^https?:\/\//.test(item))
    if (first !== undefined) return first
  }
  return undefined
}

function positiveInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

/**
 * 非负整数：0 是**合法值**。
 *
 * 余额、窗口上限、重置时刻都可能是 0，用 positiveInt 读会把「0」当成「没给」，
 * 于是额度用尽的账号显示「未知」——这是最该区分开的两种状态。
 */
function nonNegativeInt(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

function pushThinkingPiece(state, into, piece, asTitle) {
  if (piece === '') return
  state.sawThinkingBlock = true
  if (asTitle && into.thinking.length > 0) into.thinking.push('\n\n')
  into.thinking.push(piece)
}

/**
 * 语义遍历整个帧，把文本与图片分别收进 `into`。
 *
 * 为什么要深遍历而不是取固定路径：豆包的回复可以嵌在 `message.content`、
 * 顶层 `content_block`、或者数组元素里，层级随版本变化。按语义判断
 * （「这是 thinking 块吗」「这个 text 属于哪个目标」）比按路径稳。
 */
/**
 * 帧是否在回显**用户自己**发的那条消息（不是模型的回答）。
 *
 * 实测（2026-11-28）：`FULL_MSG_NOTIFY` 会把刚发出去的问题原样回传，
 * `message.user_type === 1` 且 `index_in_conv === 1`；模型的回答帧里这两个
 * 字段都缺省。不跳过的话答案开头会多出一段问题原文，看起来像模型在复读问题。
 */
function isUserEcho(payload) {
  const message = payload?.message
  if (message === null || typeof message !== 'object') return false
  return message.user_type === 1 || message.index_in_conv === 1
}

export function collectBlocks(node, into, state = createBlockCollectState(), depth = 0) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) collectBlocks(item, into, state, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  if (depth > 24) return

  const record = node
  const blockType = positiveInt(record.block_type)

  if (blockType !== undefined) {
    const blockId = typeof record.block_id === 'string' ? record.block_id : undefined
    const parentId = typeof record.parent_id === 'string' ? record.parent_id : ''
    const isThinking = blockType === THINKING_BLOCK_TYPE
      || (parentId !== '' && state.thinkingIds.has(parentId))

    if (blockType === THINKING_BLOCK_TYPE && blockId !== undefined) state.thinkingIds.add(blockId)

    // 生图块：每个 creation 会多次到达（先占位无 URL，后补真 URL），
    // 所以调用方按 URL 去重，而不是按 id。
    if (blockType === CREATION_BLOCK_TYPE) {
      state.activeTarget = 'answer'
      const creations = record.content?.creation_block?.creations
      if (Array.isArray(creations)) {
        for (const raw of creations) {
          const image = toDoubaoImage(raw)
          if (image !== undefined) into.images.push(image)
        }
      }
    }

    const content = record.content
    const thinkingBlock = content?.thinking_block
    const text = content?.text_block?.text
    const summary = content?.text_block?.summary

    if (isThinking) {
      if (thinkingBlock !== undefined && thinkingBlock !== null
        && thinkingBlock.empty_disable_click !== true) {
        const isSummaryStyle = thinkingBlock.cot_ui_style === 'summary'
        if (!state.hasFullThinkingText || isSummaryStyle) {
          const title = nonPlaceholderTitle(thinkingBlock.finish_title)
            ?? nonPlaceholderTitle(thinkingBlock.unfold_streaming_title)
            ?? nonPlaceholderTitle(thinkingBlock.streaming_title)
          if (title !== undefined) {
            state.sawThinkingBlock = true
            const titleKey = blockId ?? '__thinking_title__'
            if (!state.seenTitles.has(title) && state.lastTitles.get(titleKey) !== title) {
              state.seenTitles.add(title)
              state.lastTitles.set(titleKey, title)
              pushThinkingPiece(state, into, `${title}\n\n`, true)
            }
          }
        }
      }

      if (typeof text === 'string' && text !== '') {
        state.hasFullThinkingText = true
        state.sawThinkingBlock = true
        pushThinkingPiece(state, into, text, false)
      } else if (typeof summary === 'string' && summary.trim() !== '') {
        const trimmedSummary = summary.trim()
        if (!PLACEHOLDER_THINKING_TITLE_RE.test(trimmedSummary)) {
          state.sawThinkingBlock = true
          const summaryKey = blockId ?? (parentId !== '' ? `${parentId}:summary` : '__thinking_summary__')
          const prev = state.lastSummaries.get(summaryKey) ?? ''
          if (prev === '' && state.seenTitles.has(trimmedSummary)) {
            state.lastSummaries.set(summaryKey, summary)
          } else if (summary !== prev) {
            state.lastSummaries.set(summaryKey, summary)
            if (prev !== '' && summary.startsWith(prev)) {
              pushThinkingPiece(state, into, summary.slice(prev.length), false)
            } else {
              state.seenTitles.add(trimmedSummary)
              pushThinkingPiece(state, into, summary, true)
            }
          }
        }
      }

      if (typeof text === 'string' && text !== '' && record.is_finish !== true) {
        state.activeTarget = 'thinking'
      } else if (blockType !== THINKING_BLOCK_TYPE && record.is_finish !== true) {
        state.activeTarget = 'thinking'
      } else if (blockType === THINKING_BLOCK_TYPE && state.activeTarget === undefined
        && record.is_finish !== true) {
        state.activeTarget = 'thinking'
      }
    } else {
      if (typeof text === 'string' && text !== '') into.answer.push(text)
      if (content?.text_block !== undefined) state.activeTarget = 'answer'
    }
  } else if (
    typeof record.text === 'string'
    && record.text !== ''
    && !('content_block' in record)
    && !('message' in record)
    && (typeof record.id === 'string'
      || (depth === 0 && !('block_type' in record) && !('icon_url' in record)))
  ) {
    // `event: CHUNK_DELTA` 的增量文本：`{text, id}` 或没有 id（落到当前目标）
    const isThinkingDelta = typeof record.id === 'string'
      ? state.thinkingIds.has(record.id)
      : state.activeTarget === 'thinking'
    if (isThinkingDelta) {
      state.sawThinkingBlock = true
      pushThinkingPiece(state, into, record.text, false)
    } else {
      into.answer.push(record.text)
    }
    return
  }

  for (const value of Object.values(record)) collectBlocks(value, into, state, depth + 1)
}

/** 通知文本与增量文本的拼接规则：增量已含通知时不再重复。 */
export function assembleReplyText(notifyText, chunkText) {
  if (notifyText === '') return chunkText
  if (chunkText === '') return notifyText
  return chunkText.startsWith(notifyText) ? chunkText : notifyText + chunkText
}

/** 从任意层级里挖出服务端声明的模型名。 */
export function extractModel(payload) {
  const seen = new Set()
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item)
        if (found !== undefined) return found
      }
      return undefined
    }
    for (const key of ['model', 'model_name', 'model_id', 'llm_model_type', 'model_type']) {
      const value = node[key]
      if (typeof value === 'string' && value !== '' && !seen.has(value)) {
        seen.add(value)
        return value
      }
      if (typeof value === 'number' && value !== 0) {
        const text = String(value)
        if (!seen.has(text)) { seen.add(text); return text }
      }
    }
    for (const value of Object.values(node)) {
      const found = walk(value)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(payload)
}

/** 服务端是否真的走了深度思考（`ext.use_deep_think`）。 */
export function extractThinking(payload) {
  const ext = payload?.message?.ext ?? payload?.ext
  if (ext !== null && typeof ext === 'object') {
    const value = ext.use_deep_think
    if (value === '1' || value === 1) return true
    if (typeof value === 'string' && value !== '' && value !== '0') return true
  }
  return false
}

/** 提取 `conversation_id`，供下一轮续聊。 */
export function extractConversationId(payload) {
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 20) return undefined
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1)
        if (found !== undefined) return found
      }
      return undefined
    }
    for (const key of ['conversation_id', 'conversationId']) {
      const value = node[key]
      if (typeof value === 'string' && value !== '' && !seen.has(value)) return value
    }
    for (const value of Object.values(node)) {
      const found = walk(value, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(payload, 0)
}

/* ------------------------------------------------------------------ 失败分类 */

/**
 * 内容审核通知 vs 正常回答。
 *
 * 平台自己的措辞有三个特征同时出现：点名违规、印出申诉按钮、告诉你入口在哪。
 * 模型转述这条通知时至少会改掉其中一个 —— 这就是「它仍是回答」的判据。
 */
export function isContentModerationNotice(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 200) return false
  const flagged = /涉嫌违反|违反[^。！？\n]{0,6}使用规范/.test(trimmed)
  const appeal = /反馈与举报/.test(trimmed)
  const instruction = /长按|本条消息|该内容|这条消息/.test(trimmed)
  return flagged && appeal && instruction
}

export function classifyDoubaoFailure(error) {
  if (error?.kindHint !== undefined) return error.kindHint
  if (error?.rateLimited === true || error?.code === CODE_RATE_LIMITED) return 'rate_limited'
  if (error?.code === CODE_SESSION_DEAD) return 'session_dead'
  if (error?.code === CODE_CONTENT_BLOCKED) return 'content_blocked'
  if (error?.httpStatus === 401 || error?.httpStatus === 403) return 'session_dead'
  if (error?.httpStatus === 429) return 'quota_exhausted'
  if (error?.transport === true) return 'network'
  return 'upstream'
}

/**
 * 是否值得重试。故意收得很窄。
 *
 * 重发一轮既花额度又会在服务端开一个新会话，所以只有「可证明没有产出答案」
 * 的失败才算：传输层在收到任何字节前失败，或 5xx。**截断的流不算** ——
 * 重试等于开一个新对话并丢掉半个答案，这种必须告诉用户。
 */
export function isRetryableFailure(error) {
  if (!(error instanceof DoubaoUpstreamError)) return false
  if (error.transport === true) return true
  if (error.httpStatus !== undefined) return error.httpStatus >= 500
  return false
}

export function isInvalidParamFailure(error) {
  return error instanceof DoubaoUpstreamError && error.code === CODE_INVALID_PARAM
}

/** 给用户看的文案。滑块那条最关键：唯一能修的地方在官方客户端里。 */
export const ERROR_HINTS = {
  rate_limited:
    '豆包触发了人机验证（710022004，滑块），不是普通限流。插件无法绕过：'
    + '请到豆包网页或客户端完成一次验证后再试；连续重试只会加重风控。',
  quota_exhausted: '豆包额度已用尽，等额度窗口重置，或在客户端看「订阅与额度管理」。',
  session_dead: '豆包登录态失效，请在魔桥设置页重新扫码登录。',
  network: '连不上豆包（网络或超时），检查网络后重试。',
  upstream: '豆包返回了错误响应（不是网络问题，重试通常无效）。',
  content_blocked: '豆包内容审核拦了这条消息。换种说法或拆小后再试，本插件不会绕过审核。',
  context_overflow: '这次请求超过豆包单次上限（256 KiB UTF-8）。压缩上下文或缩短单条消息后重试。',
  task_runtime_unavailable: '这个账号被路由到「工作任务」模式，其运行时只在豆包客户端进程里。请把开关切回「对话」。',
}

/* ------------------------------------------------------------------ 风控刹车 */

let lastNodeAttemptAt = 0
let nodeQueue = Promise.resolve()

/** 本地冷却剩余毫秒（0 表示没开）。 */
let riskUntil = 0

export function riskCircuitRemainingMs() {
  return Math.max(0, riskUntil - Date.now())
}

/** 人工过完滑块后清掉本地冷却。 */
export function clearRiskCircuit() {
  riskUntil = 0
}

function enforceRiskCircuit() {
  const remaining = riskCircuitRemainingMs()
  if (remaining <= 0) return
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  throw new DoubaoUpstreamError(
    `豆包风控冷却中，约 ${minutes} 分钟后再试。本次没有向上游发请求。`,
    CODE_RATE_LIMITED, true, { kind: 'rate_limited', local: true },
  )
}

function openRiskCircuit(error) {
  if (!(error instanceof DoubaoUpstreamError) || error.code !== CODE_RATE_LIMITED) return
  const cooldown = envDuration('DSH_DOUBAO_RISK_COOLDOWN_MS', DEFAULT_RISK_COOLDOWN_MS)
  if (cooldown <= 0) return
  riskUntil = Date.now() + cooldown
  process.stderr.write(`[doubao] 710022004，本地冷却 ${Math.ceil(cooldown / 60_000)} 分钟\n`)
}

function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    const aborted = () => {
      clearTimeout(timer)
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal?.aborted === true) { aborted(); return }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/**
 * 串行化 + 限速的 Node 请求。
 *
 * 为什么要串行：豆包按**账号**限频，并发两轮就等于自己撞风控。排队在这里比
 * 在网关层排队更准，因为这里是真正发请求的地方。
 */
async function runNodeCall(call, signal) {
  const execute = async () => {
    enforceRiskCircuit()
    const interval = envDuration('DSH_DOUBAO_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS)
    const waitMs = Math.max(0, lastNodeAttemptAt + interval - Date.now())
    if (waitMs > 0) await delay(waitMs, signal)
    enforceRiskCircuit()
    lastNodeAttemptAt = Date.now()
    try {
      const result = await call()
      clearRiskCircuit()
      return result
    } catch (error) {
      openRiskCircuit(error)
      throw error
    }
  }
  const run = nodeQueue.then(execute, execute)
  nodeQueue = run.catch(() => {})
  return run
}

/* ------------------------------------------------------------------ 续聊判定 */

/**
 * 一次请求是不是「接着上一轮」。
 *
 * 判据：首条消息完全相同，且 transcript **变长**了。等长是同一轮的重试
 * （用户点了重发），绝不能当成新的一轮追加到服务端会话里。
 */
export function isContinuation(messages, state) {
  if (state === undefined) return false
  if (!Array.isArray(messages)) return false
  return messages.length > state.messageCount
}

/* ------------------------------------------------------------------ 流式请求 */

const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * 发一轮并消费流。
 *
 * `onText`/`onThinking` 拿到增量；返回完整结果。
 */
export async function streamOnce(prompt, options = {}) {
  const credentials = options.credentials ?? {}
  const body = buildChatBody(prompt, options)
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  if (bytes > MAX_BODY_BYTES) {
    throw new DoubaoUpstreamError(
      `请求体 ${bytes} 字节，超过豆包单次上限 ${MAX_BODY_BYTES}。`,
      CODE_INVALID_PARAM, false, { kind: 'context_overflow', status: 400 },
    )
  }

  const url = buildQueryUrl(CHAT_ENDPOINT)
  const headers = buildHeaders(credentials, { fingerprint: options.fingerprint })
  const controller = new AbortController()
  const outer = options.signal
  if (outer !== undefined) {
    if (outer.aborted === true) controller.abort()
    else outer.addEventListener('abort', () => controller.abort(), { once: true })
  }
  let idleTimer
  const touch = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new Error(
      `豆包 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没返回数据，已中止。`,
    )), STREAM_IDLE_TIMEOUT_MS)
  }

  let response
  try {
    touch()
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (error?.name === 'AbortError') throw error
    throw new DoubaoUpstreamError(
      `连接豆包失败：${error?.message ?? error}`, '', false, { kind: 'network', transport: true },
    )
  }

  if (!response.ok) {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    const text = await response.text().catch(() => '')
    const kind = response.status === 401 || response.status === 403 ? 'session_dead'
      : response.status === 429 ? 'quota_exhausted' : 'upstream'
    throw new DoubaoUpstreamError(
      `豆包 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`,
      '', false, { kind, status: response.status, body: text.slice(0, 2_000) },
    )
  }

  const into = { answer: [], thinking: [], images: [] }
  const state = createBlockCollectState()
  let notifyText = ''
  let chunkText = ''
  let model
  let thinking = false
  let conversationId = options.conversationId
  let sawAny = false

  const reader = response.body?.getReader()
  if (reader === undefined) {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    throw new DoubaoUpstreamError('豆包返回了空响应', '', false, { kind: 'upstream', status: 502 })
  }
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      touch()
      sawAny = true
      buffer += decoder.decode(value, { stream: true })
      // 帧以空行分隔，但可能跨 chunk，所以只在看到空行时消费
      let split
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        consumeBlock(block)
      }
    }
    if (buffer.trim() !== '') consumeBlock(buffer)
  } catch (error) {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (error?.name === 'AbortError') throw error
    throw new DoubaoUpstreamError(
      `豆包流中断：${error?.message ?? error}`, '', false, { kind: 'network', transport: !sawAny },
    )
  }
  if (idleTimer !== undefined) clearTimeout(idleTimer)

  function consumeBlock(block) {
    for (const frame of parseFrames(block)) {
      if (frame.done === true) continue
      const payload = frame.data
      if (payload === undefined) continue
      /**
       * 跳过「用户消息回显」帧。
       *
       * `FULL_MSG_NOTIFY` 会把我们刚发出去的问题原样回传一遍（`user_type:1`），
       * 内容是用户的话不是模型的答案。收进来以后答案开头就多出一段问题原文，
       * 看起来像模型在复读。
       */
      if (isUserEcho(payload)) continue
      // 业务错误藏在帧里，不是 HTTP 状态码 —— 这是最容易漏的一层
      const error = detectErrorFrame(payload)
      if (error !== undefined) throw error
      const found = extractModel(payload)
      if (found !== undefined && model === undefined) model = found
      if (extractThinking(payload)) thinking = true
      const conv = extractConversationId(payload)
      if (conv !== undefined && conversationId === undefined) conversationId = conv

      const before = { answer: into.answer.length, thinking: into.thinking.length, images: into.images.length }
      const answerMark = into.answer.join('').length
      const thinkingMark = into.thinking.join('').length
      collectBlocks(payload, into, state)

      const answerText = into.answer.join('')
      if (answerText.length > answerMark) {
        const delta = answerText.slice(answerMark)
        chunkText = answerText
        options.callbacks?.onText?.(delta)
      }
      const thinkingText = into.thinking.join('')
      if (thinkingText.length > thinkingMark) {
        options.callbacks?.onThinking?.(thinkingText.slice(thinkingMark))
      }
      void before
    }
  }

  // 通知文本：有的帧把它单独放在 `notify` 里
  const text = assembleReplyText(notifyText, chunkText)
  return {
    text: text.replace(/^\s+/, ''),
    reasoningText: into.thinking.join(''),
    thinking,
    model,
    conversationId,
    images: dedupeImages(into.images),
    raw: undefined,
  }
}

function dedupeImages(images) {
  const seen = new Set()
  const out = []
  for (const image of images) {
    if (seen.has(image.url)) continue
    seen.add(image.url)
    out.push(image)
  }
  return out
}

/** 从一帧里读出业务错误。`710022004` 就是风控滑块。 */
function detectErrorFrame(payload) {
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 12) return undefined
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1)
        if (found !== undefined) return found
      }
      return undefined
    }
    const code = Number(node.code)
    const statusCode = Number(node.status_code)
    for (const candidate of [code, statusCode]) {
      if (!Number.isFinite(candidate) || candidate === 0) continue
      const key = String(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      if (candidate === CODE_RATE_LIMITED) {
        return new DoubaoUpstreamError(
          '豆包触发了人机验证（710022004），需要人工过滑块。',
          CODE_RATE_LIMITED, true, { kind: 'rate_limited', status: 429 },
        )
      }
      if (candidate === CODE_SESSION_DEAD) {
        return new DoubaoUpstreamError(
          '豆包登录态失效（710012001）。', CODE_SESSION_DEAD, false, { kind: 'session_dead', status: 401 },
        )
      }
      if (candidate === CODE_CONTENT_BLOCKED) {
        return new DoubaoUpstreamError(
          '豆包内容审核拦截了这条消息。', CODE_CONTENT_BLOCKED, false, { kind: 'content_blocked', status: 400 },
        )
      }
      if (candidate === CODE_INVALID_PARAM) {
        return new DoubaoUpstreamError(
          `豆包判为非法参数（710020202）：${String(node.message ?? node.msg ?? '')}`.trim(),
          CODE_INVALID_PARAM, false, { kind: 'upstream', status: 400 },
        )
      }
    }
    for (const value of Object.values(node)) {
      const found = walk(value, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(payload, 0)
}

/** 非流式入口：内部就是流式，只是不订阅增量。 */
export async function chat(prompt, options = {}) {
  return streamOnce(prompt, options)
}

/* ------------------------------------------------------------------ 额度 */

/**
 * 额度摘要。
 *
 * 与其它平台的差别：豆包**没有整数积分**，额度是按窗口的百分比 + 上限。
 * 所以这里把「套餐包」那个窗口换算成 `{remaining,total}`，并保留原始窗口
 * 供 UI 显示「还剩 62%，12 小时后重置」。所有 section 都 `usage_exhausted`
 * 才算用尽 —— 只看一个 section 会把有赠送额度的账号误判成用尽。
 */
export function summarizeQuota(rawPayload) {
  // 实测响应把业务数据包在 `data` 里（顶层只有 code/msg）。不拆这一层的话
  // 所有字段都读成 undefined，卡片永远显示「未知」。
  const payload = rawPayload?.data !== undefined && rawPayload.data !== null
    && typeof rawPayload.data === 'object' ? rawPayload.data : rawPayload
  const sections = [
    payload?.window_limit_section,
    payload?.incentive_quota_section,
  ].filter((section) => section !== undefined && section !== null)
  const windows = []
  let exhausted = sections.length > 0
  for (const section of sections) {
    if (section.usage_exhausted !== true) exhausted = false
    for (const group of Array.isArray(section.window_limit_groups) ? section.window_limit_groups : []) {
      for (const limit of Array.isArray(group?.window_limits) ? group.window_limits : []) {
        windows.push(limit)
      }
    }
  }
  if (sections.length === 0) exhausted = false

  const percent = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined
  }
  const packageWindow = windows.find((w) => Number(w?.window_type) === 4)
  const fiveHour = windows.find((w) => Number(w?.window_type) === 1)
  const weekly = windows.find((w) => Number(w?.window_type) === 2)
  const primary = packageWindow ?? weekly ?? fiveHour ?? windows[0]

  const total = nonNegativeInt(primary?.window_limit ?? primary?.quota ?? primary?.total)
  const remainingPercent = percent(primary?.remaining_percent ?? primary?.remainingPercent)
  const remaining = total !== undefined && remainingPercent !== undefined
    ? Math.round((total * remainingPercent) / 100)
    : nonNegativeInt(primary?.remaining ?? primary?.remaining_quota)

  const resetAtMs = positiveInt(primary?.window_end ?? primary?.expire_at ?? primary?.next_reset_at)

  /**
   * 兜底：`quota_remaining_amount` 是字符串形式的整数余额。
   *
   * 实测（2026-11-28）未订阅账号的 `window_limit_section` 是空对象 `{}`，
   * 唯一有数的地方就是这个字段（值为 `"0"`）。没有它的话「额度用尽」和
   * 「字段改了」在界面上长得一样。
   */
  const amountFallback = nonNegativeInt(payload?.quota_remaining_amount)
  const finalRemaining = remaining ?? (amountFallback !== undefined ? amountFallback : null)
  const memberInfo = payload?.member_info ?? {}
  const subscribed = memberInfo.hasActiveSubscription === true
    || memberInfo.hasEnterpriseSubscription === true
    || memberInfo.has_business_subscription === true
    || memberInfo.has_team_subscription === true
    || memberInfo.has_team_lite_subscription === true

  return {
    remaining: finalRemaining,
    total: total ?? null,
    remainingPercent,
    unlimited: false,
    // 没有订阅且余额为 0 就是真的用尽；有订阅但窗口没报用尽则不算
    exhausted: exhausted || (!subscribed && finalRemaining === 0),
    resetAtMs: resetAtMs === undefined ? null : resetAtMs > 1e12 ? resetAtMs : resetAtMs * 1000,
    plan: typeof payload?.current_subscription?.display?.product_name === 'string'
      ? payload.current_subscription.display.product_name
      : typeof payload?.product_line === 'string' ? payload.product_line : undefined,
    subscribed,
    windows: windows.map((w) => ({
      type: Number(w?.window_type),
      label: quotaWindowLabel(Number(w?.window_type)),
      remainingPercent: percent(w?.remaining_percent ?? w?.remainingPercent),
      limit: nonNegativeInt(w?.window_limit ?? w?.quota ?? w?.total),
      endMs: positiveInt(w?.window_end ?? w?.expire_at),
    })),
    fetchedAtMs: Date.now(),
  }
}

function quotaWindowLabel(type) {
  switch (type) {
    case 4: return '订阅套餐'
    case 3: return '赠送额度'
    case 1: return '5 小时窗口'
    case 2: return '每周窗口'
    default: return '额度'
  }
}
