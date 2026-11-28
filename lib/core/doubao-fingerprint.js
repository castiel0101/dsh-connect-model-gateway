/**
 * 请求身份对齐。
 *
 * 风控（710022004）最常见的触发原因不是频率，而是**同一个账号在两个身份下
 * 发请求**：浏览器里是 Chrome 147 / macOS UA，插件发的却是桌面客户端串，
 * 服务端一眼就能看出「这不是我刚才见到的那个会话」。
 *
 * 所以这里做一件事：把浏览器自己发出的那次请求的身份（UA / Referer /
 * sec-ch-ua / 客户端 query 参数）记下来，出站时原样复用。没有记录时用桌面
 * 身份（`CLIENT_PARAMS` + UA 后缀），那是能工作的默认值。
 *
 * 存的是身份，不是凭据 —— 这个文件不含任何 cookie，可以安全地给人看。
 *
 * @module dsh-connect-model-gateway/core/doubao-fingerprint
 */

import { readBrowserFingerprint } from './doubao-auth.js'

/** 每次请求都要变、或不属于身份的 query 参数，抓的时候剔掉。 */
const VOLATILE_QUERY = new Set([
  'ms_token', 'mstoken', 'a_bogus', 'x-bogus', 'verifyfp', 'fp', 'timestamp', 'ts',
  'nonce', 'sign', 'signature', 'x-tt-passport-csrf-token', 'device_time',
])

/** 过滤掉易变参数，只留稳定的身份字段。 */
export function sanitizeFingerprintQuery(input) {
  const entries = typeof input === 'string'
    ? [...new URLSearchParams(input).entries()]
    : input instanceof URLSearchParams
      ? [...input.entries()]
      : Object.entries(input ?? {})
  const out = {}
  for (const [rawKey, value] of entries) {
    const key = String(rawKey).trim()
    if (key === '' || value === '' || value === undefined) continue
    if (VOLATILE_QUERY.has(key.toLowerCase())) continue
    out[key] = String(value)
  }
  return out
}

/**
 * 从一次观察到的请求构造身份；不可信就返回 undefined。
 *
 * 「不可信」的判据：不是豆包主域、没有 aid、没有 UA。缺任一条都说明这不是
 * app 自己的调用，拿它当身份会把请求伪装成别的站点。
 */
export function fingerprintFromRequest(url, headers) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.hostname !== 'www.doubao.com') return undefined
  const query = sanitizeFingerprintQuery(parsed.searchParams)
  if (query.aid === undefined) return undefined
  const header = (name) => headers?.[name] ?? headers?.[name.toLowerCase()] ?? ''
  const userAgent = header('User-Agent')
  if (userAgent === '') return undefined
  const secChUa = header('sec-ch-ua')
  return {
    userAgent,
    referer: header('Referer') || `${parsed.origin}/chat/`,
    ...(secChUa === '' ? {} : { secChUa }),
    query,
  }
}

/**
 * 把身份套到出站请求头上。
 *
 * 只覆盖 UA / Referer / sec-ch-ua 三样 + 额外的 query 参数由调用方合并；
 * 其余头保持插件自己的值，否则会缺 `content-type` 之类必需字段。
 */
export function applyFingerprintHeaders(headers, fingerprint) {
  if (fingerprint === undefined || fingerprint === null) return headers
  if (typeof fingerprint.userAgent === 'string' && fingerprint.userAgent !== '') {
    headers['user-agent'] = fingerprint.userAgent
  }
  if (typeof fingerprint.referer === 'string' && fingerprint.referer !== '') {
    headers.referer = fingerprint.referer
  }
  if (typeof fingerprint.secChUa === 'string' && fingerprint.secChUa !== '') {
    headers['sec-ch-ua'] = fingerprint.secChUa
  }
  if (typeof fingerprint.userAgent === 'string') {
    // platform 提示必须与 UA 一致，否则是更明显的特征
    headers['sec-ch-ua-platform'] = fingerprint.userAgent.includes('Macintosh')
      ? '"macOS"'
      : fingerprint.userAgent.includes('Windows') ? '"Windows"' : '"Linux"'
  }
  return headers
}

/** 身份里携带的 query 参数（合并到 URL 上）。 */
export function fingerprintQuery(fingerprint) {
  if (fingerprint === undefined || fingerprint === null) return {}
  const query = fingerprint.query
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return {}
  const out = {}
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/** 读落盘的身份；没有就 undefined。 */
export function loadFingerprint() {
  return readBrowserFingerprint()
}

/**
 * 进程级缓存：身份在一次运行内不变，每次请求都读盘没必要。
 */
let cached
let cachedAt = 0
const TTL = 60_000

export function currentFingerprint() {
  const now = Date.now()
  if (cached !== undefined && now - cachedAt < TTL) return cached
  cached = loadFingerprint()
  cachedAt = now
  return cached
}

export function invalidateFingerprint() {
  cached = undefined
  cachedAt = 0
}

/** 身份诊断：给设置页显示「当前用的是浏览器身份还是桌面身份」。 */
export function fingerprintSummary() {
  const fingerprint = currentFingerprint()
  if (fingerprint === undefined) {
    return { mode: 'desktop', detail: '用桌面客户端身份（默认）。若反复被人机验证，可抓一次浏览器身份。' }
  }
  const ua = fingerprint.userAgent
  const version = /Chrome\/(\d+)/.exec(ua)?.[1]
  return {
    mode: 'browser',
    detail: `用浏览器身份（Chrome ${version ?? '?'}）`,
    chromiumVersion: version,
  }
}
