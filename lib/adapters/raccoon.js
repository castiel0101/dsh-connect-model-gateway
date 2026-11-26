/**
 * 商汤小浣熊适配器（无状态：凭证由上层传入）。
 *
 * 协议事实来自两处，都已实测核对：
 * 1. `zhlcba/dsh-raccoon-connect`（MIT）的 `docs/upstream-protocol.md` 与 `src/upstream.ts`；
 * 2. 本机 2026-11-26 真实请求：目录 7 条可见模型、余额接口 `available_points`。
 *
 * 与旧插件的关键差异（都会影响实现，别照抄）：
 * - 旧插件读**桌面端** `~/.box-agent/config/auth.json`；本插件走**网页扫码登录**拿
 *   `access_token`，所以 `X-Client-Platform` 是 `web` 而不是 `desktop`。
 * - 网页 token 实测有效期 **30 天**（`exp - iat = 720h`），旧插件文档写的是 3 小时；
 *   网页版登录响应里**没有 refresh_token**，因此不做静默续期，过期只能重新扫码。
 * - 网关 `https://xiaohuanxiong.com/api/web/llm/v2` 是标准 OpenAI 兼容，**无需 shim**。
 * - 认证走 `Authorization: Bearer <access_token>`，**不是 cookie**
 *   （实测：带 cookie 不带 Authorization 会回 `200001 authorization_empty_error`）。
 *
 * 上游易变点（改版先查这里）：
 * - `model_catalog` 的 `data.categories[].type === "chat"` 与 `billing_*` 命名；
 * - `points/v1/balance` 的 `available_points`；
 * - 业务错误码：会话失效 `200001/200003/200822`、额度耗尽 `200402/200429/100402`。
 *
 * @module dsh-connect-model-gateway/adapters/raccoon
 */

import { AdapterError } from '../core/adapter.js'

export const KEY = 'raccoon'
export const DISPLAY_NAME = '商汤小浣熊'

const SITE = 'https://xiaohuanxiong.com'
const LLM_BASE = `${SITE}/api/web/llm/v2`
const TIMEOUT_MS = 20_000

/** 网页端请求头。`X-Org-Code` 留空是个人版的正常值（旧插件文档 §3 已记）。 */
const CLIENT_HEADERS = {
  'X-Org-Code': '',
  'X-Raccoon-Language': 'zh',
  'X-Client-Platform': 'web',
}

/** 会话彻底失效的业务码。 */
const SESSION_DEAD_CODES = new Set(['200001', '200003', '200822'])
/** 额度耗尽的业务码与文案。 */
const CREDIT_CODES = new Set(['200402', '200429', '100402'])
const CREDIT_PHRASES = ['积分不足', '余额不足', '点数不足', 'quota exceeded', 'insufficient balance', 'insufficient points']
/** 限流文案（上游用 400 + 中文提示，不给 429）。 */
const RATE_PHRASES = ['频繁', 'too many requests', 'rate limit']

/**
 * 模型显示名。上游 id 形如 `sn-glm-5-3`，直接进选择器很难看，
 * 所以按 id 映射成产品名；没收录的 id 原样显示（上游加新模型时不会显示成空白）。
 */
const MODEL_LABELS = {
  'sn-glm-5-3': 'GLM-5.3',
  'sn-glm-5-3-flash': 'GLM-5.3-Flash',
  'sn-sensenova-6-8-flash': 'SenseNova-6.8-Flash',
  'sn-sensenova-6-8-flash-lite': 'SenseNova-6.8-Flash-Lite',
  'sn-qwen4-max': 'Qwen4-Max',
  'sn-kimi-k3-1-pro': 'Kimi-K3.1-Pro',
  'sn-deepseek-v4-1-flash-1017': 'DeepSeek-V4.1-Flash',
}

/**
 * 识图能力的实测结论，优先于目录 `tags`。
 * 旧插件实测（`dsh-raccoon-connect` catalog.ts 的 MEASURED_VISION）：目录的 `vision`
 * 标签两个方向都错过 —— GLM-5.3 标着有却看不了图，GLM-5.3-Flash 与
 * DeepSeek-V4.1-Flash 没标却能看。这里按实测写死，标签只做兜底。
 */
const MEASURED_VISION = {
  'sn-glm-5-3': false,
  'sn-glm-5-3-flash': true,
  'sn-deepseek-v4-1-flash-1017': true,
}

/** 目录拿不到时的兜底：取实测目录里最便宜的三条，保证首次可用不为空。 */
const FALLBACK_MODELS = [
  {
    id: 'sn-glm-5-3-flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    vision: true,
    badge: 'x0.2',
    note: null,
    reasoning: true,
  },
  {
    id: 'sn-deepseek-v4-1-flash-1017',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    vision: true,
    badge: 'x0.25',
    note: null,
    reasoning: true,
  },
  {
    id: 'sn-sensenova-6-8-flash',
    name: 'SenseNova-6.8-Flash',
    contextWindow: 256_000,
    maxTokens: 63_999,
    vision: true,
    badge: null,
    note: '限时免费',
    promo: { label: '限时免费' },
    reasoning: false,
  },
]

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function positiveInt(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined
}

