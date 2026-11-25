/**
 * WorkBuddy 适配器（无状态：凭证由上层传入，适配器只负责跟上游说话）。
 *
 * 上游事实（2026-11-24 实测）：
 * - 登录态：读桌面客户端写的凭证文件
 *     macOS ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 *     （旧名 workbuddy-desktop-ai.info、迁移源 .workbuddy-auth.json 都认）
 * - 推理：POST https://copilot.tencent.com/v2/chat/completions，OpenAI 兼容 SSE，直连
 * - 目录：GET  https://www.codebuddy.cn/v2/enterprises/personal/models
 *     每条带 credits 倍率、contextWindow{defaultLength,supportedLengths}、supportsImages
 * - 积分：POST /v2/billing/meter/get-user-resource（Accounts[] 里 CapacityRemain 求和，
 *     Status=3 或已过 ExpiredTime 的包必须排除）
 * - 签到：POST /v2/billing/meter/checkin-activity-status、/v2/billing/meter/daily-checkin
 * - 续期：POST {chatBase}/v2/plugin/auth/token/refresh，头 X-Refresh-Token
 *
 * @module dsh-connect-model-gateway/adapters/workbuddy
 */

import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AdapterError } from '../core/adapter.js'
import { parseWorkBuddyPromos, attachPromos, selectPromoBadge } from '../core/workbuddy-promos.js'

export const KEY = 'workbuddy'
export const DISPLAY_NAME = 'WorkBuddy'

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_CHAT_BASE = 'https://www.workbuddy.ai'
const GLOBAL_BILLING_BASE = 'https://www.workbuddy.ai'

const JSON_TIMEOUT_MS = 30_000
const AUTH_BASENAMES = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info', '.workbuddy-auth.json']
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const PRODUCT = 'WorkBuddy'
const APP_VERSION = '5.8.3'

/** 桌面凭证目录（按平台）。 */
export function authDirs(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  return [join(home, '.config', 'CodeBuddyExtension', 'auth')]
}

/** 从客户端凭证文档里取出一份可用凭证。 */
export function parseCredential(document) {
  if (document === null || typeof document !== 'object') return undefined
  const auth = document.auth
  if (auth === null || typeof auth !== 'object') return undefined
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const account = document.account !== null && typeof document.account === 'object' ? document.account : {}
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: typeof auth.expiresAt === 'number' ? auth.expiresAt : 0,
    refreshExpiresAtMs: typeof auth.refreshExpiresAt === 'number' ? auth.refreshExpiresAt : 0,
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    uid: typeof account.uid === 'string' ? account.uid : '',
    nickname: typeof account.nickname === 'string' ? account.nickname : '',
    enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : '',
  }
}

function isGlobal(domain) {
  const d = String(domain ?? '').trim().toLowerCase()
  return d === 'codebuddy.ai' || d.endsWith('.codebuddy.ai') || d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')
}

function chatBaseOf(credential) {
  return isGlobal(credential.domain) ? GLOBAL_CHAT_BASE : CN_CHAT_BASE
}

function billingBaseOf(credential) {
  return isGlobal(credential.domain) ? GLOBAL_BILLING_BASE : CN_BILLING_BASE
}

function baseHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': `${PRODUCT}/${APP_VERSION} ${PRODUCT}/${APP_VERSION} ${CLIENT_UA}`,
    'X-Requested-With': 'XMLHttpRequest',
    Origin: billingBaseOf(credential),
    Referer: `${billingBaseOf(credential)}/`,
    'Accept-Language': isGlobal(credential.domain) ? 'en-US' : 'zh-CN',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== '') headers['X-Enterprise-Id'] = credential.enterpriseId
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** 推理请求头（实测只要 Bearer，其余是保真项）。 */
function chatHeaders(credential) {
  return {
    ...baseHeaders(credential),
    Accept: 'text/event-stream',
    'X-Product': PRODUCT,
    'X-IDE-Name': PRODUCT,
    'X-IDE-Type': PRODUCT,
    'X-IDE-Version': APP_VERSION,
    'X-Agent-Purpose': 'conversation',
  }
}

