/**
 * Meoo 秒悟适配器（无状态：凭证由上层传入，适配器只跟上游说话）。
 *
 * 上游事实（2026-11 对照 dsh-connect-meoo@0.0.6 编译产物逐字移植）：
 * - 控制面 https://meoo.com，必须带 x-meoo-client: cli / x-meoo-cli-version: 0.5.6；
 *   **业务错误包在 HTTP 200 里**（success:false + errCode），只看 res.ok 会误判。
 * - 凭据三种：API Key（meoo_ak_…，控制面，可读积分）、OAuth(PKCE) token（控制面，
 *   可读积分，1 小时续期）、项目服务 AK（meoo_project_service_v1.…，仅网关，
 *   **读不到积分**）。
 * - 网关 https://api.meoo.host/meoo-ai/compatible-mode/v1 本身 OpenAI 兼容，
 *   pi-ai 直连，**没有本地 shim**；网关 Bearer 只认项目服务 AK。
 * - API Key 打 /api/v1/agent/models 会 403 API_KEY_ROUTE_FORBIDDEN。
 * - 官网富目录 /api/v1/agent/models 的 id 必须用 modelsValue[key]（网关 id），
 *   用 key 会 404/400；auto 条目跳过。
 * - 上下文按 240000 起（官网保守写 200000，实测 32 万中文命中；网关请求体
 *   约 1MiB 上限，240K≈960KB 留余量）。
 *
 * @module dsh-connect-model-gateway/adapters/meoo
 */

import { AdapterError } from '../core/adapter.js'

export const KEY = 'meoo'
export const DISPLAY_NAME = 'Meoo 秒悟'

const API_BASE = 'https://meoo.com'
const GATEWAY_BASE = 'https://api.meoo.host/meoo-ai/compatible-mode/v1'
const CLI_HEADERS = { 'x-meoo-client': 'cli', 'x-meoo-cli-version': '0.5.6' }
const CONTROL_TIMEOUT_MS = 45_000
const GATEWAY_TIMEOUT_MS = 25_000
const CONTEXT_WINDOW_FLOOR = 240_000
/** 每日登录赠送的积分（官网口径 2000/天，有效期 7 天）。 */
const DAILY_LOGIN_CREDIT = 2000

const PRICE_LABELS = {
  cheap: '便宜',
  moderate: '适中',
  expensive: '较贵',
  veryExpensive: '超贵',
}

const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: CONTEXT_WINDOW_FLOOR, maxTokens: 64_000, vision: true, reasoning: true },
  { id: 'deepseek-v4.1-pro', name: 'DeepSeek V4.1 Pro', contextWindow: CONTEXT_WINDOW_FLOOR, maxTokens: 64_000, vision: false, reasoning: true },
]

/** 续期并发去重：同一 refresh token 只打一次上游。 */
const renewing = new Map()

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function positiveInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

function apiBaseOf(credential) {
  return str(credential?.apiBaseUrl)?.replace(/\/+$/, '') ?? API_BASE
}

function gatewayBaseOf(credential) {
  return str(credential?.gatewayBaseUrl)?.replace(/\/+$/, '') ?? GATEWAY_BASE
}

function isApiKey(credential) {
  const key = str(credential?.apiKey)
  return key !== undefined && key.startsWith('meoo_ak_')
}

function hasControlCredential(credential) {
  return isApiKey(credential) || str(credential?.accessToken) !== undefined
}

