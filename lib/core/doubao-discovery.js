/**
 * 模型发现：谁是权威、什么时候信它。
 *
 * 三层来源，优先级从高到低：
 *
 * 1. **HTTP `brief_list`** —— 客户端自己画那个下拉菜单时调的接口。离开这个
 *    就没有「新模型」可言：静态目录只会在发版时动，而豆包加模型比发版快。
 * 2. **桌面 Preferences 里的本地存储缓存** —— 客户端把上一次的菜单响应整份
 *    存在 `saman.local_storage_for_web['frontend-request-cache']` 里。接口被
 *    风控挡住时这是唯一的活数据。
 * 3. **静态目录** —— 保底，保证第一次装上就不会是空选择器。
 *
 * 关键设计：**每个模型自己的思考档位才是权威**。豆包菜单给每个模型单独下发
 * `reasoning_effort_config`，GLM 只发低/高/最高，2.1 Lite 发低/中/高。共用
 * 一套全局档位必然有一个模型是错的，所以这里把档位跟着模型走。
 *
 * @module dsh-connect-model-gateway/core/doubao-discovery
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACTION_BAR_BRIEF_LIST_ENDPOINT, CONTEXT_WINDOW, DEFAULT_BOT_ID, KEY, MAX_TOKENS,
  NO_THINKING_MODEL_IDS, REASONING_LEVELS, STATIC_MODELS, UNAVAILABLE_MODEL_IDS,
  IMAGE_MODEL_ID, IMAGE_MODEL_NAME,
} from './doubao-catalog.js'
import { buildHeaders, buildQueryUrl } from './doubao-upstream.js'

/** 发现结果的存活时间。菜单一天也未必变一次，10 分钟足够又不算太钝。 */
export const DISCOVERY_TTL_MS = 10 * 60 * 1000
/** 失败缓存短一些：接口抖一下，不该让用户等十分钟。 */
const DISCOVERY_FAILURE_TTL_MS = 30_000

/** pi-ai 认识的档位 id。自造的拼写会被静默忽略，所以只能在这些里面选。 */
const VALID_LEVEL_IDS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** 「工作任务」模型的菜单名带着这个前缀，用来把它们从对话目录里剔掉。 */
const TASK_MODE_PREFIX = '工作任务'

/* ------------------------------------------------------------------ 解析 */

function looksLikeModelKey(key) {
  if (typeof key !== 'string' || key === '') return false
  if (key.length > 64) return false
  // key 是 slug 或数字枚举，混着的；只挡掉明显是文本的东西
  return !/[\s\r\n]/.test(key)
}

function looksLikeModelName(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 40) return false
  return true
}

/**
 * 价格标签。
 *
 * 显示用途，插件既不收钱也无法核实服务端真会收多少，所以原样展示并注明出处。
 */
function rateOf(tags) {
  if (!Array.isArray(tags)) return undefined
  for (const tag of tags) {
    const text = typeof tag === 'string' ? tag : typeof tag?.text === 'string' ? tag.text : ''
    if (text === '') continue
    if (/x\b|\d+(\.\d+)?\s*[x×]/i.test(text)) return { text, kind: 'ratio' }
    if (/限时|优惠|活动/.test(text)) return { text, kind: 'promo' }
  }
  return undefined
}

/**
 * 单模型的思考档位列表。
 *
 * 数组里是豆包自己的 ordinal（低=3…最高=7），**原样透传**，不要重排序也不要
 * 补全：菜单没给的档位就是那个模型不支持，补上只会让用户选到一个静默降级的
 * 档位。
 */
function reasoningOptionsOf(config) {
  if (config === undefined || config === null) return undefined
  // 实测字段：reasoning_effort_config = { default_level, option_list: [{level, name}] }
  const raw = Array.isArray(config) ? config
    : Array.isArray(config.option_list) ? config.option_list
      : Array.isArray(config.levels) ? config.levels
        : Array.isArray(config.options) ? config.options
          : Array.isArray(config.effort_list) ? config.effort_list : undefined
  if (raw === undefined) return undefined
  const out = []
  for (const item of raw) {
    const level = Number(item?.level ?? item?.value ?? item?.effort)
    if (!Number.isFinite(level)) continue
    const name = typeof item?.name === 'string' && item.name.trim() !== ''
      ? item.name.trim()
      : REASONING_LEVELS.find((known) => known.level === level)?.name ?? String(level)
    if (out.some((known) => known.level === level)) continue
    out.push({ level, name })
  }
  return out.length === 0 ? undefined : out
}

