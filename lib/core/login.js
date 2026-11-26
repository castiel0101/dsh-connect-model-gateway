/**
 * 登录流程（新增账号）。
 *
 * 两家都不需要我们自己造扫码：官方给的入口本来就是「浏览器打开 → 手机扫码/确认」。
 * 所以这里做的是**发起 + 轮询**，把结果落成一条账号。
 *
 * - WorkBuddy：POST {base}/v2/plugin/auth/state?platform=workbuddy 拿 state 与授权页，
 *   用户在网页里扫码/确认，插件轮询 GET /v2/plugin/auth/token?state=… 取 token，
 *   再 GET /v2/plugin/login/account 补 uid/昵称。
 * - CodeArts：华为云 OAuth2 PKCE + DPoP。本地起 127.0.0.1 回调服务，
 *   浏览器打开授权页，回调拿到 code，用 code+verifier+DPoP 换 security_token 与 AK/SK。
 *
 * 两套流程都对照旧插件 dsh-connect-workbuddy / dsh-codearts 的实现。
 *
 * @module dsh-connect-model-gateway/core/login
 */

import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 30_000
/** 登录会话有效期：足够扫码，又不至于一直挂着。 */
const SESSION_TTL_MS = 10 * 60_000

/** 进行中的登录会话。 */
const sessions = new Map()
/** 已完成的登录结果，保留 5 分钟：客户端可能多轮一次，不该报「会话不存在」。 */
const finished = new Map()

function rememberFinished(loginId, result) {
  finished.set(loginId, { at: Date.now(), result })
  // 顺手清掉过期的
  for (const [key, value] of finished) {
    if (Date.now() - value.at > 5 * 60_000) finished.delete(key)
  }
}

function json(value) {
  return value
}