function parseJson(text) {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

function vendorMessage(json, text) {
  if (json !== undefined) {
    // OAuth 错误体是 { error, error_description }，比 detail/message 更具体
    for (const key of ['error_description', 'detail', 'message', 'msg', 'title', 'error']) {
      const value = str(json[key])
      if (value !== undefined) return value
    }
    const code = str(json.errCode) ?? str(json.code)
    if (code !== undefined) return code
  }
  return text.slice(0, 180)
}

/** 控制面通用请求：取 data 字段、401 续一次重试、业务错误当失败。 */
async function controlRequest(credential, method, path, body) {
  const apiKey = str(credential.apiKey)
  const access = apiKey ?? await ensureAccess(credential)
  const send = async (token) => {
    const response = await fetch(`${apiBaseOf(credential)}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...CLI_HEADERS,
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
    return { response, text: await response.text().catch(() => '') }
  }

  let { response, text } = await send(access)
  if (response.status === 401 && apiKey === undefined && str(credential.refreshToken) !== undefined) {
    await refreshAccess(credential)
    ;({ response, text } = await send(str(credential.accessToken) ?? ''))
  }
  const json = parseJson(text)
  if (json !== undefined && json.success === false) {
    throw new AdapterError(`${path} 失败：${vendorMessage(json, text)}`, {
      status: response.status,
      permanent: true,
    })
  }
  if (response.status === 401) {
    throw new AdapterError(
      apiKey !== undefined
        ? `${path} 失败 HTTP 401（API Key 无效或已撤销，请到 meoo.com 重新生成）`
        : `${path} 失败 HTTP 401（续期后仍 401，请重新登录）`,
      { status: 401, permanent: true },
    )
  }
  if (!response.ok) {
    throw new AdapterError(`${path} 失败 HTTP ${response.status}：${vendorMessage(json, text)}`, { status: response.status })
  }
  return json !== undefined && json.data !== undefined ? json.data : json
}

/** access token 提前 60 秒续期；API Key 模式直接返回。 */
async function ensureAccess(credential) {
  const access = str(credential.accessToken)
  const expiresAt = typeof credential.expiresAtMs === 'number' ? credential.expiresAtMs : 0
  if (access !== undefined && expiresAt - 60_000 > Date.now()) return access
  if (str(credential.refreshToken) === undefined) {
    if (access !== undefined) return access
    throw new AdapterError('Meoo 登录态已失效，请重新登录', { permanent: true })
  }
  return refreshAccess(credential)
}

/** 续期（就地更新 credential），带并发去重。 */
async function refreshAccess(credential) {
  const refreshToken = str(credential.refreshToken)
  if (refreshToken === undefined) throw new AdapterError('Meoo 没有 refresh token，请重新登录', { permanent: true })
  const inflight = renewing.get(refreshToken)
  if (inflight !== undefined) return inflight
  const task = (async () => {
    const apiBase = apiBaseOf(credential)
    const clientId = apiBase === 'https://meoo.com'
      ? 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh'
      : 'meoo_app_SFNvmHUFNePxyyfGjCd9hyaE'
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString()
    const response = await fetch(`${apiBase}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    const json = parseJson(await response.text().catch(() => ''))
    if (!response.ok || json === undefined || str(json.access_token) === undefined) {
      const description = json !== undefined ? vendorMessage(json, '') : ''
      /**
       * `invalid_grant` 是**刷新令牌本身失效**（被轮换掉、或过期），换多少次都没用，
       * 只能重新认证。必须和「网络抖动」区分开：前者要把账号标成 expired，
       * 让界面给出「重新认证」，而不是显示一个含糊的「错误」。
       */
      const dead = str(json?.error) === 'invalid_grant' || /无效或已过期|invalid.*(grant|token)/i.test(description)
      throw new AdapterError(
        dead
          ? `Meoo 登录态已失效（${description || 'refresh_token 无效或已过期'}），请重新认证`
          : `Meoo 续期失败（http ${response.status}）：${description}`,
        {
          status: response.status,
          kind: dead ? 'auth' : 'upstream',
          permanent: dead || response.status === 400 || response.status === 401,
        },
      )
    }
    credential.accessToken = json.access_token
    if (str(json.refresh_token) !== undefined) credential.refreshToken = json.refresh_token
    credential.expiresAtMs = Date.now() + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000
    return credential.accessToken
  })()
  renewing.set(refreshToken, task)
  try {
    return await task
  } finally {
    renewing.delete(refreshToken)
  }
}

async function fetchIdentity(credential) {
  const record = (await controlRequest(credential, 'GET', '/open/v1/cli-compat/account/identity')) ?? {}
  return {
    name: str(record.name),
    userId: str(record.user_id) ?? str(record.userId),
    projectUrlId: str(record.project_url_id) ?? str(record.projectUrlId),
  }
}

async function listProjects(credential) {
  const data = await controlRequest(credential, 'GET', '/open/v1/cli-compat/projects?page_size=50')
  const record = typeof data === 'object' && data !== null ? data : {}
  const list = Array.isArray(data) ? data : Array.isArray(record.list) ? record.list : Array.isArray(record.items) ? record.items : Array.isArray(record.projects) ? record.projects : []
  const projects = []
  for (const entry of list) {
    const urlId = str(entry?.url_id) ?? str(entry?.urlId)
    if (urlId === undefined) continue
    projects.push({ urlId, name: str(entry?.name) ?? '未命名' })
  }
  return projects
}

async function createProject(credential) {
  for (const body of [{ name: 'AI 服务' }, {}]) {
    try {
      const record = (await controlRequest(credential, 'POST', '/open/v1/cli-compat/projects', body)) ?? {}
      const urlId = str(record.url_id) ?? str(record.urlId)
      if (urlId !== undefined) return { urlId, name: str(record.name) ?? 'AI 服务' }
    } catch {
      // 换个请求体再试
    }
  }
  return undefined
}

/** 选项目：显式 > 记住的 > 身份默认 > 唯一项目 > 自动新建；多项目不替用户猜。 */
async function pickProject(credential, explicitUrlId) {
  const explicit = str(explicitUrlId)
  if (explicit !== undefined) return explicit
  const remembered = str(credential.projectUrlId)
  if (remembered !== undefined) return remembered
  let fromIdentity
  try {
    fromIdentity = (await fetchIdentity(credential)).projectUrlId
  } catch {
    fromIdentity = undefined
  }
  if (fromIdentity !== undefined) return fromIdentity
  const projects = await listProjects(credential)
  if (projects.length === 0) {
    const created = await createProject(credential)
    if (created === undefined) throw new AdapterError('账号下还没有项目，自动创建也失败，请在 meoo.com 手动建一个项目', { permanent: true })
    return created.urlId
  }
  if (projects.length === 1) return projects[0].urlId
  throw new AdapterError(
    `账号下有多个项目，请指定一个（计费归属不同）：${projects.map((p) => `${p.urlId}（${p.name}）`).join('、')}`,
    { permanent: true },
  )
}

function readServiceAk(payload) {
  const record = typeof payload === 'object' && payload !== null ? payload : {}
  const instance = typeof record.instance === 'object' && record.instance !== null ? record.instance : {}
  return str(record.meooProjectApiKey) ?? str(instance.meooProjectApiKey)
}

/**
 * 解析项目服务 AK，写回 credential 并返回。
 * 缓存命中直接用；否则 GET environment → 空则自动 POST /cloud 开通一次 → 重取。
 */
export async function resolveServiceAk(credential, explicitProjectUrlId) {
  if (!hasControlCredential(credential)) {
    if (str(credential?.serviceAk) !== undefined) return credential
    throw new AdapterError('Meoo 缺少可用凭证', { permanent: true })
  }
  const projectUrlId = await pickProject(credential, explicitProjectUrlId)
  const cached = str(credential.serviceAk)
  if (cached !== undefined && credential.serviceAkProjectId === projectUrlId) return credential

  let ak
  try {
    ak = readServiceAk(await controlRequest(credential, 'GET', `/open/v1/cli-compat/projects/${encodeURIComponent(projectUrlId)}/cloud/environment`))
  } catch {
    ak = undefined
  }
  let cloudError = ''
  if (ak === undefined) {
    try {
      await controlRequest(credential, 'POST', `/open/v1/cli-compat/projects/${encodeURIComponent(projectUrlId)}/cloud`, {
        description: 'dsh-connect-model-gateway: AI 服务',
      })
      ak = readServiceAk(await controlRequest(credential, 'GET', `/open/v1/cli-compat/projects/${encodeURIComponent(projectUrlId)}/cloud/environment`))
    } catch (error) {
      cloudError = error instanceof Error ? error.message : String(error)
    }
  }
  if (ak === undefined) {
    throw new AdapterError(
      `项目 ${projectUrlId} 还没开通 Meoo AI 服务：在 meoo.com 打开该项目发一句「帮我开启云服务」，开通后重试` +
        (cloudError === '' ? '' : `（自动开通失败：${cloudError}）`),
      { permanent: true },
    )
  }
  credential.serviceAk = ak
  credential.serviceAkProjectId = projectUrlId
  credential.projectUrlId = projectUrlId
  return credential
}

/** 用 API Key 建一条账号记录（供「添加 API Key」路由调用）。 */
export async function accountFromApiKey(apiKey) {
  const key = str(apiKey)
  if (key === undefined || !key.startsWith('meoo_ak_')) {
    throw new AdapterError('API Key 格式不对：应以 meoo_ak_ 开头', { permanent: true })
  }
  const credential = { kind: 'apikey', apiKey: key }
  const identity = await fetchIdentity(credential)
  await resolveServiceAk(credential, identity.projectUrlId)
  const id = identity.userId ?? `meoo_${key.slice(-12)}`
  return {
    id,
    label: identity.name ?? id,
    credential: { ...credential, uid: id, nickname: identity.name ?? '' },
  }
}

/** 手填项目服务 AK 建账号（读不到积分，仅网关可用）。 */
export async function accountFromServiceAk(serviceAk) {
  const key = str(serviceAk)?.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '')
  if (key === undefined || !key.startsWith('meoo_project_service_v1.')) {
    throw new AdapterError('项目服务 AK 格式不对：应以 meoo_project_service_v1. 开头', { permanent: true })
  }
  const credential = { kind: 'serviceak', serviceAk: key }
  const response = await fetch(`${GATEWAY_BASE}/models`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  })
  if (response.status === 401 || response.status === 403) {
    throw new AdapterError(`网关拒绝了这个 AK（HTTP ${response.status}）：请确认 AK 属于已开通 AI 服务的正确项目`, {
      status: response.status,
      permanent: true,
    })
  }
  return { id: `meoo_ak_${key.slice(-12)}`, label: 'Meoo 项目服务 AK', credential }
}