async function readEnvelope(response) {
  const text = await response.text().catch(() => '')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AdapterError(`WorkBuddy 返回非 JSON（http ${response.status}）：${text.slice(0, 180)}`, {
      status: response.status,
    })
  }
  const code = typeof parsed.code === 'number' ? parsed.code : -1
  if (!response.ok || code !== 0) {
    const msg = typeof parsed.msg === 'string' && parsed.msg !== '' ? parsed.msg : `code ${code}`
    throw new AdapterError(`WorkBuddy 接口失败：${msg}（http ${response.status}）`, {
      status: response.status,
      permanent: response.status === 401 || response.status === 403,
    })
  }
  return parsed.data !== null && typeof parsed.data === 'object' ? parsed.data : {}
}

/**
 * 构造适配器。
 * @param {{warn?: (m: string) => void}} [options]
 */
export function createWorkBuddyAdapter(options = {}) {
  const warn = options.warn ?? (() => {})

  /** 读桌面客户端当前登录，返回账号快照列表（WorkBuddy 客户端一次只有一个活跃登录）。 */
  async function discoverNative() {
    const found = []
    for (const dir of authDirs()) {
      for (const basename of AUTH_BASENAMES) {
        const path = join(dir, basename)
        let text
        try {
          text = await readFile(path, 'utf8')
        } catch {
          continue
        }
        let document
        try {
          document = JSON.parse(text)
        } catch {
          continue
        }
        const credential = parseCredential(document)
        if (credential === undefined) continue
        const id = credential.uid !== '' ? credential.uid : `wb-${basename}`
        found.push({
          id,
          label: credential.nickname !== '' ? credential.nickname : id,
          credential,
          sourcePath: path,
        })
        // 同一目录里只要最新那份（文件名按优先级）
        break
      }
      if (found.length > 0) break
    }
    return found
  }

  /** 扫目录里所有备份文件，供「历史账号」回收（可选能力）。 */
  async function discoverBackups() {
    const out = []
    for (const dir of authDirs()) {
      let names
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.info') && !name.endsWith('.json')) continue
        if (AUTH_BASENAMES.includes(name)) continue
        try {
          const document = JSON.parse(await readFile(join(dir, name), 'utf8'))
          const credential = parseCredential(document)
          if (credential === undefined) continue
          const id = credential.uid !== '' ? credential.uid : name
          if (out.some((item) => item.id === id)) continue
          out.push({ id, label: credential.nickname || id, credential, sourcePath: join(dir, name) })
        } catch {
          // 坏文件跳过
        }
      }
    }
    return out
  }

  /** 用 refreshToken 换新 accessToken。 */
  async function refresh(credential) {
    if (credential.refreshToken === '') {
      throw new AdapterError('WorkBuddy 没有 refresh token，请重新登录桌面客户端', { permanent: true })
    }
    const headers = { ...baseHeaders(credential), 'X-Refresh-Token': credential.refreshToken, 'X-Auth-Refresh-Source': 'workbuddy' }
    delete headers['Content-Type']
    const response = await fetch(`${chatBaseOf(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const data = await readEnvelope(response)
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
    if (accessToken === '') {
      throw new AdapterError('WorkBuddy 续期没有返回 accessToken，请重新登录客户端', { permanent: true })
    }
    return {
      ...credential,
      accessToken,
      refreshToken: typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : credential.refreshToken,
      expiresAtMs: typeof data.expiresAt === 'number' ? data.expiresAt : Date.now() + 7 * 864e5,
    }
  }

  /** 带一次自动续期的 POST。返回 {data, credential}，credential 可能已更新。 */
  async function postJson(credential, path, body) {
    let current = credential
    if (current.expiresAtMs !== 0 && current.expiresAtMs <= Date.now()) {
      current = await refresh(current)
    }
    const send = (cred) =>
      fetch(`${billingBaseOf(cred)}${path}`, {
        method: 'POST',
        headers: baseHeaders(cred),
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
    let response = await send(current)
    if (response.status === 401) {
      current = await refresh(current)
      response = await send(current)
    }
    return { data: await readEnvelope(response), credential: current }
  }

  return {
    key: KEY,
    displayName: DISPLAY_NAME,
    discoverNative,
    discoverBackups,
    refresh,

    /** 认证状态。 */
    async probe(credential) {
      const expiration = credential.expiresAtMs ?? 0
      const state = expiration !== 0 && expiration <= Date.now() ? 'expired' : 'signed-in'
      return { state, account: credential.nickname || credential.uid }
    },

    /** 余额：有效积分包剩余之和。 */
    /**
     * 余额：按旧插件 dsh-connect-workbuddy 的口径算（逐字对照其
     * `parseUserCredits`）。
     *
     * 三个关键点，缺一个数字就不准：
     * 1. 剩余优先取 CycleCapacityRemain（本周期剩余），没有才退回
     *    CapacityRemain；且优先用 *Precise 字符串值（带小数）。
     * 2. CapacityType === 4 是月度包：不看过期、不看剩余是否为 0，一律计入。
     * 3. 非月度包：剩余 <= 0 或已过期就跳过。
     */
    async quota(credential) {
      const { data, credential: next } = await postJson(credential, '/v2/billing/meter/get-user-resource', {})
      const inner = data.Response?.Data ?? data
      const accounts = Array.isArray(inner.Accounts) ? inner.Accounts : []
      const now = Date.now()

      const precise = (account, key) => {
        const raw = account[`${key}Precise`]
        if (typeof raw === 'string' && raw !== '') {
          const parsed = Number.parseFloat(raw)
          if (Number.isFinite(parsed)) return parsed
        }
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw
        return typeof account[key] === 'number' ? account[key] : 0
      }
      const parseDate = (raw) => {
        if (typeof raw === 'number' && raw > 1e12) return raw
        if (typeof raw === 'string' && raw !== '') {
          const parsed = Date.parse(raw.replace(' ', 'T'))
          if (!Number.isNaN(parsed)) return parsed
        }
        return undefined
      }

      let total = 0
      let nearestExpiryMs
      let expiringSoon = 0
      const SOON_MS = 3 * 24 * 3600_000
      const packages = []

      for (const raw of accounts) {
        if (raw === null || typeof raw !== 'object') continue
        const monthly = raw.CapacityType === 4
        const size = precise(raw, 'CycleCapacitySize') || precise(raw, 'CapacitySize')
        const hasCycle = raw.CycleCapacityRemain !== undefined || raw.CycleCapacityRemainPrecise !== undefined
        const remainRaw = hasCycle ? precise(raw, 'CycleCapacityRemain') : precise(raw, 'CapacityRemain')
        const remain = remainRaw < 0 ? 0 : remainRaw
        const cycleEndMs = parseDate(raw.CycleEndTime)
        const expiresAtMs = monthly ? undefined : parseDate(raw.ExpiredTime) ?? cycleEndMs
        if (!monthly && (remain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= now))) continue
        total += remain
        if (expiresAtMs !== undefined) {
          if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs
          if (expiresAtMs - now <= SOON_MS) expiringSoon += remain
        }
        packages.push({
          name: typeof raw.PackageName === 'string' ? raw.PackageName : '',
          remain,
          size,
          monthly,
          expiresAtMs,
        })
      }

      return {
        remaining: Number.isFinite(total) ? Math.round(total * 100) / 100 : null,
        expiringSoon: Math.round(expiringSoon * 100) / 100,
        nearestExpiryMs,
        packageCount: packages.length,
        packages,
        fetchedAtMs: now,
        credential: next,
      }
    },

    /** 模型目录。口径对照旧插件的 parseUpstreamModel / withPromos。 */
    async listModels(credential) {
      let current = credential
      if (current.expiresAtMs !== 0 && current.expiresAtMs <= Date.now()) current = await refresh(current)
      const response = await fetch(`${billingBaseOf(current)}/v2/enterprises/personal/models`, {
        headers: baseHeaders(current),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      const data = await readEnvelope(response)
      const rawModels = Array.isArray(data.models) ? data.models : []

      // 促销、档位与目录在同一份文档里，不额外发请求
      const promos = parseWorkBuddyPromos(data.modelPromotions, data.modelTiers)
      const withPromos = attachPromos(rawModels, promos)
      const now = Date.now()

      return withPromos
        .map((raw) => {
          const id = typeof raw.id === 'string' ? raw.id : ''
          if (id === '' || raw.disabled === true) return undefined
          const input = typeof raw.maxInputTokens === 'number' ? raw.maxInputTokens : 0
          const output = typeof raw.maxOutputTokens === 'number' ? raw.maxOutputTokens : 0
          if (input <= 0 || output <= 0) return undefined

          // 倍率："x0.11 credits" → x0.11
          const creditMatch = typeof raw.credits === 'string' ? /x\s*([0-9]*\.?[0-9]+)/i.exec(raw.credits) : null
          const multiplier = creditMatch === null ? null : Number(creditMatch[1])

          // 推理档位：优先 supportedEfforts，单数形态 effort 视为默认档
          const reasoningRaw = raw.reasoning !== null && typeof raw.reasoning === 'object' ? raw.reasoning : undefined
          const supportedEfforts = Array.isArray(reasoningRaw?.supportedEfforts)
            ? reasoningRaw.supportedEfforts.filter((x) => typeof x === 'string')
            : undefined
          const singularEffort = typeof reasoningRaw?.effort === 'string' ? reasoningRaw.effort : undefined
          const defaultEffort =
            typeof reasoningRaw?.defaultEffort === 'string' ? reasoningRaw.defaultEffort : singularEffort ?? undefined
          const canDisableThinking =
            typeof reasoningRaw?.canDisableThinking === 'boolean'
              ? reasoningRaw.canDisableThinking
              : singularEffort !== undefined

          // 促销徽标：按当前时间挑一条
          const promo = selectPromoBadge(raw.promos, now)

          return {
            id,
            name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
            contextWindow: input,
            maxTokens: output,
            vision: raw.disabledMultimodal === true ? false : raw.supportsImages === true,
            badge: multiplier === null ? null : `x${multiplier}`,
            note: typeof raw.descriptionZh === 'string' ? raw.descriptionZh : null,
            promo: promo === undefined ? null : {
              label: promo.badge.label,
              color: promo.badge.color ?? null,
              hover: promo.hover?.textZh ?? null,
            },
            reasoning: supportedEfforts !== undefined || defaultEffort !== undefined,
            thinkingOptions: supportedEfforts ?? (defaultEffort === undefined ? [] : ['low', 'medium', 'high']),
            thinkingDefault: defaultEffort ?? null,
            canDisableThinking,
          }
        })
        .filter((model) => model !== undefined)
    },

    /** 签到状态（只读）。 */
    async checkInStatus(credential) {
      const { data, credential: next } = await postJson(credential, '/v2/billing/meter/checkin-activity-status', {})
      return {
        active: data.active === true,
        todayCheckedIn: data.today_checked_in === true,
        streakDays: typeof data.streak_days === 'number' ? data.streak_days : 0,
        dailyCredit: typeof data.daily_credit === 'number' ? data.daily_credit : 0,
        credential: next,
      }
    },

    /** 签到：已签过就直接返回。 */
    async checkIn(credential) {
      const status = await this.checkInStatus(credential)
      if (status.todayCheckedIn) {
        return { credit: 0, streakDays: status.streakDays, alreadyCheckedIn: true, credential: status.credential }
      }
      const { data, credential: next } = await postJson(status.credential, '/v2/billing/meter/daily-checkin', {})
      return {
        credit: typeof data.credit === 'number' ? data.credit : 0,
        streakDays: typeof data.streak_days === 'number' ? data.streak_days : status.streakDays,
        alreadyCheckedIn: false,
        credential: next,
      }
    },

    /** 推理 baseURL（pi-ai 会自己拼 /chat/completions）。 */
    chatBase(credential) {
      return `${chatBaseOf(credential)}/v2`
    },
  }
}