async function readJson(response) {
  try {
    const text = await response.text()
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 上游信封里的 data。 */
function envelopeData(document) {
  if (document === undefined) return {}
  const data = document.data
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data
  return document
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function expiryMs(data, absoluteKeys, relativeKeys) {
  for (const key of absoluteKeys) {
    const value = data?.[key]
    if (typeof value === 'number' && value > 0) return value
  }
  for (const key of relativeKeys) {
    const value = data?.[key]
    if (typeof value === 'number' && value > 0) return Date.now() + value * 1000
  }
  return undefined
}

/** 从 JWT 载荷里取身份；解析不出返回 undefined。 */
export function identityFromJwt(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4)
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const sub = typeof claims.sub === 'string' ? claims.sub : ''
    const nickname =
      (typeof claims.nickname === 'string' && claims.nickname) ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      ''
    if (sub === '' && nickname === '') return undefined
    return { uid: sub, nickname }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- WorkBuddy

const WB_PREFIX = '/v2/plugin'

function wbBase(global) {
  return global ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
}

/**
 * 开始一次 WorkBuddy 登录。
 * @param {{global?: boolean}} [options]
 * @returns {Promise<{loginId:string, verificationUri:string, expiresIn:number}>}
 */
export async function startWorkBuddyLogin(options = {}) {
  const base = wbBase(options.global === true)
  let response
  try {
    response = await fetch(`${base}${WB_PREFIX}/auth/state?platform=workbuddy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`连不上 WorkBuddy 登录服务：${error instanceof Error ? error.message : String(error)}`)
  }
  const document = await readJson(response)
  const data = envelopeData(document)
  const state = firstString(data, ['state', 'State'])
  if (state === '') throw new Error(`WorkBuddy 没有签发 state（http ${response.status}）`)
  const verificationUri =
    firstString(data, ['authUrl', 'auth_url', 'url', 'Url']) || `${base}/login?state=${encodeURIComponent(state)}`

  const loginId = `wb_${randomUUID().replaceAll('-', '')}`
  sessions.set(loginId, { kind: 'workbuddy', base, state, expiresAtMs: Date.now() + SESSION_TTL_MS, done: false })
  return { loginId, verificationUri, expiresIn: Math.floor(SESSION_TTL_MS / 1000) }
}

/** 轮询一次 WorkBuddy 登录结果。 */
export async function pollWorkBuddyLogin(loginId) {
  const session = sessions.get(loginId)
  if (session === undefined || session.kind !== 'workbuddy') {
    const cached = finished.get(loginId)
    if (cached !== undefined) return { done: true, ...cached.result }
    return { done: true, error: '登录会话不存在，请重新发起' }
  }
  if (session.done) return { done: true, ...(session.result ?? {}) }
  if (Date.now() > session.expiresAtMs) {
    sessions.delete(loginId)
    return { done: true, error: '登录超时，请重新发起' }
  }

  let response
  try {
    response = await fetch(`${session.base}${WB_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { done: false }
  }
  const document = await readJson(response)
  if (document === undefined) return { done: false }
  const code = typeof document.code === 'number' ? document.code : -1
  if (code !== 0 && code !== 200) return { done: false }
  const data = envelopeData(document)
  const accessToken = firstString(data, ['accessToken', 'access_token', 'AccessToken'])
  if (accessToken === '') return { done: false }

  // 补账号信息
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  const domain = firstString(data, ['domain', 'Domain'])
  if (domain !== '') headers['X-Domain'] = domain
  let profile = {}
  try {
    profile = envelopeData(
      await readJson(
        await fetch(`${session.base}${WB_PREFIX}/login/account`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
      ),
    )
  } catch {
    // 拿不到账号信息也能用，只是标签难看
  }

  // 先试 JWT 声明（有 nickname 与 sub），再退回账号接口
  const claims = identityFromJwt(accessToken)
  const uid = firstString(profile, ['uid', 'Uid', 'userId', 'UserID']) || claims?.uid || ''
  const nickname = firstString(profile, ['nickname', 'NickName', 'ScreenName']) || claims?.nickname || ''
  const credential = {
    accessToken,
    refreshToken: firstString(data, ['refreshToken', 'refresh_token', 'RefreshToken']),
    expiresAtMs: expiryMs(data, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in']) ?? 0,
    refreshExpiresAtMs: expiryMs(data, ['refreshExpiresAt', 'refresh_expires_at'], ['refreshExpiresIn', 'refresh_expires_in']) ?? 0,
    domain: domain !== '' ? domain : firstString(profile, ['domain', 'Domain']),
    uid,
    nickname,
    enterpriseId: firstString(profile, ['enterpriseId', 'EnterpriseId']),
  }
  session.done = true
  session.result = { account: { id: uid !== '' ? uid : `wb_${accessToken.slice(0, 12)}`, label: nickname || uid || 'WorkBuddy 账号', credential } }
  rememberFinished(loginId, session.result)
  sessions.delete(loginId)
  return { done: true, ...session.result }
}

// ------------------------------------------------------------------ CodeArts

const CA_CLIENT_ID = 'codearts-agent'
const CA_PLUGIN_NAME = 'snap_AIIDE'
const CA_PLUGIN_VERSION = '5.2.0'
const CA_STS = 'https://sts.cn-north-4.myhuaweicloud.com'
const CA_PORTAL = 'https://codearts.huaweicloud.com/portal'
const CA_REDIRECT_PATH = '/oauth/callback'

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
const P256_HALF = P256_ORDER >> 1n

/** DPoP proof（ES256, P-256, 低 S 归一化）。 */
export async function dpopProof(jwk, htu) {
  const { createPrivateKey, createSign } = await import('node:crypto')
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

/**
 * 开始一次 CodeArts 登录：起本地回调服务，返回要打开的授权页。
 *
 * @returns {Promise<{loginId:string, verificationUri:string, expiresIn:number}>}
 */
export async function startCodeArtsLogin() {
  const { generateKeyPairSync } = await import('node:crypto')
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  const dpopKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }

  const verifier = base64url(randomBytes(64))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const ticketId = randomBytes(16).toString('hex')

  const loginId = `ca_${randomUUID().replaceAll('-', '')}`
  const session = {
    kind: 'codearts',
    dpopKey,
    verifier,
    expiresAtMs: Date.now() + SESSION_TTL_MS,
    done: false,
    server: undefined,
    port: 0,
  }

  // 本地回调服务：华为把 code 送到这里
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CA_REDIRECT_PATH) {
      response.writeHead(404).end()
      return
    }
    const code = url.searchParams.get('code') ?? ''
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px">已收到授权，可以关闭此页回到 DeepSeek Harness。</body>',
    )
    if (code === '') {
      session.done = true
      session.error = url.searchParams.get('error') ?? '授权没有返回 code'
      return
    }
    session.code = code
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  session.server = server
  session.port = server.address().port

  const query = new URLSearchParams({
    theme: '2',
    locale: 'zh-cn',
    uri_scheme: CA_CLIENT_ID,
    client_id: CA_CLIENT_ID,
    port: String(session.port),
    code_challenge: challenge,
    code_challenge_method: 'SHA-256',
    ticket_id: ticketId,
    'plugin-name': CA_PLUGIN_NAME,
    'plugin-version': CA_PLUGIN_VERSION,
  })

  sessions.set(loginId, session)
  return {
    loginId,
    verificationUri: `${CA_PORTAL}/authorize?${query.toString()}`,
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
  }
}

/** 轮询一次 CodeArts 登录结果。 */
export async function pollCodeArtsLogin(loginId) {
  const session = sessions.get(loginId)
  if (session === undefined || session.kind !== 'codearts') {
    const cached = finished.get(loginId)
    if (cached !== undefined) return { done: true, ...cached.result }
    return { done: true, error: '登录会话不存在，请重新发起' }
  }
  if (session.done) return { done: true, ...(session.result ?? { error: session.error }) }
  if (Date.now() > session.expiresAtMs) {
    session.server?.close()
    sessions.delete(loginId)
    return { done: true, error: '登录超时，请重新发起' }
  }
  if (session.code === undefined) return { done: false }

  // 用 code + verifier + DPoP 换 token
  const url = `${CA_STS}/v1/oauth2/tokens`
  const body = new URLSearchParams({
    client_id: CA_CLIENT_ID,
    grant_type: 'authorization_code',
    code: session.code,
    code_verifier: session.verifier,
    redirect_uri: `http://127.0.0.1:${session.port}${CA_REDIRECT_PATH}`,
  }).toString()
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: await dpopProof(session.dpopKey, url),
        'plugin-name': CA_PLUGIN_NAME,
        'plugin-version': CA_PLUGIN_VERSION,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    return { done: true, error: `换取 token 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const document = await readJson(response)
  if (!response.ok || document === undefined) {
    session.done = true
    session.server?.close()
    sessions.delete(loginId)
    return { done: true, error: `换取 token 失败：http ${response.status}` }
  }
  const credentials = document.credentials ?? {}
  const credential = {
    token: credentials.security_token ?? credentials.SecurityToken ?? '',
    securityToken: credentials.security_token ?? credentials.SecurityToken ?? '',
    accessKeyId: credentials.access_key_id ?? credentials.AccessKeyID ?? '',
    secretAccessKey: credentials.secret_access_key ?? credentials.SecretAccessKey ?? '',
    expiration: credentials.expiration ?? credentials.Expiration ?? '',
    refreshToken: document.refresh_token ?? document.RefreshToken ?? '',
    clientId: CA_CLIENT_ID,
    dpopPrivateKey: session.dpopKey,
    userId: document.user_id ?? '',
    userName: document.user_name ?? '',
    domainId: document.domain_id ?? '',
  }
  // 登录响应里没有身份，用签名端点补一次；补不到再用 refresh token 指纹兜底，
  // 这样同一账号重复登录不会产生第二条记录。
  if (credential.userId === '' && credential.token !== '') {
    const identity = await resolveCodeArtsIdentity(
      credential.token,
      credential.securityToken,
      credential.accessKeyId,
      credential.secretAccessKey,
    ).catch(() => undefined)
    if (identity !== undefined) {
      credential.userId = identity.userId
      credential.userName = identity.userName || credential.userName
      credential.domainId = identity.domainId || credential.domainId
    }
  }
  if (credential.token === '') {
    session.done = true
    session.server?.close()
    sessions.delete(loginId)
    return { done: true, error: '华为云没有返回 security_token' }
  }
  // 身份优先用 user_id；拿不到时用 refresh token 的摘要，保证同一账号稳定同一个 id
  const id =
    credential.userId !== ''
      ? credential.userId
      : `ca_${createHash('sha256').update(credential.refreshToken || credential.token).digest('hex').slice(0, 12)}`
  credential.id = id
  session.done = true
  session.server?.close()
  const result = { account: { id, label: credential.userName || id, credential } }
  rememberFinished(loginId, result)
  sessions.delete(loginId)
  return { done: true, ...result }
}

// --------------------------------------------------------------------- SCNet

const SC_PLATFORM = 'https://www.scnet.cn'
const SC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SC_SALT = '20250207'
const SC_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

function scPhone(raw) {
  const digits = String(raw ?? '').replace(/[\s-]/g, '').replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits
  return digits.length === 11 ? `+86${digits}` : digits
}

function scSign(phone) {
  const timestamp = Date.now()
  let sn = ''
  for (let i = 0; i < 10; i += 1) sn += SC_ALPHABET.charAt(Math.floor(Math.random() * SC_ALPHABET.length))
  const md5Str = createHash('md5').update(`${phone}${timestamp}${sn}${SC_SALT}`).digest('hex')
  return { timestamp, sn, md5Str }
}

/** 极简 Cookie 罐：登录三步必须共用同一个 jsessionid。 */
function scJar() {
  const store = new Map()
  return {
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const pair = String(raw).split(';')[0]
        const eq = pair.indexOf('=')
        if (eq <= 0) continue
        const key = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        if (value === '') store.delete(key)
        else store.set(key, value)
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    get(name) { return store.get(name) },
  }
}

async function scPost(jar, path, fields) {
  const response = await fetch(`${SC_PLATFORM}${path}`, {
    method: 'POST',
    headers: {
      'user-agent': SC_UA,
      referer: `${SC_PLATFORM}/ac/api/auth/loginSsoRedirect.action`,
      origin: SC_PLATFORM,
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...(jar.header() ? { cookie: jar.header() } : {}),
    },
    body: new URLSearchParams(Object.entries(fields).filter(([, value]) => value !== undefined)).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(25_000),
  })
  jar.absorb(response)
  const text = await response.text().catch(() => '')
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: response.status, json }
}

/** 平台英文报错 → 人话。码表对照旧插件 mapSmsError/translatePlatformMessage。 */
function scMessage(code, message, status) {
  const text = String(message ?? '')
  if (/[\u4e00-\u9fa5]/.test(text)) return text
  const map = {
    '1005': '发送太频繁，请稍后再试',
    '1009': '图形验证码不正确，请换一张重填',
    '3002': '图形验证码签名校验失败，请换一张重填',
    '1010': '不支持虚拟号段',
    '429': '尝试次数过多，请稍后再试',
  }
  if (map[code] !== undefined) return map[code]
  if (/too frequent|too often|in 60 seconds/i.test(text)) return '发送太频繁，请稍后再试'
  if (/virtual/i.test(text)) return '不支持虚拟号段'
  if (/captcha|signature failed/i.test(text)) return '图形验证码不正确，请换一张重填'
  if (/not exist|not registered/i.test(text)) return '该手机号尚未注册 SCNet 账号'
  if (/too many/i.test(text)) return '尝试次数过多，请稍后再试'
  return text !== '' ? text : `HTTP ${status}`
}

/**
 * SCNet 短信登录第一阶段：抓图形验证码 + 发短信码。
 * @returns {Promise<{loginId:string, captchaImage?:string, message?:string}>}
 */
/** 抓一张图形验证码（复用会话 jar，保证与后续签名同源）。 */
async function scCaptcha(session) {
  try {
    const response = await fetch(`${SC_PLATFORM}/sso/captcha.action`, {
      method: 'POST',
      headers: {
        'user-agent': SC_UA,
        referer: `${SC_PLATFORM}/ac/api/auth/loginSsoRedirect.action`,
        origin: SC_PLATFORM,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...(session.jar.header() ? { cookie: session.jar.header() } : {}),
      },
      body: '',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    session.jar.absorb(response)
    const data = await response.json().catch(() => undefined)
    const raw = String(data?.code) === '0' && typeof data?.data === 'string' ? data.data : ''
    if (raw === '') return undefined
    // 平台返回的是完整 data URI（data:image/jpeg;base64,…）；没有前缀时补上
    return raw.startsWith('data:image/') ? raw : `data:image/jpeg;base64,${raw}`
  } catch {
    // 拿不到图也能用签名兜底（平台前端就是这么做的）
    return undefined
  }
}

/**
 * 打开短信登录面板时先调这个：建会话 + 抓一张图形验证码。
 * 图形验证码必须在**填手机号之前**就可见，否则用户根本不知道该填什么。
 */
export async function startScnetCaptcha() {
  const loginId = `sc_${randomUUID().replaceAll('-', '')}`
  const session = { kind: 'scnet', jar: scJar(), phone: '', expiresAtMs: Date.now() + SESSION_TTL_MS, done: false }
  sessions.set(loginId, session)
  const captchaImage = await scCaptcha(session)
  return { loginId, captchaImage }
}

/**
 * 发送短信码。复用 startScnetCaptcha 建好的会话（同一个 jar），
 * 这样图形验证码、签名、后续提交都在一个会话里。
 */
export async function startScnetLogin(loginId, phone, captchaCode) {
  const normalized = scPhone(phone)
  if (!/^\+?\d{6,15}$/.test(normalized)) throw new Error('手机号格式不对')
  let session = sessions.get(loginId)
  if (session === undefined || session.kind !== 'scnet') {
    session = { kind: 'scnet', jar: scJar(), phone: normalized, expiresAtMs: Date.now() + SESSION_TTL_MS, done: false }
    sessions.set(loginId, session)
  }
  session.phone = normalized
  session.expiresAtMs = Date.now() + SESSION_TTL_MS
  const jar = session.jar

  const { timestamp, sn, md5Str } = scSign(normalized)
  const result = await scPost(jar, '/sso/sendRegisterMessageCode.action', {
    mobilephoneNum: normalized,
    captcha: captchaCode || md5Str,
    t: timestamp,
    sn,
    createBy: 'scnet',
    siteCode: 'sacp',
    service: `${SC_PLATFORM}/ac/api/auth/loginSsoRedirect.action`,
    originalUrl: `${SC_PLATFORM}/ac/api/auth/loginSsoRedirect.action`,
    sensorsAnonId: '',
  })
  const code = String(result.json?.code ?? '')
  // 0 = 未注册、1004 = 已注册，两者都算发码成功；必须记住区别以选登录/注册通道
  if (code !== '0' && code !== '1004') {
    // 不删会话：用户要能用同一张/换一张图形验证码重发，而不是从头再来
    throw new Error(`发短信失败：${scMessage(code, result.json?.msg, result.status)}`)
  }
  session.registered = code === '1004'
  // registered === false 表示这个号还没注册过。平台允许"注册即登录"，
  // 但用户可能根本不知道自己在建号，也可能想先去注册页完善信息 —— 两种都给出。
  /**
   * 图形验证码在 startScnetCaptcha 阶段已经给过，这里**不再重新抓**：
   * 短信是按上一张图签名的，此时换图只会让界面和实际签名对不上。
   * 之前这里引用了已删除的局部变量 `captchaImage`，直接抛 ReferenceError，
   * 表现就是「点获取验证码报错」。
   */
  return {
    loginId,
    registered: session.registered,
    registerUrl: `${SC_PLATFORM}/ui/acm/index.html#/login`,
  }
}

/** 刷新图形验证码（同一个会话换一张）。 */
export async function refreshScnetCaptcha(loginId) {
  const session = sessions.get(loginId)
  if (session === undefined || session.kind !== 'scnet') return { error: '登录会话不存在' }
  return { captchaImage: await scCaptcha(session) }
}

/** SCNet 短信登录第二阶段：提交短信码，跟随 ticket 换会话 Cookie。 */
export async function submitScnetLogin(loginId, smsCode) {
  const session = sessions.get(loginId)
  if (session === undefined || session.kind !== 'scnet') {
    const cached = finished.get(loginId)
    if (cached !== undefined) return { done: true, ...cached.result }
    return { done: true, error: '登录会话不存在，请重新获取验证码' }
  }
  if (Date.now() > session.expiresAtMs) {
    sessions.delete(loginId)
    return { done: true, error: '登录超时，请重新获取验证码' }
  }
  const viaRegister = session.registered === false
  const path = viaRegister ? '/sso/registerByMobilephoneNum.action' : '/sso/auth/login.action'
  const fields = viaRegister
    ? {
        mobilephoneNum: session.phone,
        messageCode: smsCode,
        createBy: 'scnet',
        siteCode: 'sacp',
        invitationCode: '',
        fullName: '',
        institution: '',
        service: `${SC_PLATFORM}/ac/api/auth/loginSsoRedirect.action`,
        originalUrl: `${SC_PLATFORM}/ac/api/auth/loginSsoRedirect.action`,
        sensorsAnonId: '',
      }
    : {
        service: `${SC_PLATFORM}/ac/api/auth/loginSsoRedirect.action`,
        originalUrl: `${SC_PLATFORM}/ac/api/auth/loginSsoRedirect.action`,
        sensorsAnonId: '',
        captcha: '',
        mobilephoneNum: session.phone,
        messageCode: smsCode,
        mode: '2',
      }
  const result = await scPost(session.jar, path, fields)
  if (String(result.json?.code) !== '0') {
    return { done: false, error: `${result.json?.msg ?? `http ${result.status}`}` }
  }
  // 跟随 ticket（最多一跳），让平台把 Token/jsessionid 写进 jar
  const target = String(result.json?.data ?? '')
  if (target !== '') {
    try {
      const url = target.startsWith('http') ? target : `${SC_PLATFORM}${target.startsWith('/') ? '' : '/'}${target}`
      const response = await fetch(url, {
        headers: { 'user-agent': SC_UA, ...(session.jar.header() ? { cookie: session.jar.header() } : {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      session.jar.absorb(response)
      const location = response.headers.get('location')
      if (location !== null && response.status >= 300 && response.status < 400) {
        const next = location.startsWith('http') ? location : `${SC_PLATFORM}${location.startsWith('/') ? '' : '/'}${location}`
        if (next.startsWith(SC_PLATFORM)) {
          const second = await fetch(next, {
            headers: { 'user-agent': SC_UA, ...(session.jar.header() ? { cookie: session.jar.header() } : {}) },
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
          session.jar.absorb(second)
        }
      }
    } catch {
      // 跟随失败会在下面按"没有会话 Cookie"报错
    }
  }
  const cookie = ['jsessionid', 'Token'].map((key) => {
    const value = session.jar.get(key)
    return value === undefined ? '' : `${key}=${value}`
  }).filter(Boolean).join('; ')
  if (!session.jar.get('Token')) {
    return { done: false, error: '平台返回成功但没有下发会话 Cookie（可能风控拦截），请重试' }
  }
  // 顺手取一次账号 id：换网关 key / 自动开通模型服务都要它，
  // 拿不到也不阻断登录（后续 ensureApiKey 会再试）。
  let accountId
  try {
    const identity = await (async () => {
      const response = await fetch(`${SC_PLATFORM}/acx/user/users/current-user-info?includeToken=true&refresh=true`, {
        headers: { 'user-agent': 'scnet-client/4.1.0', source: 'Electron', version: '4.1.0', accept: 'application/json', cookie },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      return (await response.json().catch(() => undefined))?.data
    })()
    if (identity?.id !== undefined) accountId = String(identity.id)
  } catch {
    // 取不到就留空
  }
  const id = `sc_${createHash('sha256').update(cookie).digest('hex').slice(0, 12)}`
  const credential = {
    kind: 'sms',
    cookie,
    accountId,
    account: { userName: session.phone, mobile: session.phone, id: accountId },
    apiKey: '',
  }
  sessions.delete(loginId)
  const outcome = { done: true, account: { id, label: session.phone, credential } }
  rememberFinished(loginId, outcome)
  return outcome
}

// --------------------------------------------------------------------- 灵犀

const LINGXI_BROWSERS = [
  process.env.DSH_LINGXI_BROWSER,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Volumes/JackSsd/DevCache/Library-Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
].filter((value) => typeof value === 'string' && value !== '')

/** 临时 profile + 调试端口启动浏览器；用户自己登录，插件只读 cookie（不碰密码）。 */
export async function startLingxiLogin() {
  let executable
  for (const candidate of LINGXI_BROWSERS) {
    try {
      await readFile(candidate)
      executable = candidate
      break
    } catch {
      // 试下一个
    }
  }
  if (executable === undefined) throw new Error('找不到可用浏览器（Chrome / Edge / Brave / Chromium）')

  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-connect-model-gateway-lingxi-'))
  // 直接打开 WPS 统一登录页（带灵犀回调 cb），而不是灵犀聊天首页。
  // 聊天首页要用户自己找右上角「登录」再点一次，容易让人以为"没登录入口"。
  const child = spawn(executable, [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    LINGXI_LOGIN_URL,
  ], { stdio: 'ignore', detached: true })
  child.unref?.()

  // 等 DevToolsActivePort 出现（最多 20 秒）
  let port
  for (let i = 0; i < 40; i += 1) {
    try {
      const text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')
      port = Number(text.split('\n')[0])
      if (Number.isInteger(port) && port > 0) break
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (port === undefined) {
    try { child.kill() } catch {}
    try { await rm(userDataDir, { recursive: true, force: true }) } catch {}
    throw new Error('浏览器调试端口没就绪，请重试')
  }

  const loginId = `lx_${randomUUID().replaceAll('-', '')}`
  const session = {
    kind: 'lingxi', child, userDataDir, port,
    expiresAtMs: Date.now() + SESSION_TTL_MS, done: false,
  }
  sessions.set(loginId, session)
  return { loginId, verificationUri: LINGXI_LOGIN_URL, expiresIn: Math.floor(SESSION_TTL_MS / 1000), browser: true }
}

/** 通过 CDP 只读 wps_sid cookie；拿到后关掉临时浏览器。 */
export async function pollLingxiLogin(loginId) {
  const session = sessions.get(loginId)
  if (session === undefined || session.kind !== 'lingxi') {
    const cached = finished.get(loginId)
    if (cached !== undefined) return { done: true, ...cached.result }
    return { done: true, error: '登录会话不存在，请重新发起' }
  }
  if (session.done) return { done: true, ...(session.result ?? { error: session.error }) }
  if (Date.now() > session.expiresAtMs) {
    session.done = true
    try { session.child.kill() } catch {}
    try { await rm(session.userDataDir, { recursive: true, force: true }) } catch {}
    sessions.delete(loginId)
    return { done: true, error: '登录超时，请重新发起' }
  }

  let targets
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/json/list`, { signal: AbortSignal.timeout(5000) })
    targets = await response.json()
  } catch {
    return { done: false }
  }
  // 登录过程会跳多个域（account.wps.cn → account.kdocs.cn → lingxi.kdocs.cn），
  // 临时 profile 里也不可能有别的站点，所以只要是有调试地址的 page 就接。
  const page = (Array.isArray(targets) ? targets : []).find(
    (target) => target?.type === 'page' && typeof target?.webSocketDebuggerUrl === 'string',
  )
  if (page?.webSocketDebuggerUrl === undefined) return { done: false }

  let cookies
  try {
    // 必须先 Network.enable 再 Network.getAllCookies（旧插件同样顺序），
    // 直接读会被 CDP 拒绝或拿到空列表。
    cookies = await new Promise((resolve, reject) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      const pending = new Map()
      let next = 1
      const timer = setTimeout(() => { try { ws.close() } catch {}; reject(new Error('CDP 超时')) }, 8000)
      const send = (method, params) => new Promise((res, rej) => {
        const id = next
        next += 1
        pending.set(id, { res, rej })
        ws.send(JSON.stringify({ id, method, params: params ?? {} }))
      })
      ws.onopen = async () => {
        try {
          await send('Network.enable')
          const result = await send('Network.getAllCookies')
          clearTimeout(timer)
          try { ws.close() } catch {}
          resolve(result?.cookies ?? [])
        } catch (error) {
          clearTimeout(timer)
          try { ws.close() } catch {}
          reject(error)
        }
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          const waiter = msg.id === undefined ? undefined : pending.get(msg.id)
          if (waiter === undefined) return
          pending.delete(msg.id)
          if (msg.error !== undefined) waiter.rej(new Error(msg.error?.message ?? 'CDP 错误'))
          else waiter.res(msg.result ?? {})
        } catch {
          // 忽略非 JSON 消息
        }
      }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }
    })
  } catch {
    return { done: false }
  }
  // wps_sid 是 WPS 全站 cookie，登录会写到 wps.cn / kdocs.cn / lingxi.* 之一；
  // 临时 profile 不会读到别的站点，所以按名称取第一个非空值即可。
  const wpsSid = (Array.isArray(cookies) ? cookies : []).find(
    (cookie) => cookie?.name === 'wps_sid' && String(cookie?.value ?? '').trim() !== '',
  )
  if (wpsSid?.value === undefined || wpsSid.value === '') return { done: false }

  const uidCookie = cookies.find((cookie) => cookie?.name === 'uid' || cookie?.name === 'wps_uid')
  const cookie = `wps_sid=${wpsSid.value}${uidCookie?.value !== undefined ? `; ${uidCookie.name}=${uidCookie.value}` : ''}`
  const id = `lx_${createHash('sha256').update(cookie).digest('hex').slice(0, 12)}`
  session.done = true
  try { session.child.kill() } catch {}
  try { await rm(session.userDataDir, { recursive: true, force: true }) } catch {}
  const outcome = { done: true, account: { id, label: uidCookie?.value ?? '灵犀账号', credential: { kind: 'cookie', cookie, nickname: '' } } }
  rememberFinished(loginId, outcome)
  sessions.delete(loginId)
  return outcome
}


/**
 * 用已签名的 current/user 端点取稳定身份。
 * 登录响应里的 user_id/user_name 实测为空串，只能靠这一步补。
 */
export async function resolveCodeArtsIdentity(token, securityToken, accessKeyId, secretAccessKey) {
  if (token === '') return undefined
  const { signedGet } = await import('./huawei-signer.js')
  const url = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/current/user'
  const result = await signedGet(url, { token, securityToken, accessKeyId, secretAccessKey })
  if (!result.ok) return undefined
  try {
    const body = JSON.parse(result.text)
    const userId = typeof body?.user_id === 'string' ? body.user_id : ''
    if (userId === '') return undefined
    return {
      userId,
      userName: typeof body?.user_name === 'string' ? body.user_name : '',
      domainId: typeof body?.domain_id === 'string' ? body.domain_id : '',
    }
  } catch {
    return undefined
  }
}

// --------------------------------------------------------------------- Meoo

/**
 * WPS 统一登录页（点灵犀右上角「登录」实际跳转的地址）。
 * cb 两层编码指向 account.kdocs.cn → lingxi.kdocs.cn，登录成功后 wps_sid 落在 kdocs/wps 域。
 */
const LINGXI_LOGIN_URL =
  'https://account.wps.cn/?protocolnames=lingxi_privacy%2Clingxi_agreements&cb=' +
  'https%3A%2F%2Faccount.kdocs.cn%2Fpassport%2Fsinglesign%3Fcb%3Dhttps%253A%252F%252Flingxi.kdocs.cn%252F'
const MEOO_CLIENT_ID = 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh'
const MEOO_API_BASE = 'https://meoo.com'
const MEOO_CALLBACK_PATH = '/oauth/callback'

/**
 * 开始一次 Meoo 登录：起本地回环回调服务，浏览器打开授权页，用户在 meoo.com 确认。
 * PKCE：verifier 32 字节随机，challenge = sha256(verifier)；state 32 字节随机防 CSRF。
 * 端口用 :0 随机分配，避免固定端口被占导致永久失败。
 * @returns {Promise<{loginId:string, verificationUri:string, expiresIn:number}>}
 */
export async function startMeooLogin() {
  const verifier = base64url(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = base64url(randomBytes(32))
  const loginId = `meoo_${randomUUID().replaceAll('-', '')}`
  const session = {
    kind: 'meoo', verifier, state,
    expiresAtMs: Date.now() + SESSION_TTL_MS,
    done: false, server: undefined, port: 0,
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== MEOO_CALLBACK_PATH) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px">已收到授权，可以关闭此页回到 DeepSeek Harness。</body>')
    if ((url.searchParams.get('state') ?? '') !== state) {
      session.done = true
      session.error = '授权回调 state 不匹配，请重新发起'
      return
    }
    const code = url.searchParams.get('code') ?? ''
    if (code === '') {
      session.done = true
      session.error = url.searchParams.get('error') ?? '授权没有返回 code'
      return
    }
    session.code = code
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  session.server = server
  session.port = server.address().port

  const query = new URLSearchParams({
    client_id: MEOO_CLIENT_ID,
    redirect_uri: `http://127.0.0.1:${session.port}${MEOO_CALLBACK_PATH}`,
    response_type: 'code',
    scope: 'cli.compat',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  sessions.set(loginId, session)
  return {
    loginId,
    verificationUri: `${MEOO_API_BASE}/oauth/authorize?${query.toString()}`,
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
  }
}

/** 轮询一次 Meoo 登录结果：回调拿到 code 后用 code+verifier 换 token。 */
export async function pollMeooLogin(loginId) {
  const session = sessions.get(loginId)
  if (session === undefined || session.kind !== 'meoo') {
    const cached = finished.get(loginId)
    if (cached !== undefined) return { done: true, ...cached.result }
    return { done: true, error: '登录会话不存在，请重新发起' }
  }
  if (session.done) return { done: true, ...(session.result ?? { error: session.error }) }
  if (Date.now() > session.expiresAtMs) {
    session.server?.close()
    sessions.delete(loginId)
    return { done: true, error: '登录超时，请重新发起' }
  }
  if (session.code === undefined) return { done: false }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: MEOO_CLIENT_ID,
    code: session.code,
    redirect_uri: `http://127.0.0.1:${session.port}${MEOO_CALLBACK_PATH}`,
    code_verifier: session.verifier,
  }).toString()
  let response
  try {
    response = await fetch(`${MEOO_API_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    return { done: true, error: `换取 token 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const token = await readJson(response)
  const describe = (value) => {
    for (const key of ['detail', 'message', 'msg', 'error']) {
      const text = firstString(value ?? {}, [key])
      if (text !== '') return text
    }
    return ''
  }
  if (!response.ok || token === undefined || firstString(token, ['access_token']) === '') {
    session.done = true
    session.server?.close()
    sessions.delete(loginId)
    return { done: true, error: `换取 token 失败（http ${response.status}）：${describe(token)}` }
  }

  const accessToken = firstString(token, ['access_token'])
  // 身份用 access token 读（name / user_id / project_url_id），拿不到也能用，只是标签难看
  let identity = {}
  try {
    const profile = await readJson(
      await fetch(`${MEOO_API_BASE}/open/v1/cli-compat/account/identity`, {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-meoo-client': 'cli',
          'x-meoo-cli-version': '0.5.6',
          authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    )
    identity = envelopeData(profile)
  } catch {
    // token 可用即可，身份稍后由 adapter 补
  }
  const uid = firstString(identity, ['user_id', 'userId'])
  const nickname = firstString(identity, ['name', 'nickname'])
  const credential = {
    kind: 'oauth',
    accessToken,
    refreshToken: firstString(token, ['refresh_token']),
    expiresAtMs: typeof token.expires_in === 'number' ? Date.now() + token.expires_in * 1000 : 0,
    uid,
    nickname,
    projectUrlId: firstString(identity, ['project_url_id', 'projectUrlId']),
    serviceAk: '',
    serviceAkProjectId: '',
  }
  const id = uid !== '' ? uid : `meoo_${accessToken.slice(0, 12)}`
  session.done = true
  session.server?.close()
  const result = { account: { id, label: nickname || id, credential } }
  rememberFinished(loginId, result)
  sessions.delete(loginId)
  return { done: true, ...result }
}

/**
 * 清理过期会话（插件卸载时调用）。
 * 浏览器型会话（灵犀 / 小浣熊）要顺手把临时浏览器与 profile 一起收掉，
 * 否则插件卸载后会留下一个孤零零的登录窗口和 /tmp 里的临时 profile。
 */
export function disposeLogins() {
  for (const session of sessions.values()) {
    session.server?.close?.()
    if (session.kind === 'lingxi' || session.kind === 'raccoon') {
      try { session.ws?.close?.() } catch {}
      try { session.child?.kill?.() } catch {}
      if (typeof session.userDataDir === 'string') {
        rm(session.userDataDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
  sessions.clear()
}

// --------------------------------------------------------------------- 小浣熊

/**
 * 小浣熊走**浏览器扫码**，但二维码不归我们画。
 *
 * 实测（2026-11-26）：登录接口给的 `scan_path` 是 `/login/mp` —— 微信小程序页面
 * 路径，不是可渲染的图片或 H5 地址；`/login/mp`、`/login/mp/<code>`、
 * `/login_with_qrcode_code?qrcode_code=…` 全部 404，抓包里也没有任何图片响应。
 * 也就是说二维码由小浣熊页面自己渲染（小程序码只能微信服务端出），插件拼不出来。
 *
 * 所以照灵犀的做法：起一个**临时 profile** 的浏览器，用户自己扫码登录，
 * 插件只在旁边把 token 收走。token 的来源按可靠性排两级：
 * 1. `Network.requestWillBeSent` 里该站请求的 `Authorization` 头（最准，页面自己发的）；
 * 2. 页面存储（localStorage / sessionStorage / cookie）里扫出来的 JWT（兜底）。
 */
const RACCOON_LOGIN_URL = 'https://xiaohuanxiong.com/work/home'
const RACCOON_ORIGIN = 'https://xiaohuanxiong.com'

/**
 * 找一个能用的 Chromium 系浏览器。
 *
 * 候选表之外再扫一遍 Playwright 的缓存目录：这台机器没装 Chrome，
 * 但 DSH 自带的浏览器依赖里有一份 Chrome for Testing。硬编码版本号会随着
 * 依赖升级失效，所以按目录扫（`chromium-*` 取版本号最大的那份）。
 */
async function findBrowser() {
  for (const candidate of LINGXI_BROWSERS) {
    try {
      await readFile(candidate)
      return candidate
    } catch {
      // 试下一个
    }
  }

  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    '/Volumes/JackSsd/DevCache/Library-Caches/ms-playwright',
    join(homedir(), '.cache', 'ms-playwright'),
  ].filter((value) => typeof value === 'string' && value !== '')

  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    const versions = entries
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const version of versions) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
      ]) {
        const candidate = join(root, version, rel)
        try {
          await readFile(candidate)
          return candidate
        } catch {
          // 试下一个
        }
      }
    }
  }
  return undefined
}

/** 起临时 profile 浏览器，返回调试端口。 */
async function launchTempBrowser(executable, url, tag) {
  const userDataDir = await mkdtemp(join(tmpdir(), `dsh-connect-model-gateway-${tag}-`))
  const child = spawn(executable, [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ], { stdio: 'ignore', detached: true })
  child.unref?.()
  for (let i = 0; i < 40; i += 1) {
    try {
      const text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')
      const port = Number(text.split('\n')[0])
      if (Number.isInteger(port) && port > 0) return { child, userDataDir, port }
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  try { child.kill() } catch {}
  try { await rm(userDataDir, { recursive: true, force: true }) } catch {}
  throw new Error('浏览器调试端口没就绪，请重试')
}

/** 关掉临时浏览器并清掉 profile。 */
async function closeTempBrowser(session) {
  try { session.ws?.close?.() } catch {}
  try { session.child?.kill?.() } catch {}
  if (typeof session.userDataDir === 'string') {
    try { await rm(session.userDataDir, { recursive: true, force: true }) } catch {}
  }
}

/** 在页面里扫存储，返回所有 JWT 形态的字符串（去重）。 */
const STORAGE_SCAN = `(() => {
  const out = []
  const push = (v) => {
    if (typeof v !== 'string') return
    const parts = v.split('.')
    if (parts.length === 3 && parts[0].startsWith('eyJ')) out.push(v)
  }
  for (const store of ['localStorage', 'sessionStorage']) {
    try {
      const s = window[store]
      for (let i = 0; i < s.length; i += 1) {
        const raw = s.getItem(s.key(i))
        if (!raw) continue
        push(raw)
        // 有些键存的是 JSON（{access_token: "..."}），再拆一层
        if (raw.trim().startsWith('{')) {
          try {
            const doc = JSON.parse(raw)
            for (const key of ['access_token', 'accessToken', 'token']) push(doc[key])
          } catch {}
        }
      }
    } catch {}
  }
  return out
})()`

/** 建一条到页面 target 的 CDP 连接，持续收集 Authorization 头。 */
function attachCapture(session) {
  return new Promise((resolve) => {
    const url = session.pageWsUrl
    if (typeof url !== 'string' || url === '') { resolve(false); return }
    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      resolve(false)
      return
    }
    session.ws = ws
    const pending = new Map()
    let next = 1
    session.send = (method, params) => new Promise((res, rej) => {
      const id = next
      next += 1
      pending.set(id, { res, rej })
      try { ws.send(JSON.stringify({ id, method, params: params ?? {} })) } catch (error) { rej(error) }
    })
    ws.onopen = () => {
      // 打开 Network 才能收到 requestWillBeSent；失败不影响后面的存储扫描
      session.send('Network.enable').catch(() => {})
      resolve(true)
    }
    ws.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      const waiter = msg.id === undefined ? undefined : pending.get(msg.id)
      if (waiter !== undefined) {
        pending.delete(msg.id)
        if (msg.error !== undefined) waiter.rej(new Error(msg.error?.message ?? 'CDP 错误'))
        else waiter.res(msg.result ?? {})
        return
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const request = msg.params?.request
        const target = String(request?.url ?? '')
        if (!target.startsWith(RACCOON_ORIGIN)) return
        const headers = request?.headers ?? {}
        for (const [name, value] of Object.entries(headers)) {
          if (name.toLowerCase() !== 'authorization') continue
          const token = String(value).replace(/^Bearer\s+/i, '').trim()
          if (token.split('.').length === 3) session.capturedToken = token
        }
      }
    }
    ws.onerror = () => resolve(false)
    setTimeout(() => resolve(ws.readyState === 1), 3000).unref?.()
  })
}

/**
 * 从 cookie 里捞 token。网页端可能把登录态放在 HttpOnly cookie，
 * 页面自己的请求就不会带 Authorization 头，只能靠 CDP 的 cookie 列表拿到。
 */
async function tokenFromCookies(session) {
  if (typeof session.send !== 'function') return undefined
  for (const method of ['Network.getAllCookies', 'Storage.getCookies']) {
    let result
    try {
      result = await session.send(method)
    } catch {
      continue
    }
    const cookies = Array.isArray(result?.cookies) ? result.cookies : []
    const matches = cookies
      .map((cookie) => String(cookie?.value ?? ''))
      .filter((value) => {
        const parts = value.split('.')
        if (parts.length !== 3 || !parts[0].startsWith('eyJ')) return false
        try {
          const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
          return String(payload?.iss ?? '').includes('xiaohuanxiong.com')
        } catch {
          return false
        }
      })
    if (matches.length > 0) return matches.sort((a, b) => (expiryOf(a) ?? 0) - (expiryOf(b) ?? 0)).pop()
  }
  return undefined
}

/** 从页面存储里捞 token（按 exp 优先取最晚失效的）。 */
async function tokenFromStorage(session) {
  if (typeof session.send !== 'function') return undefined
  let result
  try {
    result = await session.send('Runtime.evaluate', { expression: STORAGE_SCAN, returnByValue: true })
  } catch {
    return undefined
  }
  const values = result?.result?.value
  if (!Array.isArray(values) || values.length === 0) return undefined
  // 只认本平台的 token：payload 里 iss 必须指向 xiaohuanxiong.com
  const candidates = values.filter((token) => {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
      return String(payload?.iss ?? '').includes('xiaohuanxiong.com')
    } catch {
      return false
    }
  })
  if (candidates.length === 0) return undefined
  return candidates.sort((a, b) => (expiryOf(a) ?? 0) - (expiryOf(b) ?? 0)).pop()
}

function expiryOf(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const exp = Number(payload?.exp)
    return Number.isFinite(exp) ? exp : undefined
  } catch {
    return undefined
  }
}

/** 发起小浣熊登录：拉起临时浏览器到工作台，用户扫码。 */
export async function startRaccoonLogin() {
  const executable = await findBrowser()
  if (executable === undefined) throw new Error('找不到可用浏览器（Chrome / Edge / Brave / Chromium）')
  const { child, userDataDir, port } = await launchTempBrowser(executable, RACCOON_LOGIN_URL, 'raccoon')
  const loginId = `rc_${randomUUID().replaceAll('-', '')}`
  const session = {
    kind: 'raccoon', child, userDataDir, port,
    expiresAtMs: Date.now() + SESSION_TTL_MS, done: false,
    capturedToken: '', pageWsUrl: '', send: undefined, ws: undefined,
  }
  // 页面可能还在启动：target 晚一点才出现，所以连接放在轮询里做（见 ensureCapture）
  sessions.set(loginId, session)
  return {
    loginId,
    verificationUri: RACCOON_LOGIN_URL,
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
    browser: true,
  }
}

/** 每次轮询都确认一次 CDP 连接还在（页面导航会把 socket 掐掉）。 */
async function ensureCapture(session) {
  if (session.ws !== undefined && session.ws.readyState === 1) return true
  if (Date.now() - (session.attachAt ?? 0) < 1500) return false
  session.attachAt = Date.now()
  let targets
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/json/list`, { signal: AbortSignal.timeout(5000) })
    targets = await response.json()
  } catch {
    return false
  }
  const page = (Array.isArray(targets) ? targets : []).find(
    (target) => target?.type === 'page' && typeof target?.webSocketDebuggerUrl === 'string'
      && String(target?.url ?? '').startsWith(RACCOON_ORIGIN),
  ) ?? (Array.isArray(targets) ? targets : []).find(
    (target) => target?.type === 'page' && typeof target?.webSocketDebuggerUrl === 'string',
  )
  if (page?.webSocketDebuggerUrl === undefined) return false
  session.pageWsUrl = page.webSocketDebuggerUrl
  return await attachCapture(session)
}

/** 轮询小浣熊登录：拿到 token 就换账号资料、关浏览器。 */
export async function pollRaccoonLogin(loginId) {
  const session = sessions.get(loginId)
  if (session === undefined || session.kind !== 'raccoon') {
    const cached = finished.get(loginId)
    if (cached !== undefined) return { done: true, ...cached.result }
    return { done: true, error: '登录会话不存在，请重新发起' }
  }
  if (session.done) return { done: true, ...(session.result ?? { error: session.error }) }
  if (Date.now() > session.expiresAtMs) {
    session.done = true
    await closeTempBrowser(session)
    sessions.delete(loginId)
    return { done: true, error: '登录超时，请重新发起' }
  }

  await ensureCapture(session)
  // 三级来源：页面请求头里的 Bearer → cookie（站点可能用 HttpOnly cookie）→ 页面存储。
  // 只有一份是真的登录态，三者都按 JWT + iss 校验过，不会把 analytics 里的 base64 当 token。
  const fromHeader = session.capturedToken !== '' ? session.capturedToken : undefined
  const token = fromHeader ?? await tokenFromCookies(session) ?? await tokenFromStorage(session)
  if (token === undefined || token === '') return { done: false }

  // 拿 token 换昵称与稳定 id；换不到就当这条登录失败，别把半成品写进账号池
  let account
  try {
    const { accountFromToken } = await import('../adapters/raccoon.js')
    account = await accountFromToken(token)
  } catch (error) {
    return { done: false, detail: `已取到登录态，但读取账号资料失败：${error instanceof Error ? error.message : String(error)}` }
  }
  session.done = true
  await closeTempBrowser(session)
  const result = { account }
  rememberFinished(loginId, result)
  sessions.delete(loginId)
  return { done: true, ...result }
}
