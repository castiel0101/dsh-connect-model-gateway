/**
 * 豆包额度：`/alice/commerce/sale/subscription/quota/summary/`。
 *
 * 与其它平台的根本差别：豆包**没有整数积分**，额度是「窗口 × 百分比 × 上限」。
 * 所以这里把套餐包窗口折算成 `{remaining,total}`，并把原始窗口留着给 UI 显示
 * 「还剩 62%、12 小时后重置」。不能只看一个 section 的 `usage_exhausted` ——
 * 赠送额度有额度时套餐包可能是用尽的，判错会把还能用的账号标红。
 *
 * @module dsh-connect-model-gateway/core/doubao-quota
 */

import {
  QUOTA_ENDPOINT, CLIENT_PARAMS, DEFAULT_BOT_ID, DOUBAO_VERSION,
} from './doubao-catalog.js'
import { buildHeaders, buildQueryUrl, summarizeQuota } from './doubao-upstream.js'

const TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 30_000

let cached
let cachedAt = 0
let failure
let failureAt = 0

export function invalidateQuotaCache() {
  cached = undefined
  cachedAt = 0
  failure = undefined
  failureAt = 0
}

/**
 * 取额度。
 *
 * 失败不缓存太久：额度是高频刷新的信息，接口抖一下不该让用户等五分钟。
 */
export async function fetchQuota(options = {}) {
  const now = Date.now()
  const ttl = options.force === true ? 0 : TTL_MS
  if (cached !== undefined && now - cachedAt < ttl) return cached
  if (!options.force && failure !== undefined && now - failureAt < FAILURE_TTL_MS) {
    throw failure
  }

  const credentials = options.credentials
  if (credentials === undefined || credentials.ok !== true) {
    const error = new Error('还没有豆包登录态，无法读取额度')
    failure = error
    failureAt = now
    throw error
  }

  const url = buildQueryUrl(QUOTA_ENDPOINT, {
    aid: CLIENT_PARAMS.aid,
    bot_id: DEFAULT_BOT_ID,
    version_code: CLIENT_PARAMS.version_code,
    pc_version: DOUBAO_VERSION,
  })
  const headers = buildHeaders(credentials, {
    fingerprint: options.fingerprint,
    extra: {
      'content-type': 'application/json',
      origin: 'https://www.doubao.com',
      referer: 'https://www.doubao.com/chat/',
    },
  })

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ product_line: 'membership' }),
      signal: options.signal ?? AbortSignal.timeout(12_000),
    })
  } catch (error) {
    const wrapped = new Error(`查询豆包额度失败：${error?.message ?? error}`)
    failure = wrapped
    failureAt = now
    throw wrapped
  }
  if (!response.ok) {
    const wrapped = new Error(`查询豆包额度失败：HTTP ${response.status}`)
    failure = wrapped
    failureAt = now
    throw wrapped
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    const wrapped = new Error(`查询豆包额度失败：响应不是 JSON（${error?.message ?? error}）`)
    failure = wrapped
    failureAt = now
    throw wrapped
  }

  const summary = summarizeQuota(payload)
  cached = summary
  cachedAt = now
  failure = undefined
  failureAt = 0
  return summary
}

/** 诊断用：当前缓存状态，不含任何凭据。 */
export function quotaDiagnostics() {
  return {
    cached: cached !== undefined,
    cachedAtMs: cachedAt === 0 ? null : cachedAt,
    failure: failure?.message ?? null,
  }
}