/** 菜单给该模型声明的默认档位（`reasoning_effort_config.default_level`）。 */
function defaultLevelOf(config) {
  if (config === undefined || config === null || Array.isArray(config)) return undefined
  const level = Number(config.default_level)
  return Number.isFinite(level) ? level : undefined
}

function parseMenuItems(items) {
  if (!Array.isArray(items)) return []
  const out = []
  for (const item of items) {
    const key = typeof item?.model_item_key === 'string' ? item.model_item_key : undefined
    const name = typeof item?.name === 'string' ? item.name : undefined
    if (key === undefined || name === undefined) continue
    if (!looksLikeModelKey(key) || !looksLikeModelName(name)) continue
    if (out.some((known) => known.key === key)) continue
    const rate = rateOf(item.tag_list)
    const reasoningOptions = reasoningOptionsOf(item.reasoning_effort_config)
    const defaultLevel = defaultLevelOf(item.reasoning_effort_config)
    out.push({
      key,
      name: name.trim(),
      /**
       * 只按名字判「工作任务」。
       *
       * 旧实现还看 `default_mode === '3'`，但实测这个字段在该菜单里**全是 3**
       * （2026-11-28 抓包，16 个条目无一例外，含 DeepSeek/GLM/Kimi/Qwen 等
       * 普通对话模型）。照那个判据会把整个目录剔空，选择器里一个模型都不剩。
       * 菜单名带「工作任务」前缀才是可靠信号。
       */
      taskOnly: name.startsWith(TASK_MODE_PREFIX),
      ...(rate === undefined ? {} : { rate }),
      ...(reasoningOptions === undefined ? {} : { reasoningOptions }),
      ...(defaultLevel === undefined ? {} : { defaultLevel }),
    })
  }
  return out
}

/**
 * 解析 `POST /alice/slot/action_bar_v3/brief_list`。
 *
 * 深度思考那一条（`action_bar_key === 'coco_deep_thinking'`）排最前：它是
 * 对话模式的模型菜单，其余的 bar 可能挂着别的东西。
 */
export function parseBriefListResponse(payload) {
  const entries = payload?.data?.entry_list
  if (!Array.isArray(entries)) return []
  const ordered = [
    ...entries.filter((entry) => entry?.action_bar_key === 'coco_deep_thinking'),
    ...entries.filter((entry) => entry?.action_bar_key !== 'coco_deep_thinking'),
  ]
  const out = []
  const seen = new Set()
  for (const entry of ordered) {
    const items = entry?.active_switch_conf?.menu_conf_v2?.model_list?.item_list
      ?? entry?.active_switch_conf?.menu_conf?.item_list
    for (const parsed of parseMenuItems(items)) {
      if (seen.has(parsed.key)) continue
      seen.add(parsed.key)
      out.push(parsed)
    }
  }
  return out
}

/* ------------------------------------------------------------------ 本地缓存 */