function parseGatewayModels(payload) {
  const envelope = typeof payload === 'object' && payload !== null ? payload : {}
  const list = Array.isArray(payload) ? payload : Array.isArray(envelope.models) ? envelope.models : Array.isArray(envelope.data) ? envelope.data : []
  const seen = new Set()
  const models = []
  for (const entry of list) {
    const rawId = typeof entry === 'string' ? entry : entry?.id
    const id = str(rawId)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const record = typeof entry === 'object' && entry !== null ? entry : {}
    models.push({
      id,
      name: str(record.name) ?? id,
      contextWindow: Math.max(positiveInt(record.context, 0), CONTEXT_WINDOW_FLOOR),
      maxTokens: positiveInt(record.max_output ?? record.max_output_tokens ?? record.max_tokens, 64_000),
      vision: record.image === true,
      reasoning: true,
    })
  }
  return models
}

/** 官网富目录：价格档 → badge，夜间折扣 → promo，说明 → note。 */
function parseAgentModels(payload) {
  const envelope = typeof payload === 'object' && payload !== null ? payload : {}
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope
  const list = Array.isArray(data.models) ? data.models : []
  const valueMap = typeof data.modelsValue === 'object' && data.modelsValue !== null ? data.modelsValue : {}
  const models = []
  const seen = new Set()
  for (const entry of list) {
    const key = str(entry?.key)
    if (key === undefined || key === 'auto') continue
    const mapped = str(valueMap[key])
    const id = mapped ?? key
    if (seen.has(id)) continue
    seen.add(id)
    const discountLabel = Number(entry.discountLabel)
    const start = str(entry.discountStartTime)
    const end = str(entry.discountEndTime)
    const tier = str(entry.price)
    models.push({
      id,
      name: str(entry.label) ?? id,
      contextWindow: Math.max(positiveInt(entry.context_window, 0), CONTEXT_WINDOW_FLOOR),
      maxTokens: positiveInt(entry.max_token, 64_000),
      vision: entry.multimodal === true,
      reasoning: true,
      badge: tier !== undefined ? PRICE_LABELS[tier] ?? tier : null,
      note: str(entry.description) ?? null,
      promo: Number.isFinite(discountLabel) && discountLabel > 0 && start !== undefined && end !== undefined
        ? { label: `夜间${discountLabel}折` }
        : null,
    })
  }
  return models
}

