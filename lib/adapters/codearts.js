/**
 * CodeArts（华为云）适配器。无状态：凭证由上层传入。
 *
 * 上游事实（2026-11-24 实测）：
 * - 登录：华为云 OAuth2 PKCE + DPoP；refresh_token 与 DPoP 私钥绑定，续期必须同一把私钥。
 * - 推理：POST https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
 *     鉴权 = x-auth-token(STS security_token) + AK/SK SDK-HMAC-SHA256 签名。
 *     签名塞不进 pi-ai 的 Bearer 通道，所以推理走本地 shim。
 * - 目录：GET /v1/model/builtin，必须带 Agent-Type: PromptCenter。
 * - 积分：GET /snap-manager/v1/statistics/plugin → metrics[usageTotalPackageCredit]
 * - 签到：POST https://opengw.developer.huaweicloud.com/api/v1/benefit/claim
 *     该账号若没有福利活动会回 4000 "invalid channel, group not found"，视为「无可领取」。
 *
 * 原生多账号：`~/.dsh/.codearts-accounts.json` 本身就是 `{order:[], accounts:{}}`，
 * 每个账号独立 token/AK/SK/DPoP 私钥，所以这里能直接枚举出多个账号。
 *
 * @module dsh-connect-model-gateway/adapters/codearts
 */

import { readFile } from 'node:fs/promises'
import { randomBytes, createPrivateKey, createSign, generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AdapterError } from '../core/adapter.js'
import { signedGet, signRequest } from '../core/huawei-signer.js'

export const KEY = 'codearts'
export const DISPLAY_NAME = 'CodeArts'

const SNAP_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const STS_HOST = 'https://sts.cn-north-4.myhuaweicloud.com'
const BENEFIT_HOST = 'https://opengw.developer.huaweicloud.com'
const CLIENT_ID = 'codearts-agent'
const PLUGIN_NAME = 'snap_AIIDE'
const PLUGIN_VERSION = '5.2.0'

const EP_CHAT = '/api/v2/chat/completions'
const EP_MODEL_BUILTIN = '/v1/model/builtin'
const EP_STATISTICS = '/snap-manager/v1/statistics/plugin'
const EP_BENEFIT_CLAIM = '/api/v1/benefit/claim'
const EP_OPS_DELIVERY = '/v1/ops/delivery'
const EP_OPS_CLAIM = '/v1/ops/claim'
/** 每日签到活动的 type（实测 USER_LOGIN，benefitUnit=CREDIT）。 */
const WELFARE_DAILY_TYPE = 'USER_LOGIN'
/** 这几个状态都表示今天已经领过了。 */
const WELFARE_ALREADY_STATES = new Set(['CLAIMED', 'CONFIRMED', 'CONSUMED'])
/** 领取后上游仍可能回可领，按天去重时返回这个业务码。 */
const WELFARE_CODE_NOT_YET = 40001
const EP_TOKEN_BALANCE = '/api/v1/user/tokens/balance'
const EP_CURRENT_USER = '/snap-manager/v1/current/user'
const EP_THINKING_VARIANTS = '/v1/model/thinking-variants'

const TIMEOUT_MS = 30_000
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
const P256_HALF = P256_ORDER >> 1n

const MODEL_ALIAS = {
  'snap-chat': 'GLM-5.2',
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-4.7': 'GLM-4.7',
  'openpangu-2.0-pro': 'OpenPangu-2.0-Pro',
  'openpangu-2.0-flash': 'OpenPangu-2.0-Flash',
  'qwen3-vl-235b': 'Qwen3-VL-235B',
  'deepseek-v4-flash': 'deepseek-v4-flash-0731',
  'deepseek-v4-pro': 'deepseek-v4-pro-0813',
  'glm-5.3-flash': 'glm-5.3-flash',
}

export function canonicalModel(id) {
  return MODEL_ALIAS[String(id ?? '').toLowerCase()] ?? id
}