/** 桌面客户端的 userData 目录候选。 */
function doubaoUserDataCandidates() {
  const home = homedir()
  const out = []
  if (process.platform === 'darwin') {
    out.push(join(home, 'Library', 'Application Support', 'Doubao'))
    out.push(join(home, 'Library', 'Application Support', '豆包'))
    out.push(join(home, 'Library', 'Application Support', 'doubao'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    out.push(join(appData, 'Doubao'))
    out.push(join(appData, '豆包'))
  } else {
    out.push(join(home, '.config', 'Doubao'))
  }
  return out
}

/** 从 `Default/Preferences` 的本地存储缓存里捞菜单响应。 */
function readPreferencesEntries(userData) {
  let raw
  try {
    raw = readFileSync(join(userData, 'Default', 'Preferences'), 'utf8')
  } catch {
    return []
  }
  let bucket
  try {
    const prefs = JSON.parse(raw)
    bucket = prefs?.saman?.local_storage_for_web?.['frontend-request-cache']
    if (typeof bucket !== 'string') return []
  } catch {
    return []
  }
  let cache
  try {
    cache = JSON.parse(bucket)
  } catch {
    return []
  }
  const out = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 8) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    // 缓存条目本身就是一份响应体：带 entry_list 的就是要找的那个
    if (Array.isArray(node.entry_list)) {
      for (const parsed of parseMenuItems(node.entry_list.flatMap?.((entry) => {
        const items = entry?.active_switch_conf?.menu_conf_v2?.model_list?.item_list
          ?? entry?.active_switch_conf?.menu_conf?.item_list
        return Array.isArray(items) ? [items] : []
      }).flat() ?? [])) {
        if (seen.has(parsed.key)) continue
        seen.add(parsed.key)
        out.push(parsed)
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1)
  }
  walk(cache, 0)
  return out
}

/** 扫所有候选目录，合并去重。 */
export function discoverAllCachedModels() {
  const out = []
  const seen = new Set()
  for (const dir of doubaoUserDataCandidates()) {
    for (const entry of readPreferencesEntries(dir)) {
      if (seen.has(entry.key)) continue
      seen.add(entry.key)
      out.push(entry)
    }
  }
  return out
}

/* ------------------------------------------------------------------ HTTP 发现 */

/**
 * 调 `brief_list`。
 *
 * 这个接口要登录态，但**不需要**签名参数 —— 与 chat 端点同一套 cookie 就能
 * 调通。风控挡住时返回空数组而不是抛错：发现失败不该让整个平台变红。
 */
export async function fetchLiveModels(credentials, options = {}) {
  const headers = buildHeaders(credentials, {
    fingerprint: options.fingerprint,
    extra: { 'content-type': 'application/json' },
  })
  const url = buildQueryUrl(ACTION_BAR_BRIEF_LIST_ENDPOINT)
  const body = JSON.stringify({ language_code: 'zh', bot_id: DEFAULT_BOT_ID })
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
    })
  } catch (error) {
    throw new Error(`发现豆包模型失败：${error?.message ?? error}`)
  }
  if (!response.ok) throw new Error(`发现豆包模型失败：HTTP ${response.status}`)
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new Error(`发现豆包模型失败：响应不是 JSON（${error?.message ?? error}）`)
  }
  return parseBriefListResponse(payload)
}

/* ------------------------------------------------------------------ 归一 */

/**
 * 一条发现结果 → 魔桥的 PoolModel。
 *
 * 这里做三件归一化：
 * - 「工作任务」模型剔掉：它们要客户端进程里的运行时，接上就是每次失败；
 * - `NO_THINKING_MODEL_IDS` 强制不声明 reasoning：旋钮摆在那里却不起作用是
 *   更糟的谎言；
 * - 思考档位跟模型走，缺省才用全局那五档。
 */
export function toPoolModel(entry) {
  const id = entry.key
  if (id === undefined) return undefined
  if (UNAVAILABLE_MODEL_IDS.has(id)) return undefined
  if (entry.taskOnly === true) return undefined

  const reasoning = NO_THINKING_MODEL_IDS.has(id) ? false : true
  const levels = entry.reasoningOptions !== undefined
    ? entry.reasoningOptions
    : reasoning ? REASONING_LEVELS.map((level) => ({ level: level.level, name: level.name })) : []

  return {
    id,
    name: entry.name,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    vision: true,
    reasoning,
    // 魔桥的选择器认 id 字符串（low/mid/high/xhigh/max），所以把豆包 ordinal
    // 换回名字；菜单给了非标准 ordinal 就保留十进制拼写，别丢档位
    // 一档一名：ordinal 2 与 3 都折到 low（菜单里 GLM 5.3 Flash 同时给了 2 和 3），
    // 不去重会在选择器里出现两个「低」，选哪个都发同一个 ordinal。
    thinkingOptions: dedupeById(
      levels
        .map((level) => ({ id: levelIdOfLevel(level.level), name: level.name, ordinal: level.level }))
        // 过滤掉不在 pi-ai 合法集合里的档位：留着只会让选择器显示一个假档位
        .filter((level) => VALID_LEVEL_IDS.has(level.id)),
    ).map(({ id, name }) => ({ id, name })),
    // 菜单给了 default_level 就用它（已折到合法 id 且确认在可选集里）
    thinkingDefault: defaultLevelOf2(entry, levels),
    badge: entry.rate === undefined ? (STATIC_MODELS.find((model) => model.id === id)?.badge ?? null) : entry.rate.text,
    ...(entry.rate?.kind === 'promo' ? { promo: { label: entry.rate.text } } : {}),
  }
}