async function fetchCatalog(credential) {
  const base = gatewayBaseOf(credential)
  const response = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${credential.serviceAk}`, accept: 'application/json' },
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  const json = parseJson(text)
  if (response.status === 401 || response.status === 403) {
    throw new AdapterError(`网关拒绝了这个 AK（HTTP ${response.status}）：${json !== undefined ? vendorMessage(json, text) : ''}`, {
      status: response.status,
      permanent: true,
    })
  }
  if (!response.ok) {
    throw new AdapterError(`模型目录 HTTP ${response.status}：${json !== undefined ? vendorMessage(json, text) : ''}`, { status: response.status })
  }
  const fallback = parseGatewayModels(json)

  // 官网富目录优先（API Key 打这里会 403，静默退回网关裸目录）
  if (hasControlCredential(credential)) {
    try {
      const apiResponse = await fetch(`${apiBaseOf(credential)}/api/v1/agent/models`, {
        headers: { authorization: `Bearer ${credential.serviceAk}`, accept: 'application/json', ...CLI_HEADERS },
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      })
      const apiText = await apiResponse.text().catch(() => '')
      const apiJson = parseJson(apiText)
      if (apiResponse.ok && apiJson !== undefined) {
        const rich = parseAgentModels(apiJson)
        if (rich.length > 0) return rich
      }
    } catch {
      // 富目录不可用就用网关目录
    }
  }
  return fallback
}

function parsePoints(payload, nowMs = Date.now()) {
  const root = typeof payload === 'object' && payload !== null ? payload : {}
  const account = typeof root.account === 'object' && root.account !== null ? root.account : {}
  const nonnegative = (value) => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  }
  const grants = []
  for (const grant of Array.isArray(root.activeGrants) ? root.activeGrants : []) {
    for (const detail of Array.isArray(grant?.grantDetails) ? grant.grantDetails : []) {
      const remaining = nonnegative(detail?.remainingAmount)
      const expiresDate = str(detail?.expiresDate)?.slice(0, 10)
      if (remaining <= 0 || expiresDate === undefined) continue
      grants.push({ remaining, expiresDate })
    }
  }
  grants.sort((a, b) => a.expiresDate.localeCompare(b.expiresDate))
  return {
    remaining: nonnegative(account.availableBalance),
    consumed: nonnegative(account.totalConsumed),
    frozen: nonnegative(account.frozenBalance),
    nextExpiry: grants[0]?.expiresDate ?? null,
    fetchedAtMs: nowMs,
  }
}

/** 秒悟服务端的时间都是 Asia/Shanghai 本地时间（无时区后缀），按同一天比较。 */
function shanghaiDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/**
 * 取「每日登录赠送」那一笔（`activeGrants[].sourceType === 'DAILY_LOGIN'`）。
 *
 * 上游字段：`totalInitialAmount` 发放量、`grantDetails[].effectiveDate` 到账时刻、
 * `expiresDate` 到期日、`remainingAmount` 剩余。秒悟**没有任何领取接口**，
 * 这一笔存在且 effectiveDate 是今天，就说明今天已经登录过、积分已自动到账。
 */
function dailyLoginGrant(payload) {
  const root = typeof payload === 'object' && payload !== null ? payload : {}
  const nonnegative = (value) => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  }
  for (const grant of Array.isArray(root.activeGrants) ? root.activeGrants : []) {
    if (str(grant?.sourceType) !== 'DAILY_LOGIN') continue
    const details = (Array.isArray(grant?.grantDetails) ? grant.grantDetails : [])
      .map((detail) => ({
        effectiveDate: str(detail?.effectiveDate),
        expiresDate: str(detail?.expiresDate)?.slice(0, 10),
        remaining: nonnegative(detail?.remainingAmount),
      }))
      .filter((detail) => detail.effectiveDate !== undefined)
    if (details.length === 0) continue
    details.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    const latest = details[details.length - 1]
    return {
      credit: nonnegative(grant?.totalInitialAmount) || details.reduce((sum, detail) => sum + detail.remaining, 0),
      effectiveDate: latest.effectiveDate,
      expiresDate: latest.expiresDate ?? null,
      remaining: details.reduce((sum, detail) => sum + detail.remaining, 0),
    }
  }
  return undefined
}

export function createMeooAdapter() {
  return {
    key: KEY,
    displayName: DISPLAY_NAME,
    fallbackModels: FALLBACK_MODELS,

    /** 刷新：续 access token + 确保项目服务 AK 可用。返回更新后的凭证。 */
    async refresh(credential) {
      const next = { ...credential }
      if (hasControlCredential(next)) await resolveServiceAk(next)
      return next
    },

    async probe(credential) {
      if (credential?.kind === 'serviceak') {
        return { state: str(credential.serviceAk) !== undefined ? 'signed-in' : 'expired' }
      }
      // API Key 不过期；oauth 凭证则看是否已被判定失效（authError）或确实过期
      if (isApiKey(credential)) return { state: 'signed-in', account: credential.nickname ?? credential.uid }
      if (credential?.authError === true) {
        return { state: 'expired', account: credential?.nickname ?? credential?.uid }
      }
      const expiresAt = credential?.expiresAtMs ?? 0
      const state = expiresAt !== 0 && expiresAt - 60_000 <= Date.now() && str(credential?.refreshToken) === undefined
        ? 'expired'
        : 'signed-in'
      return { state, account: credential?.nickname ?? credential?.uid }
    },

    /** 积分：只认控制面凭证；手填项目服务 AK 读不到，返回 null 让 UI 显示「未知」。 */
    async quota(credential) {
      if (!hasControlCredential(credential)) return { remaining: null, fetchedAtMs: Date.now() }
      const result = await controlRequest(credential, 'GET', '/open/v1/cli-compat/account/points')
      return parsePoints(result)
    },

    /**
     * 签到：**只读检测，不代领**。
     *
     * 秒悟没有签到接口——2000 分是「每天第一次用登录态打开 meoo 网页」时，服务端在
     * `/api/mc/entitlement/init` 里自动发放的（实测 2026-11-26 08:39:17 打开授权页，
     * 同一毫秒 points 里出现 DAILY_LOGIN 2000 分、7 天有效）。API Key 打那条路由
     * 一律 `403 API_KEY_ROUTE_FORBIDDEN`，cli-compat 面也没有 checkin/init 路由，
     * 所以魔桥只做两件事：查今天到账没有；没到账就提示用户去 meoo 登录一次。
     */
    async checkIn(credential) {
      if (!hasControlCredential(credential)) {
        return {
          credit: 0,
          alreadyCheckedIn: false,
          unavailable: true,
          detail: '项目服务 AK 读不到积分，无法判断登录赠送',
        }
      }
      const payload = await controlRequest(credential, 'GET', '/open/v1/cli-compat/account/points')
      const grant = dailyLoginGrant(payload)
      const today = shanghaiDateKey()
      if (grant === undefined || grant.effectiveDate.slice(0, 10) !== today) {
        const last = grant === undefined
          ? '没有查到登录赠送记录'
          : `最近一次是 ${grant.effectiveDate.slice(0, 10)} 的 ${grant.credit} 分`
        return {
          credit: 0,
          alreadyCheckedIn: false,
          detail: `今天还没有登录赠送（${last}）：打开 meoo.com 登录一次即到账 ${DAILY_LOGIN_CREDIT} 分，再点「检查到账」`,
        }
      }
      return {
        credit: grant.credit,
        alreadyCheckedIn: true,
        detail: `登录赠送 ${grant.credit} 分${grant.expiresDate !== null ? ` · ${grant.expiresDate} 到期` : ''}`,
      }
    },

    /** 模型目录：网关裸目录兜底 + 官网富目录优先。 */
    async listModels(credential) {
      const next = { ...credential }
      await resolveServiceAk(next)
      const models = await fetchCatalog(next)
      return { models, credential: next }
    },

    /** 推理直连网关：baseURL 已含 /v1，apiKey 就是项目服务 AK。 */
    async inferenceTarget(credential) {
      const next = { ...credential }
      await resolveServiceAk(next)
      return { baseUrl: gatewayBaseOf(next), apiKey: next.serviceAk, credential: next }
    },

    chatBase(credential) {
      return gatewayBaseOf(credential)
    },

    async resolveApiKey(credential) {
      const next = { ...credential }
      await resolveServiceAk(next)
      return next.serviceAk
    },
  }
}