/** 默认账号文件位置（沿用旧插件，卸载后登录态不丢）。 */
export function defaultAccountsPath(home = homedir()) {
  return join(home, '.dsh', '.codearts-accounts.json')
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

/** DPoP proof：ES256 + P-256，低 S 归一化。 */
export function signDpopProof(jwk, htu) {
  const key = createPrivateKey({ key: jwk, format: 'jwk' })
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } }
  const payload = { htm: 'POST', htu, iat: Math.floor(Date.now() / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`
  const signature = createSign('SHA256').update(input).sign({ key, dsaEncoding: 'ieee-p1363' })
  let s = signature.subarray(32, 64)
  let sBig = BigInt(`0x${s.toString('hex')}`)
  if (sBig > P256_HALF) {
    sBig = P256_ORDER - sBig
    s = Buffer.from(sBig.toString(16).padStart(64, '0'), 'hex')
  }
  return `${input}.${base64url(Buffer.concat([signature.subarray(0, 32), s]))}`
}

/** 生成新的 DPoP 私钥 JWK（备用，登录流程用）。 */
export function newDpopKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }
}

function parseTokenResponse(json, dpopKey, clientId, previous) {
  const credentials = json.credentials ?? {}
  return {
    token: credentials.security_token ?? credentials.SecurityToken ?? '',
    securityToken: credentials.security_token ?? credentials.SecurityToken ?? '',
    accessKeyId: credentials.access_key_id ?? credentials.AccessKeyID ?? '',
    secretAccessKey: credentials.secret_access_key ?? credentials.SecretAccessKey ?? '',
    expiration: credentials.expiration ?? credentials.Expiration ?? '',
    refreshToken: json.refresh_token ?? json.RefreshToken ?? previous?.refreshToken ?? '',
    clientId,
    dpopPrivateKey: dpopKey,
    userId: json.user_id ?? previous?.userId ?? '',
    userName: json.user_name ?? previous?.userName ?? '',
    domainId: json.domain_id ?? previous?.domainId ?? '',
  }
}

/**
 * 构造适配器。
 * @param {{accountsPath?: () => string, warn?: (m: string) => void}} [options]
 */
export function createCodeArtsAdapter(options = {}) {
  const warn = options.warn ?? (() => {})
  const accountsPath = options.accountsPath ?? (() => defaultAccountsPath())

  /** 读原生账号文件，枚举所有账号。 */
  async function discoverNative() {
    let document
    try {
      document = JSON.parse(await readFile(accountsPath(), 'utf8'))
    } catch {
      return []
    }
    const order = Array.isArray(document.order) ? document.order : []
    const accounts = document.accounts !== null && typeof document.accounts === 'object' ? document.accounts : {}
    const out = []
    for (const id of order) {
      const account = accounts[id]
      if (account === null || typeof account !== 'object') continue
      if (typeof account.token !== 'string' || account.token === '') continue
      out.push({
        id: String(id),
        label: account.userName || account.label || String(id),
        credential: { ...account, securityToken: account.securityToken ?? account.token, id: String(id) },
        sourcePath: accountsPath(),
      })
    }
    return out
  }

  /** 用 refresh_token + 同一把 DPoP 私钥续期。 */
  async function refresh(credential) {
    if (typeof credential.refreshToken !== 'string' || credential.refreshToken === '') {
      throw new AdapterError('CodeArts 没有 refresh token，请重新登录', { permanent: true })
    }
    const url = `${STS_HOST}/v1/oauth2/tokens`
    const dpop = signDpopProof(credential.dpopPrivateKey, url)
    const body = new URLSearchParams({
      client_id: credential.clientId ?? CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
    }).toString()
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          DPoP: dpop,
          'plugin-name': PLUGIN_NAME,
          'plugin-version': PLUGIN_VERSION,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new AdapterError(`CodeArts 续期网络失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      throw new AdapterError(`CodeArts 续期失败：${response.status} ${text.slice(0, 180)}`, {
        status: response.status,
        permanent,
      })
    }
    const json = await response.json()
    const next = parseTokenResponse(json, credential.dpopPrivateKey, credential.clientId ?? CLIENT_ID, credential)
    next.id = credential.id
    if (!next.token) throw new AdapterError('CodeArts 续期没有返回 security_token，请重新登录', { permanent: true })
    return next
  }

  /** 过期就先续。 */
  async function ensureFresh(credential) {
    const expiration = Date.parse(String(credential.expiration ?? '').replace(' ', 'T'))
    if (!Number.isNaN(expiration) && expiration - 5 * 60_000 <= Date.now()) {
      return refresh(credential)
    }
    return credential
  }

  /** 签名 GET，401/403 续一次。返回 {result, credential}。 */
  async function get(credential, url, agentType) {
    let current = await ensureFresh(credential)
    let result = await signedGet(url, current, agentType)
    if (!result.ok && (result.status === 401 || result.status === 403)) {
      current = await refresh(current)
      result = await signedGet(url, current, agentType)
    }
    return { result, credential: current }
  }

  /**
   * 福利接口：签名 + 官方那套头，返回解析后的 body。
   * 与旧插件 dsh-codearts 的 welfareRequest 一致。
   */
  async function welfareRequest(credential, url, method, body) {
    const bodyBuffer = Buffer.from(body ?? '')
    const request = new Request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Language': 'zh-cn',
        'x-snap-traceid': randomBytes(16).toString('hex'),
        'x-auth-token': credential.token,
        'Agent-Type': 'PromptCenter',
        'X-Security-Token': credential.securityToken,
      },
      ...(body === undefined ? {} : { body: bodyBuffer }),
    })
    if (credential.accessKeyId && credential.secretAccessKey) {
      signRequest(request, bodyBuffer, {
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        securityToken: credential.securityToken,
      })
    }
    let response
    try {
      response = await fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (error) {
      return { ok: false, code: -1, message: error instanceof Error ? error.message : String(error) }
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) return { ok: false, code: response.status, message: `HTTP ${response.status} ${text.slice(0, 160)}` }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, code: -1, message: 'non-JSON response' }
    }
    return {
      ok: true,
      code: typeof parsed.code === 'number' ? parsed.code : 0,
      message: typeof parsed.message === 'string' ? parsed.message : '',
      data: parsed.data,
    }
  }

  return {
    key: KEY,
    displayName: DISPLAY_NAME,
    needsShim: true,
    discoverNative,
    refresh,

    async probe(credential) {
      const expiration = Date.parse(String(credential.expiration ?? '').replace(' ', 'T'))
      const remaining = Number.isNaN(expiration) ? null : expiration - Date.now()
      const state = remaining !== null && remaining <= 0 ? 'expired' : remaining !== null && remaining <= 3600_000 ? 'expiring' : 'signed-in'
      return { state, account: credential.userName || credential.userId || credential.id }
    },

    /** 余额。 */
    async quota(credential) {
      const { result, credential: next } = await get(credential, `${SNAP_HOST}${EP_STATISTICS}`)
      if (!result.ok) {
        throw new AdapterError(`CodeArts 积分读取失败：${result.status} ${result.message ?? ''}`.trim(), {
          status: result.status,
        })
      }
      let body
      try {
        body = JSON.parse(result.text)
      } catch {
        throw new AdapterError('CodeArts 积分响应不是 JSON')
      }
      const metrics = Array.isArray(body.metrics) ? body.metrics : []
      const total = metrics.find((metric) => metric?.name === 'usageTotalPackageCredit')
      let tokens
      try {
        const balance = await get(next, `${BENEFIT_HOST}${EP_TOKEN_BALANCE}`)
        if (balance.result.ok) {
          const inner = JSON.parse(balance.result.text)?.result ?? {}
          tokens = {
            balance: typeof inner.total_balance === 'number' ? inner.total_balance : null,
            quota: typeof inner.total_quota === 'number' ? inner.total_quota : null,
            dailyUsed: typeof inner.daily_tokens_used === 'number' ? inner.daily_tokens_used : null,
            dailyLimit: typeof inner.daily_token_limit === 'number' ? inner.daily_token_limit : null,
          }
        }
      } catch {
        // token 额度是次要接口
      }
      return {
        remaining: typeof total?.package_credit_remain === 'number' ? total.package_credit_remain : null,
        total: typeof total?.package_credit_amount === 'number' ? total.package_credit_amount : null,
        expiring: typeof total?.package_credit_expiring_amount === 'number' ? total.package_credit_expiring_amount : null,
        resetAt:
          typeof body.start_date === 'string' && typeof body.end_date === 'string'
            ? `${body.start_date} ~ ${body.end_date}`
            : null,
        plan: body.package?.package_name_cn ?? null,
        tokens,
        fetchedAtMs: Date.now(),
        credential: next,
      }
    },

    /** 模型目录。倍率取 default 时段。 */
    async listModels(credential) {
      const { result, credential: next } = await get(credential, `${SNAP_HOST}${EP_MODEL_BUILTIN}`, 'PromptCenter')
      if (!result.ok) {
        throw new AdapterError(`CodeArts 模型目录读取失败：${result.status} ${result.message ?? ''}`.trim(), {
          status: result.status,
        })
      }
      let body
      try {
        body = JSON.parse(result.text)
      } catch {
        throw new AdapterError('CodeArts 模型目录响应不是 JSON')
      }
      const list = Array.isArray(body.builtinModels) ? body.builtinModels : []
      // 目录拿到后再查一次思考强度清单（普通账号也有权限）
      const names = list.map((model) => String(model.model_id ?? model.model_name ?? '')).filter((x) => x !== '')
      const variants = await this.thinkingVariants(next, names).catch(() => new Map())
      return {
        credential: next,
        models: list
          .filter((model) => model?.enable !== false)
          .map((model) => {
            const id = String(model.model_id ?? model.model_name ?? '')
            const credits = Array.isArray(model.credit) ? model.credit : []
            const preferred =
              credits.find((entry) => entry?.time_slot_id === 'default') ??
              credits.find((entry) => entry?.time_slot_id === null || entry?.time_slot_id === undefined) ??
              credits[0]
            return {
              id,
              name: String(model.model_name ?? id),
              contextWindow:
                typeof model.context_window === 'number' && model.context_window > 0 ? model.context_window : 32_768,
              maxTokens: typeof model.max_tokens === 'number' && model.max_tokens > 0 ? model.max_tokens : 8_000,
              vision: model.supports_images === true,
              badge: typeof preferred?.ratio_display === 'string' ? preferred.ratio_display : null,
              note: typeof model.model_desc === 'string' ? model.model_desc : null,
              promo: null,
              ...(() => {
                const variant = variants.get(id.toLowerCase())
                if (variant === undefined) return { reasoning: false, thinkingOptions: [], thinkingDefault: null }
                return {
                  reasoning: true,
                  thinkingOptions: variant.strengths,
                  thinkingDefault: variant.default ?? variant.strengths[0] ?? null,
                }
              })(),
            }
          })
          .filter((model) => model.id !== ''),
        credential: next,
      }
    },

    /** 思考强度清单：POST /v1/model/thinking-variants，必须带 Agent-Type。 */
    async thinkingVariants(credential, modelNames) {
      const out = new Map()
      if (modelNames.length === 0) return out
      for (let start = 0; start < modelNames.length; start += 50) {
        const slice = modelNames.slice(start, start + 50)
        const bodyBuffer = Buffer.from(JSON.stringify({ model_names: slice }))
        const request = new Request(`${SNAP_HOST}${EP_THINKING_VARIANTS}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-auth-token': credential.token,
            'X-Security-Token': credential.securityToken,
            'x-snap-traceid': randomBytes(16).toString('hex'),
            'X-Language': 'zh-cn',
            'Agent-Type': 'PromptCenter',
          },
          body: bodyBuffer,
        })
        if (credential.accessKeyId && credential.secretAccessKey) {
          signRequest(request, bodyBuffer, {
            accessKeyId: credential.accessKeyId,
            secretAccessKey: credential.secretAccessKey,
            securityToken: credential.securityToken,
          })
        }
        let response
        try {
          response = await fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        } catch {
          continue
        }
        if (!response.ok) continue
        let body
        try {
          body = JSON.parse(await response.text())
        } catch {
          continue
        }
        const variants = body?.variants !== null && typeof body?.variants === 'object' ? body.variants : {}
        for (const [name, raw] of Object.entries(variants)) {
          const strengths = Array.isArray(raw?.strengths) ? raw.strengths.filter((x) => typeof x === 'string') : []
          if (strengths.length === 0) continue
          out.set(String(name).trim().toLowerCase(), {
            strengths,
            default: typeof raw.default_strength === 'string' ? raw.default_strength : undefined,
          })
        }
      }
      return out
    },

    /** 签到状态：拉福利活动清单，找每日签到那条。 */
    async checkInStatus(credential) {
      const current = await ensureFresh(credential)
      const result = await welfareRequest(current, `${SNAP_HOST}${EP_OPS_DELIVERY}?channel=IDE`, 'GET')
      if (!result.ok) {
        // 拉不到活动清单 = 这个账号没有签到入口，按「无活动」处理而不是报错
        return { available: false, reason: result.message, credential: current }
      }
      const items = Array.isArray(result.data?.items) ? result.data.items : []
      const daily = items.filter((item) => item?.type === WELFARE_DAILY_TYPE && item?.benefitUnit === 'CREDIT')
      const target = daily.find((item) => item.claimable === true) ?? daily[0]
      if (target === undefined) return { available: false, credential: current }
      return {
        available: true,
        claimable: target.claimable === true,
        claimedToday: WELFARE_ALREADY_STATES.has(String(target.status ?? '')),
        amount: typeof target.benefitAmount === 'number' ? target.benefitAmount : 0,
        title: typeof target.title === 'string' ? target.title : null,
        campaignId: target.campaignId,
        status: target.status,
        credential: current,
      }
    },

    /** 签到 = 领每日福利积分。没有活动就返回 unavailable，不报错。 */
    async checkIn(credential) {
      const status = await this.checkInStatus(credential)
      if (!status.available) {
        return { credit: 0, alreadyCheckedIn: false, unavailable: true, detail: status.reason, credential: status.credential }
      }
      if (status.claimedToday) return { credit: 0, alreadyCheckedIn: true, credential: status.credential }
      if (!status.claimable) {
        return { credit: 0, alreadyCheckedIn: false, unavailable: true, detail: status.status, credential: status.credential }
      }
      const body = JSON.stringify({
        campaignId: status.campaignId,
        idempotentKey: randomBytes(16).toString('hex'),
        channel: 'IDE',
      })
      const result = await welfareRequest(status.credential, `${SNAP_HOST}${EP_OPS_CLAIM}`, 'POST', body)
      if (!result.ok) {
        return { credit: 0, alreadyCheckedIn: false, error: result.message, credential: status.credential }
      }
      // 40001 = 今天已经领过（领取后几十秒上游可能还回可领状态）
      if (result.code === WELFARE_CODE_NOT_YET) {
        return { credit: 0, alreadyCheckedIn: true, credential: status.credential }
      }
      if (result.code !== 0) {
        return { credit: 0, alreadyCheckedIn: false, error: result.message, credential: status.credential }
      }
      return { credit: status.amount, alreadyCheckedIn: false, credential: status.credential }
    },

    /**
     * 查账号身份（稳定 user_id）。
     * 登录响应里 user_id / user_name 实测都是空串，只能靠这个端点补。
     */
    async fetchIdentity(credential) {
      const result = await signedGet(`${SNAP_HOST}${EP_CURRENT_USER}`, credential)
      if (!result.ok) return undefined
      let body
      try {
        body = JSON.parse(result.text)
      } catch {
        return undefined
      }
      const userId = typeof body?.user_id === 'string' ? body.user_id : ''
      if (userId === '') return undefined
      return {
        userId,
        userName: typeof body?.user_name === 'string' ? body.user_name : '',
        domainId: typeof body?.domain_id === 'string' ? body.domain_id : '',
      }
    },

    /** 上游聊天端点（给 shim 用）。 */
    chatUrl: () => `${SNAP_HOST}${EP_CHAT}`,

    /** 给 shim 用：把凭证刷新到最新。 */
    ensureFresh,
  }
}
