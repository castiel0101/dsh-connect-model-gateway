/**
 * WPS 灵犀适配器（无状态：凭证由上层传入）。
 *
 * **关键逻辑逐字移植自 dsh-connect-lingxi@0.0.20**（MIT），不自己发明：
 * - 目录解析 ← `src/protocol/catalog.ts` 的 `fromRawEntry` / `parsePlans` / `dedupeModels`：
 *   先 `plans` 后 `models`，按 id 去重；**不跳过任何条目**；倍率原样保留（含 `~`）；
 *   `reasoning` 只有上游给了 `reasoning_efforts` 才为真；`vision` 看 `support_multimodal`。
 * - 余额 ← `src/protocol/balance.ts`：`total_balance`，15 天内过期的 `bonus_credits` 单独算。
 * - 签到 ← `src/protocol/tasks.ts`：`daily_check_in`，日期按**北京时间**，
 *   「已领过」不是失败。
 * - 推理 ← `src/protocol/client.ts` 三步握手 + `src/protocol/sse.ts` 帧翻译，
 *   见 `core/lingxi-shim.js`。
 *
 * 上游事实：
 * - 鉴权是 `wps_sid` cookie（不是 Bearer），每次请求都要带 KSO 客户端指纹 cookie；
 *   cookie 里有 `copilot_server_branch` 时要加 `X-Cc-Region` 头。
 * - 没有开放 API，是桌面客户端私有 app-server。
 *
 * @module dsh-connect-model-gateway/adapters/lingxi
 */

import { AdapterError } from '../core/adapter.js'

export const KEY = 'lingxi'
export const DISPLAY_NAME = 'WPS 灵犀'

/**
 * 上游基址（按 2026-11-25 真实抓包 `/Users/jackleo/Desktop/365.kdocs.cn.har` 校正）：
 * WPS 365 网页端走 `https://365.kdocs.cn/3rd/lingxi`，原生端走 `lingxi.wps.cn`。
 * 两条路径的 API 路径相同，只是 host / 前缀不同，所以都试，命中即用。
 */
const BASES = [
  'https://365.kdocs.cn/3rd/lingxi',
  'https://lingxi.wps.cn',
  'https://lingxi.kdocs.cn',
]
const BASE = BASES[0]
const DEVICE_ID = 'dsh-connect-model-gateway-lingxi-device'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const KSO = `x-kso-app-name=win-lingxi-desktop; x-kso-app-version=1.3.31; x-kso-device-id=${DEVICE_ID}`
const DEFAULT_MODEL_FALLBACK = 'deepseek-v4.1-flash'
/** 15 天内会过期的临时积分单独统计（旧插件 EXPIRING_WINDOW_MS）。 */
const EXPIRING_WINDOW_MS = 15 * 24 * 60 * 60 * 1000

/**
 * 静态兜底目录：逐字段抄自旧插件 `STATIC_CATALOG`（一次真实的 `/sessions/plans` 响应）。
 * 只在未登录、或动态目录读不到时用。
 */
const STATIC_CATALOG = [
  { id: 'plan_pro', name: 'Pro 模式', contextWindow: 1_048_576, maxTokens: 131_072, multiplier: '', reasoning: false, vision: true, description: '适用于日常任务，智点消耗较少' },
  { id: 'plan_max', name: 'Max 模式', contextWindow: 1_048_576, maxTokens: 131_072, multiplier: '', reasoning: false, vision: true, description: '为复杂任务设计，智点消耗较多' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxTokens: 393_216, multiplier: '~0.12x', reasoning: true, vision: true, badge: 'NEW', reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', contextWindow: 1_048_576, maxTokens: 393_216, multiplier: '0.40x', reasoning: true, vision: false, badge: '正式版', reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'qwen3.8_flash', name: 'Qwen3.8-Flash', contextWindow: 1_048_576, maxTokens: 131_072, multiplier: '~0.08x', reasoning: true, vision: true, reasoningEfforts: ['low', 'high', 'max'] },
  { id: 'qwen3.8_max', name: 'Qwen3.8-Max', contextWindow: 1_048_576, maxTokens: 131_072, multiplier: '~0.80x', reasoning: true, vision: true, reasoningEfforts: ['low', 'high', 'max'] },
]

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function numberOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** 倍率里的波浪号有 ASCII `~`、全角 `～`、日文 `〜` 三种，统一成 ASCII。 */
function normalizeTilde(text) {
  return text.replace(/[\uFF5E\u301C\u223C]/g, '~')
}

function effortList(value) {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item) => typeof item === 'string' && item.trim() !== '')
  return list.length === 0 ? undefined : list
}