/** 倍率显示：去掉多余的 0（0.20 → 0.2，1.00 → 1）。 */
function multiplierText(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return String(Number(n.toFixed(4)))
}

function accessTokenOf(credential) {
  return str(credential?.accessToken) ?? str(credential?.token)
}

/** JWT 里的 exp（毫秒）；解不出来返回 undefined。 */
export function tokenExpiryMs(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const exp = Number(payload?.exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** 业务码 / 文案 → 我们自己的失败分类。 */
function classify(status, json, text) {
  const code = str(json?.code) ?? (typeof json?.code === 'number' ? String(json.code) : undefined)
  const message = str(json?.message) ?? str(json?.details) ?? str(json?.msg) ?? ''
  const haystack = `${message} ${text ?? ''}`.toLowerCase()
  if (code !== undefined && SESSION_DEAD_CODES.has(code)) return { kind: 'auth', status: 401, message }
  if (status === 401 || status === 403) return { kind: 'auth', status: 401, message }
  if ((code !== undefined && CREDIT_CODES.has(code)) || CREDIT_PHRASES.some((p) => haystack.includes(p.toLowerCase()))) {
    return { kind: 'credit', status: 402, message }
  }
  if (status === 429 || RATE_PHRASES.some((p) => haystack.includes(p.toLowerCase()))) {
    return { kind: 'rate', status: 429, message }
  }
  if (status >= 500) return { kind: 'server', status: 502, message }
  return { kind: 'client', status: 400, message }
}

/** 上游通用请求：返回 { status, json, text }，4xx 也会拿到 body（业务码在里面）。 */
async function request(path, credential, options = {}) {
  const token = accessTokenOf(credential)
  if (token === undefined) {
    throw new AdapterError('还没有登录小浣熊', { kind: 'auth', status: 401, permanent: true })
  }
  const response = await fetch(`${SITE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...CLIENT_HEADERS,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: response.status, json: parsed, text }
}

/** 成功请求取 data；失败按业务码抛 AdapterError。 */
async function requestData(path, credential, options = {}) {
  const { status, json, text } = await request(path, credential, options)
  // 上游成功时 code 为 0；没有 code 字段的接口（points）也按成功处理
  const code = json?.code
  const ok = status >= 200 && status < 300 && (code === undefined || code === 0 || code === '0')
  if (!ok) {
    const failure = classify(status, json, text)
    throw new AdapterError(failure.message || `HTTP ${status}`, {
      kind: failure.kind,
      status: failure.status,
      permanent: failure.kind === 'auth',
    })
  }
  const data = json?.data
  return typeof data === 'object' && data !== null ? data : {}
}

/**
 * 目录条目 → PoolModel。
 *
 * 上游字段（实测）：`name`、`visible`、`tags[]`、`params.context_window`、
 * `params.max_tokens`、`billing_multiplier`、`billing_effective_multiplier`、
 * `billing_status`（normal / discount / limited_free）、`billing_status_note`。
 */
function toPoolModel(entry) {
  const id = str(entry?.name) ?? str(entry?.model_name)
  if (id === undefined) return undefined
  // 应用内建路由位（raccoon-xxxxxx）不是可对话模型，进选择器只会点到就失败
  if (id.startsWith('raccoon-')) return undefined
  if (entry?.visible === false) return undefined

  const params = entry?.params ?? {}
  const contextWindow = positiveInt(params.context_window) ?? 128_000
  const maxTokens = Math.min(positiveInt(params.max_tokens) ?? 32_000, contextWindow)
  const tags = Array.isArray(entry?.tags) ? entry.tags : []
  const measured = MEASURED_VISION[id]
  const vision = typeof measured === 'boolean'
    ? measured
    : tags.includes('vision') || tags.includes('image') || tags.includes('image-understanding')

  const status = str(entry?.billing_status) ?? 'normal'
  const listMultiplier = Number(entry?.billing_multiplier)
  const effectiveMultiplier = Number(entry?.billing_effective_multiplier)
  const free = status === 'limited_free' || (Number.isFinite(effectiveMultiplier) && effectiveMultiplier === 0)
  // 促销时才把折后价写进倍率；正常价用原价，免得两列数字看起来不一样
  const shownMultiplier = free
    ? undefined
    : multiplierText(Number.isFinite(effectiveMultiplier) ? effectiveMultiplier : listMultiplier)
  const note = free
    ? (str(entry?.billing_status_note) ?? '限时免费')
    : status === 'discount'
      ? (str(entry?.billing_status_note) ?? '折扣中')
      : null

  return {
    id,
    name: MODEL_LABELS[id] ?? id,
    contextWindow,
    maxTokens,
    vision,
    badge: shownMultiplier === undefined ? null : `x${shownMultiplier}`,
    note,
    promo: free ? { label: note ?? '限时免费' } : null,
    reasoning: tags.includes('reasoning'),
  }
}

/** 解析目录文档：只取 `type === "chat"` 那一组。 */
export function parseCatalog(document) {
  const categories = document?.categories
  if (!Array.isArray(categories)) return []
  const chat = categories.find((category) => str(category?.type) === 'chat')
  const models = Array.isArray(chat?.models) ? chat.models : []
  const out = []
  for (const entry of models) {
    const model = toPoolModel(entry)
    if (model !== undefined) out.push(model)
  }
  return out
}

export function createRaccoonAdapter() {
  return {
    key: KEY,
    displayName: DISPLAY_NAME,
    fallbackModels: FALLBACK_MODELS,

    /**
     * 网页版登录没有 refresh_token，token 也不会轮转（30 天有效）——
     * 所以「续期」就是原样返回，避免 manager 的通用路径把 undefined 当凭证。
     */
    async refresh(credential) {
      return credential
    },

    async probe(credential) {
      if (accessTokenOf(credential) === undefined) return { state: 'signed-out' }
      const expiresAtMs = Number(credential?.expiresAtMs) || tokenExpiryMs(accessTokenOf(credential)) || 0
      if (expiresAtMs > 0 && expiresAtMs <= Date.now()) {
        return { state: 'expired', account: credential?.nickname, detail: '登录已过期（30 天），重新扫码即可' }
      }
      try {
        const data = await requestData('/api/web/auth/v1/user_info', credential)
        const account = str(data?.name) ?? str(credential?.nickname)
        // 剩不到一天就提醒，但不阻断：token 过期前一直能用
        if (expiresAtMs > 0 && expiresAtMs - Date.now() < 24 * 3600_000) {
          return { state: 'expiring', account, detail: '登录态不足 1 天，建议重新扫码' }
        }
        return { state: 'signed-in', account }
      } catch (error) {
        // 只有上游明说会话失效才算过期；网络抖动不该把账号标成掉登录
        if (error?.kind === 'auth') return { state: 'expired', account: credential?.nickname }
        return { state: 'signed-in', account: credential?.nickname }
      }
    },

    /** 积分：`data.available_points`（实测 3298）。 */
    async quota(credential) {
      const data = await requestData('/api/web/points/v1/balance', credential)
      const remaining = positiveInt(data?.available_points) ?? positiveInt(data?.total) ?? null
      return {
        remaining: remaining === undefined ? null : remaining,
        total: null,
        fetchedAtMs: Date.now(),
      }
    },

    async listModels(credential) {
      const data = await requestData('/api/web/llm/v2/model_catalog', credential)
      const models = parseCatalog(data)
      if (models.length === 0) {
        // 空目录不能当成功：否则选择器被清空，看起来像插件坏了
        throw new AdapterError('上游模型目录为空', { kind: 'upstream', status: 502 })
      }
      return { models, credential }
    },

    chatBase() {
      return LLM_BASE
    },

    /** 直连网关：baseUrl 已含 `/llm/v2`，apiKey 就是 access_token。 */
    async inferenceTarget(credential) {
      const token = accessTokenOf(credential)
      if (token === undefined) throw new AdapterError('还没有登录小浣熊', { kind: 'auth', status: 401, permanent: true })
      return { baseUrl: LLM_BASE, apiKey: token, credential }
    },

    async resolveApiKey(credential) {
      const token = accessTokenOf(credential)
      if (token === undefined) throw new AdapterError('还没有登录小浣熊', { kind: 'auth', status: 401, permanent: true })
      return token
    },
  }
}

/**
 * 登录完成后用 token 换账号资料（昵称 / 稳定 id）。
 *
 * 这一步是「锦上添花」：`user_info` 打不通（改版、临时限流）时不能让整个登录
 * 失败 —— token 本身已经是有效登录态，账号先落库，昵称下次刷新再补。
 * 否则用户扫完码会卡在「已取到登录态，但读取账号资料失败」直到超时。
 */
export async function accountFromToken(token) {
  const credential = { accessToken: token, expiresAtMs: tokenExpiryMs(token) ?? 0 }
  let data = {}
  try {
    data = await requestData('/api/web/auth/v1/user_info', credential)
  } catch {
    // 拿不到身份不阻断登录
  }
  const nickname = str(data?.name) ?? str(data?.nickname) ?? '小浣熊账号'
  const userId = str(data?.id) ?? str(data?.uuid) ?? undefined
  const id = userId === undefined ? `rc_${token.slice(-12)}` : `rc_${userId}`
  return {
    id,
    label: nickname,
    credential: { ...credential, userId, nickname },
  }
}