/**
 * 豆包 ordinal → pi-ai 的档位 id。
 *
 * **必须用 pi-ai 的词汇**（minimal/low/medium/high/xhigh/max）：选择器与
 * `reasoning_effort` 都走这一套，`mid` 这种自造拼写不在合法集合里，写进去
 * 会被静默丢掉，用户选了「中」实际发的是默认档。豆包自己的名字（低/中/高/
 * 极高/最高）只放在 `name` 里给人看。
 */
const LEVEL_ID_BY_ORDINAL = {
  1: 'minimal', 2: 'low', 3: 'low', 4: 'medium', 5: 'high', 6: 'xhigh', 7: 'max',
}

/**
 * 有序的 ordinal → pi 档位对照，供「就近取整」使用。
 *
 * 为什么需要就近取整：菜单给每个模型的档位是**子集**（实测 Qwen 4 Max 只有
 * 3/5/6，DeepSeek V4 Pro 只有 1/3/5/7）。用户手上只有 pi 的六档拼写，如果
 * 直接按固定映射翻成 ordinal（比如 high→5），对没声明 5 的模型就发了一个它
 * 不支持的档位，上游静默按默认跑。
 */
const ORDINAL_LADDER = [1, 2, 3, 4, 5, 6, 7]

/**
 * 把用户选的 pi 档位折到该模型真实声明过的 ordinal 上。
 *
 * @param {string|undefined} id        pi 档位拼写（low/medium/high/xhigh/max…）
 * @param {number[]|undefined} allowed 该模型声明过的 ordinal；空/缺省表示全档
 */
