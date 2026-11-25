/**
 * SCNet 适配器（无状态：凭证由上层传入）。
 *
 * **本文件的关键逻辑逐字移植自 dsh-scnet-connect@1.3.2**（MIT），不自己发明：
 * - `ensureApiKey` ← `lib/scnet-platform.js` 同名函数：换 key、以及"模型服务尚未开通"
 *   时自动 `POST /acx/llm/account/config/authorize` 开通一次再重试。
 * - 模型目录 ← `lib/scnet-catalog.js` 的 `createModelCatalog`：**网关 `/models` 只用于
 *   校验可用性**，真正的清单来自客户端目录 `~/.sclaw/agent/models.json`，
 *   默认只注册 `priceLabel === 'free'` 的模型；没有目录时退回内置 `SCNet-Max`。
 * - 模型描述符 ← `lib/scnet-models.js`：1M 上下文 / 131072 输出 / 思考档恒等透传。
 * - 抖动归一化 ← `lib/scnet-fetch.js`，见 `core/retry-fetch.js`。
 *
 * 上游事实：
 * - 网关 `https://api.scnet.cn/api/llm/v1` 标准 OpenAI 兼容，**无需 shim**。
 * - Bearer 是账号级 `sk-` Key（与客户端共用，平台无吊销接口）。
 * - 没有积分/余额端点、没有签到端点 → 胶囊显示「未知」，不显示签到卡。
 * - `SCNet-Max` 免费；旧插件做过一组实测（tokenizer / chat template / 知识边界 /
 *   确定性输出）判定它与 `DeepSeek-V4.1-Flash-1017` 是同一模型，但无法确定是否
 *   更早的 0910 子版本。结论与证据见 `client.js` 的 `SCNET_BASIS`。
 *
 * @module dsh-connect-model-gateway/adapters/scnet
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AdapterError } from '../core/adapter.js'

export const KEY = 'scnet'
export const DISPLAY_NAME = 'SCNet'

const PLATFORM_BASE = 'https://www.scnet.cn'
const GATEWAY_BASE = 'https://api.scnet.cn/api/llm/v1'
const CLIENT_HEADERS = { 'user-agent': 'scnet-client/4.1.0', source: 'Electron', version: '4.1.0' }
const DEFAULT_MODEL_ID = 'SCNet-Max'
const FREE_PRICE_LABEL = 'free'
const DEFAULT_CONTEXT_WINDOW = 1_048_576
const DEFAULT_MAX_TOKENS = 131_072
const TIMEOUT_MS = 20_000
const GATEWAY_TIMEOUT_MS = 10_000

/** 思考等级 → 网关 `reasoning_effort`（旧插件 scnet-models.js 的 THINKING_LEVEL_MAP）。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 目录不可用时的兜底（旧插件 BUILTIN_MODEL：必须带 input，否则平白丢图片能力）。 */
const BUILTIN_MODEL = {
  id: DEFAULT_MODEL_ID,
  name: DEFAULT_MODEL_ID,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
  vision: true,
  badge: null,
  note: '限时免费 · 疑似 DeepSeek-V4.1-Flash 基座',
  promo: { label: '免费' },
  reasoning: true,
  thinkingOptions: THINKING_LEVELS,
  thinkingDefault: 'high',
  canDisableThinking: true,
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function modelsPath() {
  return join(homedir(), '.sclaw', 'agent', 'models.json')
}

/**
 * 读客户端模型目录（**只读，不是登录态**）。
 * 旧插件 scnet-credential.js 的 readClientCatalog：`providers.scnet.models`。
 */
async function readClientCatalog() {
  try {
    const parsed = JSON.parse(await readFile(modelsPath(), 'utf8'))
    const models = parsed?.providers?.scnet?.models
    return Array.isArray(models) ? models.filter((model) => str(model?.id) !== undefined) : []
  } catch {
    return []
  }
}

/** 旧插件 catalogSupportsReasoning：thinkingMode 比 reasoning 更诚实。 */
function supportsReasoning(meta) {
  if (meta === undefined) return true
  if (meta.thinkingMode === 'levels') return true
  if (typeof meta.reasoning === 'boolean') return meta.reasoning
  return true
}

/**
 * 目录条目 → PoolModel（旧插件 scnet-models.js buildModel + normalizeModelEntry）。
 * 注意 vision：目录里没写 input 就按纯文本，不凭空加图片能力。
 */
function toPoolModel(entry, fallback) {
  const id = str(entry?.id)
  if (id === undefined) return undefined
  const input = Array.isArray(entry?.input) ? entry.input : []
  const free = entry?.priceLabel === FREE_PRICE_LABEL
  const isDefaultModel = id.toLowerCase() === DEFAULT_MODEL_ID.toLowerCase()
  const contextWindow = typeof entry?.contextWindow === 'number' && entry.contextWindow > 0
    ? entry.contextWindow
    // 没有目录元数据时：只有 SCNet-Max 按实测的 1M 声明；其它模型不知道真实上限，
    // 保守给 128K —— 声明过大只会在长对话时被上游 400，比浪费窗口更糟。
    : isDefaultModel ? fallback.contextWindow : 131_072
  // 名字必须回退到 **id 本身**：套用 fallback.name 会让网关里的每个模型
  // 都显示成「SCNet-Max」（freeOnly=false 时尤其明显）。
  const name = str(entry?.name) ?? id
  return {
    id,
    name,
    contextWindow,
    // 输出上限不能超过上下文（旧插件 buildModel 的 min 处理）
    maxTokens: typeof entry?.maxTokens === 'number' && entry.maxTokens > 0
      ? Math.min(entry.maxTokens, contextWindow)
      : Math.min(fallback.maxTokens, contextWindow),
    vision: input.includes('image'),
    badge: null, // SCNet 没有倍率字段，只有 priceLabel
    note: free
      ? (id.toLowerCase() === DEFAULT_MODEL_ID.toLowerCase()
        ? '限时免费 · 疑似 DeepSeek-V4.1-Flash 基座'
        : '限时免费')
      : null,
    promo: free ? { label: '免费' } : null,
    // 没有目录元数据时不该声明多模态：网关目录不带 input 字段
    ...(Array.isArray(entry?.input) ? {} : { vision: false }),
    reasoning: supportsReasoning(entry),
    thinkingOptions: THINKING_LEVELS,
    thinkingDefault: 'high',
    canDisableThinking: true,
  }
}

/** 平台请求（旧插件 scnet-platform.js platformRequest）。 */
async function platformRequest(path, credential, options = {}) {
  const headers = {
    ...CLIENT_HEADERS,
    accept: 'application/json',
    cookie: credential?.cookie ?? '',
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
  }
  const response = await fetch(`${PLATFORM_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

/** 取当前账号 id（开通模型服务要用）。失败返回 undefined，不抛。 */
async function resolveAccountId(credential) {
  try {
    const { status, body } = await platformRequest('/acx/user/users/current-user-info?includeToken=true&refresh=true', credential)
    if (status !== 200) return undefined
    const data = body?.data ?? body
    const id = data?.id ?? data?.accountId ?? data?.userId
    return id === undefined || id === null ? undefined : String(id)
  } catch {
    return undefined
  }
}

/**
 * 用会话换 model-service Key —— 照抄旧插件 `ensureApiKey`：
 * 1. 先直接换；
 * 2. 若回「模型服务尚未开通」，开通一次（accountId 必须放 body）再重试**一次**；
 * 3. 仍拿不到 sk- Key 就把平台原话带出来。
 */
export async function ensureApiKey(credential) {
  const cached = str(credential?.apiKey)
  if (cached !== undefined) return { ...credential, apiKey: cached }
  if (str(credential?.cookie) === undefined) {
    throw new AdapterError('SCNet 还没有登录，请先短信登录', { permanent: true })
  }

  const createOnce = () => platformRequest('/acx/llm/api-key/createActivityApiKey', credential, { method: 'POST', body: {} })

  let result = await createOnce()
  const firstMsg = String(result.body?.msg ?? result.body?.message ?? '')
  // 「模型服务尚未开通」→ 开通一次再重试。只重试一次，避免开通失败时死循环。
  if (result.status === 200 && /尚未开通|not\s*(been\s*)?(opened|enabled|activated)/i.test(firstMsg)) {
    const accountId = str(credential.accountId) ?? await resolveAccountId(credential)
    if (accountId !== undefined) {
      try {
        await platformRequest('/acx/llm/account/config/authorize', credential, {
          method: 'POST',
          // accountId 必须放 body：放 query 平台会回 API010006「无权限访问」
          body: { accountId },
        })
      } catch {
        // 开通失败就继续往下走，让调用方看到原始的「尚未开通」
      }
      result = await createOnce()
    }
  }

  if (result.status === 401) throw new AdapterError('SCNet 会话已失效，请重新登录', { status: 401, permanent: true })
  if (result.status !== 200 || result.body === undefined) {
    throw new AdapterError(`SCNet 平台失败（http ${result.status}）：${String(result.body?.msg ?? '').slice(0, 160)}`, {
      status: result.status,
    })
  }
  const data = result.body?.data ?? result.body
  const key = typeof data === 'string' ? data : str(data?.apiKey)
  if (key === undefined || !key.startsWith('sk-')) {
    const msg = str(result.body?.msg) ?? str(result.body?.message)
    throw new AdapterError(msg !== undefined ? `平台返回：${msg}` : '平台没有返回 sk- 开头的模型服务 Key', {
      permanent: true,
    })
  }
  const accountId = str(credential.accountId) ?? await resolveAccountId(credential)
  return {
    ...credential,
    apiKey: key,
    ...(accountId === undefined ? {} : { accountId }),
    ...(str(data?.baseUrl) === undefined ? {} : { baseUrl: str(data.baseUrl) }),
  }
}

/** 网关模型列表（旧插件 fetchGatewayModels）：只用于校验，失败不抛。 */
async function fetchGatewayIds(credential) {
  try {
    const response = await fetch(`${GATEWAY_BASE}/models`, {
      headers: { authorization: `Bearer ${credential.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const body = await response.json()
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const ids = rows
      .map((row) => (typeof row === 'string' ? row : row?.id))
      .filter((id) => typeof id === 'string' && id.trim() !== '')
    if (ids.length === 0) return { ok: false, error: 'empty model list' }
    return { ok: true, ids }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function createScnetAdapter() {
  /**
   * 只注册免费模型 —— 照抄旧插件默认值（`freeOnly: true`）。
   * 关掉后列出账号可用的**全部**模型（旧插件 `freeOnly=false` 的行为）：
   * 此时清单必须来自网关（客户端目录可能有也可能没有），元数据用目录补齐。
   */
  let freeOnly = true

  return {
    /** 供 index.js / 路由切换（旧插件设置页同名开关）。 */
    setFreeOnly(next) {
      freeOnly = next !== false
      return freeOnly
    },
    get freeOnly() {
      return freeOnly
    },

    key: KEY,
    displayName: DISPLAY_NAME,
    fallbackModels: [BUILTIN_MODEL],

    async refresh(credential) {
      return ensureApiKey(credential)
    },

    async probe(credential) {
      if (str(credential?.cookie) === undefined && str(credential?.apiKey) === undefined) return { state: 'signed-out' }
      if (str(credential?.cookie) === undefined) {
        return { state: 'signed-in', account: credential?.account?.userName ?? credential?.accountId }
      }
      // 会话有效性只有平台知道（旧插件 resolveSession）：401 才算过期，
      // 网络错误不该把账号标成过期。
      try {
        const { status, body } = await platformRequest(
          '/acx/user/users/current-user-info?includeToken=true&refresh=true',
          credential,
          { timeoutMs: 12_000 },
        )
        if (status === 401) {
          /**
           * 平台会话（cookie）过期 ≠ 不能用：推理走的是 sk- apiKey，它仍然有效
           * （实测 cookie 401 的同一时刻 GET /models 仍是 200）。
           * 所以有 apiKey 时只标 'expiring' 提醒，不能报 'expired' 让用户以为掉登录。
           * 只有连 apiKey 都没有时，cookie 过期才真的意味着需要重新登录。
           */
          if (str(credential?.apiKey) !== undefined) {
            return {
              state: 'expiring',
              account: credential?.account?.userName,
              detail: '平台会话已过期，但模型密钥仍可用；如要刷新积分/模型请重新认证',
            }
          }
          return { state: 'expired', account: credential?.account?.userName }
        }
        const data = body?.data ?? body ?? {}
        const name = str(data?.userName) ?? str(data?.mobilephoneNum) ?? str(credential?.account?.userName)
        return { state: 'signed-in', account: name, label: name, userId: str(data?.id) }
      } catch {
        return { state: 'signed-in', account: credential?.account?.userName }
      }
    },

    /** SCNet 没有积分/余额端点（旧插件全包 grep 无命中），按用户要求显示「未知」。 */
    async quota() {
      return { remaining: null, fetchedAtMs: Date.now() }
    },

    /**
     * 模型目录 —— 照抄旧插件 createModelCatalog：
     * 优先客户端目录里 `priceLabel === 'free'` 的模型；没有目录就退回内置 SCNet-Max。
     * 网关 `/models` 只做**可用性校验**：能对上的保留，全对不上才保留本地结果
     * （网关口径变了不该把选择器清空）。
     */
    async listModels(credential) {
      const next = await ensureApiKey(credential)
      const catalog = await readClientCatalog()

      let models
      if (freeOnly) {
        // 旧插件默认路径：只有客户端目录里标了 free 的模型，没目录就退回内置
        if (catalog.length > 0) {
          const free = catalog
            .filter((model) => model.priceLabel === FREE_PRICE_LABEL)
            .map((model) => toPoolModel(model, BUILTIN_MODEL))
            .filter(Boolean)
          models = free.length > 0 ? free : [BUILTIN_MODEL]
        } else {
          models = [BUILTIN_MODEL]
        }
      } else {
        // freeOnly=false：列出账号可用的全部模型（网关是唯一能拿到完整清单的地方），
        // 客户端目录里有元数据就用，没有就用默认元数据。
        const byId = new Map(catalog.map((entry) => [String(entry.id).toLowerCase(), entry]))
        const live = await fetchGatewayIds(next)
        if (live.ok === true) {
          models = live.ids
            // embedding / rerank 之类选了会 400，不进选择器
            .filter((id) => !/embedding|rerank|tts|asr|whisper/i.test(id))
            .map((id) => toPoolModel(byId.get(id.toLowerCase()) ?? { id }, BUILTIN_MODEL))
            .filter(Boolean)
        }
        if (models === undefined || models.length === 0) {
          models = catalog.map((entry) => toPoolModel(entry, BUILTIN_MODEL)).filter(Boolean)
        }
        if (models.length === 0) models = [BUILTIN_MODEL]
      }

      // 免费模式下仍用网关校验可用性；全部模式下网关已经是清单来源，不必再校验
      if (freeOnly) {
        const live = await fetchGatewayIds(next)
        if (live.ok === true) {
          const liveSet = new Set(live.ids.map((id) => id.toLowerCase()))
          const kept = models.filter((model) => liveSet.has(model.id.toLowerCase()))
          if (kept.length > 0) models = kept
        }
      }
      return { models, credential: next }
    },

    chatBase() {
      return GATEWAY_BASE
    },

    async inferenceTarget(credential) {
      const next = await ensureApiKey(credential)
      return { baseUrl: str(next.baseUrl) ?? GATEWAY_BASE, apiKey: next.apiKey, credential: next }
    },

    async resolveApiKey(credential) {
      const next = await ensureApiKey(credential)
      return next.apiKey
    },
  }
}