/** 基础头（旧插件 protocol/headers.ts）：用户 cookie + KSO 指纹 + 区域头。 */
function headers(credential, extra = {}) {
  const cookie = `${credential?.cookie ?? ''}; ${KSO}`
  const result = { Cookie: cookie, 'User-Agent': UA, Referer: `${BASE}/`, Accept: 'application/json', ...extra }
  const branch = /copilot_server_branch=([^;]+)/.exec(credential?.cookie ?? '')
  if (branch !== null) result['X-Cc-Region'] = branch[1].trim()
  return result
}

/**
 * 一次 API 请求：先打 lingxi.wps.cn，失败再打 lingxi.kdocs.cn。
 * 401 只在**明确鉴权文案**时才算登录失效（旧插件 protocol/errors.ts 的语义），
 * 否则会把账号误标成未登录并从 provider 列表摘掉。
 */
async function request(path, credential, options = {}) {
  let lastError
  for (const base of BASES) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET',
        headers: headers(credential, options.headers),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      })
      const text = await response.text().catch(() => '')
      let payload
      try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = {} }
      if (response.status === 401 || response.status === 403) {
        const diagnostic = [payload?.code, payload?.message, payload?.errmsg, payload?.error, payload?.detail, payload?.reason]
          .filter((item) => typeof item === 'string').join(' ')
        if (/unauthor|登录|凭据|credential|cookie|sid/i.test(diagnostic)) {
          // 这个域不认这份 cookie，换下一个域再试（网页端与原生端域名不同）
          lastError = new AdapterError('灵犀登录态已失效，请重新登录', { status: 401, permanent: true })
          continue
        }
        // 其它 401/403 映射成"模型不存在"，避免误判登录态
        throw new AdapterError(`灵犀模型或参数不可用（http ${response.status}）：${diagnostic.slice(0, 120)}`, { status: 404 })
      }
      if (!response.ok) {
        throw new AdapterError(`灵犀接口失败（http ${response.status}）：${String(payload?.message ?? text).slice(0, 120)}`, { status: response.status })
      }
      return payload
    } catch (error) {
      lastError = error
    }
  }
  if (lastError instanceof AdapterError && lastError.permanent === true) throw lastError
  throw new AdapterError(`灵犀接口不可用：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * 目录条目 → PoolModel —— 照抄旧插件 `fromRawEntry`：
 * 缺字段用兜底值，`key` 为空直接丢弃；`reasoning_efforts` 非空才算思考模型。
 */
function fromRawEntry(raw) {
  const id = str(raw?.key)
  if (id === undefined) return undefined
  const description = str(raw?.desc) ?? str(raw?.intro) ?? ''
  const badge = str(raw?.badge) ?? str(raw?.tag) ?? str(raw?.label) ?? ''
  const efforts = effortList(raw?.reasoning_efforts)
  const multiplier = normalizeTilde(str(raw?.multiplier) ?? '')
  return {
    id,
    name: str(raw?.name) ?? id,
    contextWindow: numberOr(raw?.max_context_tokens, 1_048_576),
    // 输出上限是 max_new_tokens（各模型差别极大，kimi-k3 是 1048576）
    maxTokens: numberOr(raw?.max_new_tokens, 131_072),
    // 倍率缺失就是没有倍率，不是"倍率叫某个字"
    badge: multiplier === '' ? null : multiplier,
    note: description === '' ? null : description,
    promo: badge === '' ? null : { label: badge },
    vision: raw?.support_multimodal === true,
    reasoning: efforts !== undefined,
    ...(efforts === undefined ? {} : { thinkingOptions: efforts }),
    thinkingDefault: efforts === undefined ? 'high' : (efforts.includes('high') ? 'high' : efforts[0]),
    canDisableThinking: false,
  }
}

/** 解析 `/sessions/plans`：先 plans 再 models，按 id 去重（先出现的胜出）。 */
function parsePlans(payload) {
  const data = payload?.data
  if (data === null || typeof data !== 'object') return []
  const out = []
  for (const field of ['plans', 'models']) {
    const list = data[field]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const model = fromRawEntry(item)
      if (model !== undefined) out.push(model)
    }
  }
  const seen = new Set()
  return out.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

/** 上游时间 → 毫秒；解析不出返回 undefined。 */
function parseUpstreamTime(value) {
  const text = str(value)
  if (text === undefined) return undefined
  const at = Date.parse(text.replace(' ', 'T'))
  return Number.isNaN(at) ? undefined : at
}

/**
 * 余额 —— 照抄旧插件 `parseBalance`：
 * `total_balance` 是总额；`bonus_credits[].balance` 里 15 天内到期的单独统计。
 */
function parseBalance(payload, nowMs = Date.now()) {
  const data = payload?.data
  if (data === null || typeof data !== 'object') return undefined
  const total = typeof data.total_balance === 'number' ? data.total_balance
    : typeof data.balance === 'number' ? data.balance : undefined
  if (total === undefined) return undefined
  const batches = (Array.isArray(data.bonus_credits) ? data.bonus_credits : [])
    .filter((item) => typeof item?.balance === 'number' && item.balance > 0)
    .map((item) => ({ balance: item.balance, expireTime: str(item.expire_time) ?? '', expireAtMs: parseUpstreamTime(item.expire_time) }))
  const now = nowMs
  let expiring = 0
  let earliest
  for (const batch of batches) {
    const at = batch.expireAtMs
    if (at === undefined || at <= now || at - now > EXPIRING_WINDOW_MS) continue
    expiring += batch.balance
    if (earliest === undefined || at < earliest) earliest = at
  }
  return {
    remaining: total,
    ...(expiring > 0 ? { expiringSoon: expiring, nearestExpiryMs: earliest } : {}),
    fetchedAtMs: now,
  }
}

/** 任务项解析（旧插件 parseTask）。 */
function parseTask(raw) {
  const key = str(raw?.task_key) ?? str(raw?.key)
  if (key === undefined) return undefined
  const days = (Array.isArray(raw?.extra?.check_in_days) ? raw.extra.check_in_days : [])
    .filter((day) => str(day?.date) !== undefined)
    .map((day) => ({ date: day.date, status: str(day?.status) ?? '' }))
  return {
    key,
    type: str(raw?.type) ?? '',
    title: str(raw?.title) ?? '',
    status: str(raw?.status) ?? '',
    reward: typeof raw?.reward_amount === 'number' ? raw.reward_amount : 0,
    days,
    consecutiveDays: typeof raw?.extra?.consecutive_days === 'number' ? raw.extra.consecutive_days : 0,
  }
}

/**
 * 领取响应 —— 照抄旧插件 `parseClaimResponse`：
 * `result === 'ok'` 成功；别的值 + hint 说「已领取」是**幂等成功**，不是失败。
 */
function parseClaimResponse(payload, fallbackReward) {
  if (payload === null || typeof payload !== 'object') return { ok: true, reward: fallbackReward, alreadyDone: false }
  const result = payload.result
  const hint = str(payload.hint) ?? ''
  if (typeof result === 'string' && result !== '' && result !== 'ok' && result !== 'Success') {
    const done = /已(?:经)?(?:领取|签到)|already/i.test(hint) || /done|claimed/i.test(result)
    return { ok: done, reward: 0, alreadyDone: done, message: hint === '' ? `领取失败：${result}` : hint }
  }
  const extra = payload.data?.extra
  const reward = (typeof extra?.today_reward === 'number' ? extra.today_reward : 0)
    || (typeof payload.data?.reward_amount === 'number' ? payload.data.reward_amount : 0)
    || fallbackReward
  return { ok: true, reward, alreadyDone: false }
}

export function createLingxiAdapter() {
  return {
    key: KEY,
    displayName: DISPLAY_NAME,
    fallbackModels: STATIC_CATALOG.map((model) => fromRawEntry({ ...model, key: model.id })).filter(Boolean),

    async probe(credential) {
      if (str(credential?.cookie) === undefined) return { state: 'signed-out' }
      try {
        const payload = await request('/api/public/v1/account/profile', credential, { timeoutMs: 12_000 })
        const data = payload?.data ?? payload
        const name = str(data?.name) ?? str(data?.nickname) ?? str(credential?.nickname) ?? ''
        const userId = str(data?.id) ?? str(credential?.userId) ?? ''
        /**
         * 账号名后面带上 uid 后六位：同一个人可能有多个 WPS 账号（例如网页端与
         * 插件登录的不是同一个），只显示昵称根本分不清谁的余额是多少。
         * 每次都从 profile 重新拼，天然幂等，不会重复追加后缀。
         */
        const suffix = userId.length >= 6 ? userId.slice(-6) : userId
        const label = name === '' ? (suffix === '' ? '' : suffix) : (suffix === '' ? name : `${name} · ${suffix}`)
        return { state: 'signed-in', account: name, label, userId }
      } catch (error) {
        if (error instanceof AdapterError && error.status === 401) return { state: 'expired' }
        // 网络抖动不该把账号标成过期
        return { state: 'signed-in', account: str(credential?.nickname) ?? '' }
      }
    },

    /** 余额：智点总额；15 天内到期的临时积分单独给。 */
    async quota(credential) {
      try {
        const payload = await request('/api/public/v1/credits/balance', credential)
        const parsed = parseBalance(payload)
        return parsed === undefined ? { remaining: null, fetchedAtMs: Date.now() } : parsed
      } catch {
        return { remaining: null, fetchedAtMs: Date.now() }
      }
    },

    /** 目录：登录后以 `/sessions/plans` 为准，读不到才退回静态表。 */
    async listModels(credential) {
      try {
        const payload = await request('/api/aioffice/v1/sessions/plans', credential)
        const models = parsePlans(payload)
        return { models: models.length > 0 ? models : this.fallbackModels, credential }
      } catch {
        return { models: this.fallbackModels, credential }
      }
    },

    /**
     * 签到 + 领取。
     *
     * 按 2026-11-25 真实抓包校正了三处：
     * 1. 领取是 `POST /api/public/v1/tasks/{key}/claim`，**不带 `?date=`**
     *    （旧文档说可选，实际网页端不发，带上反而可能被当参数错误）；
     * 2. 奖励在 `data.reward_amount`；
     * 3. 一次性任务只要上游已经判 `claimable` 就能直接领，不需要先做动作
     *    （抓包里 `try_expert_mode` 就是 claimable）。
     */
    async checkIn(credential) {
      const payload = await request('/api/public/v1/tasks', credential)
      const tasks = (Array.isArray(payload?.data?.tasks) ? payload.data.tasks : []).map(parseTask).filter(Boolean)
      const daily = tasks.find((task) => task.key === 'daily_check_in')
      const claim = async (key, fallbackReward) => {
        const claimed = await request(`/api/public/v1/tasks/${encodeURIComponent(key)}/claim`, credential, {
          method: 'POST',
          body: {},
        })
        return parseClaimResponse(claimed, fallbackReward)
      }

      let credit = 0
      let streakDays
      let alreadyCheckedIn = false
      const details = []

      // 每日签到
      //
      // **不要用 status 拦**：实测（2026-11-25）每日签到的 status 可能是
      // `incomplete`，但 `POST .../daily_check_in/claim` 仍然成功返回 100 智点。
      // status 只是展示态，领取接口才是准的。所以除了明确 `claimed` 之外，一律去领。
      if (daily !== undefined) {
        streakDays = daily.consecutiveDays
        if (daily.status === 'claimed') {
          alreadyCheckedIn = true
        } else {
          try {
            const outcome = await claim('daily_check_in', daily.reward)
            if (outcome.ok === true) {
              credit += outcome.reward
              // 领到或「已领过」都算今天已签
              alreadyCheckedIn = true
            } else {
              details.push(outcome.message ?? '签到领取失败')
            }
          } catch (error) {
            details.push(error instanceof Error ? error.message : String(error))
          }
        }
      }

      // 一次性任务：只有上游明确 claimable 才领。
      // 抓包里 `try_expert_mode` 曾是 claimable，但真正领取会回 40001「任务尚未完成」，
      // 说明 claimable 也可能需要先有真实使用信号 —— 所以失败一律静默忽略，不打扰用户。
      for (const task of tasks) {
        if (task.key === 'daily_check_in') continue
        if (task.type === 'daily') continue
        if (task.status !== 'claimable') continue
        try {
          const outcome = await claim(task.key, task.reward)
          if (outcome.ok === true && outcome.reward > 0) {
            credit += outcome.reward
            details.push(`${task.title || task.key} +${outcome.reward}`)
          }
        } catch {
          // 单个任务失败不影响其它
        }
      }

      if (daily === undefined && details.length === 0) {
        return { credit: 0, unavailable: true, detail: '没有签到活动' }
      }
      return {
        credit,
        ...(streakDays === undefined ? {} : { streakDays }),
        ...(alreadyCheckedIn ? { alreadyCheckedIn: true } : {}),
        ...(details.length > 0 ? { detail: details.join('；') } : {}),
        // 只有确认拿不到（既没领到、也不是已签）才标 unavailable，避免卡片显示「未签到」
        ...(credit === 0 && alreadyCheckedIn !== true && daily !== undefined && details.length > 0
          ? { unavailable: true }
          : {}),
      }
    },

    chatBase() {
      // 实际地址由 index.js 用本地 shim 覆盖（灵犀要走三步握手 + SSE 翻译）
      return 'http://127.0.0.1:0/v1'
    },

    async resolveApiKey() {
      // 灵犀的 Bearer 是本地 shim 的随机 token，由 index.js 提供
      return ''
    },
  }
}