export function nearestOrdinal(id, allowed) {
  const wanted = levelOfId(id)
  const pool = Array.isArray(allowed) && allowed.length > 0
    ? allowed.filter((level) => ORDINAL_LADDER.includes(level)).sort((a, b) => a - b)
    : ORDINAL_LADDER
  if (pool.length === 0) return wanted ?? 5
  if (wanted !== undefined && pool.includes(wanted)) return wanted
  // 不在集合里就取最近的一档；等距时取更高的一档（宁可多想，不要少想）
  let best = pool[0]
  let bestDistance = Math.abs(best - (wanted ?? 5))
  for (const level of pool) {
    const distance = Math.abs(level - (wanted ?? 5))
    if (distance < bestDistance || (distance === bestDistance && level > best)) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

export function levelIdOfLevel(level) {
  return LEVEL_ID_BY_ORDINAL[level] ?? String(level)
}

/** 魔桥档位 id → 豆包 ordinal。pi-ai 自己的拼写也在这里折到最近的档。 */
export function levelOfId(id) {
  switch (id) {
    case 'minimal':
    case 'low': return 3
    case 'medium':
    case 'mid': return 4
    case 'high': return 5
    case 'xhigh': return 6
    case 'max': return 7
    default: {
      const n = Number(id)
      return Number.isFinite(n) ? n : undefined
    }
  }
}

/** 按 id 去重，保留第一次出现（菜单顺序即优先级）。 */
function dedupeById(levels) {
  const seen = new Set()
  const out = []
  for (const level of levels) {
    if (seen.has(level.id)) continue
    seen.add(level.id)
    out.push(level)
  }
  return out
}

/** 菜单声明的默认档位 → 合法 id；不在可选集里则退到就近策略。 */
function defaultLevelOf2(entry, levels) {
  const declared = entry.defaultLevel
  if (declared !== undefined && levels.some((level) => level.level === declared)) {
    return levelIdOfLevel(declared)
  }
  return defaultLevelIdOf(levels)
}

/** 默认档位：给「高」，但它不在该模型的可选集里时退到最接近的一档。 */
function defaultLevelIdOf(levels) {
  if (levels.length === 0) return undefined
  const preferred = levels.find((level) => level.level === 5)
  if (preferred !== undefined) return levelIdOfLevel(preferred.level)
  return levelIdOfLevel(levels[levels.length - 1].level)
}

/**
 * 生图别名条目。
 *
 * 它与真实模型的区别：`id` 不是豆包 key，`vision:false`（它**生成**图而不是读
 * 图，声明 vision 会让 DSH 在带附件时优先选它，然后附件被丢掉），`reasoning`
 * 声明为真但档位留空 —— 生图轮的思考开关由 `buildChatBody` 强制关掉。
 */
export function imageModelPoolModel(name = IMAGE_MODEL_NAME) {
  return {
    id: IMAGE_MODEL_ID,
    name,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    vision: false,
    reasoning: false,
    thinkingOptions: [],
    badge: '生图',
    note: '选中后这条消息会被画成图片（Seedream）',
    imageGen: true,
  }
}

/* ------------------------------------------------------------------ 缓存 */

let cache
let cacheAt = 0
let lastFailure

/**
 * 当前可用模型。
 *
 * 顺序固定：真实模型在前（按菜单顺序），生图别名最后 —— 它是能力不是模型，
 * 排在真实模型前面会让用户以为豆包主推生图。
 */
export function discoverModels(options = {}) {
  const now = Date.now()
  if (!options.force && cache !== undefined && now - cacheAt < DISCOVERY_TTL_MS) return cache
  if (!options.force && lastFailure !== undefined && now - lastFailure.at < DISCOVERY_FAILURE_TTL_MS) {
    return cache ?? staticModels()
  }
  void lastFailure
  return cache ?? staticModels()
}

/** 静态目录（HTTP 与本地缓存都不可用时的保底）。 */
export function staticModels() {
  const out = []
  for (const model of STATIC_MODELS) {
    if (model.id === IMAGE_MODEL_ID) continue
    if (model.taskMode === true) continue
    const pool = toPoolModel({ key: model.id, name: model.name, ...(model.badge === undefined ? {} : { rate: { text: model.badge, kind: 'promo' } }) })
    if (pool !== undefined) out.push(pool)
  }
  out.push(imageModelPoolModel())
  return out
}

/**
 * 真正去刷新：HTTP 优先，失败退本地缓存，再失败退静态。
 *
 * 返回 `{ models, source }`。`source` 给设置页显示「模型列表来自哪里」，让
 * 「为什么少了一个模型」这类问题能自查。
 */
export async function refreshDiscovery(credentials, options = {}) {
  const now = Date.now()
  let source = 'static'
  let entries = []
  if (credentials?.ok === true) {
    try {
      entries = await fetchLiveModels(credentials, options)
      if (entries.length > 0) source = 'live'
    } catch (error) {
      lastFailure = { at: now, message: error?.message ?? String(error) }
    }
  }
  if (entries.length === 0) {
    entries = discoverAllCachedModels()
    if (entries.length > 0) source = 'cache'
  }

  const models = []
  const seen = new Set()
  for (const entry of entries) {
    const pool = toPoolModel(entry)
    if (pool === undefined || seen.has(pool.id)) continue
    seen.add(pool.id)
    models.push(pool)
  }
  if (models.length === 0) {
    cache = staticModels()
    cacheAt = now
    return { models: cache, source: 'static' }
  }
  models.push(imageModelPoolModel())
  cache = models
  cacheAt = now
  return { models, source }
}

export function invalidateDiscovery() {
  cache = undefined
  cacheAt = 0
  lastFailure = undefined
}

/** 诊断用：上次发现失败的原因（不含机密）。 */
export function discoveryDiagnostics() {
  return {
    cached: cache !== undefined,
    cachedAtMs: cacheAt === 0 ? null : cacheAt,
    failure: lastFailure ?? null,
  }
}

export { KEY }
