/**
 * 华为云 SDK-HMAC-SHA256 请求签名。
 *
 * CodeArts 的推理端点必须用 AK/SK 签名，只带 x-auth-token 会被 APIG 拒
 * （`APIG.0301 decrypt token fail`）。pi-ai 只会发普通 Bearer，所以
 * CodeArts 必须经过本地 shim 转发，签名在这一层完成。
 *
 * @module dsh-connect-model-gateway/core/huawei-signer
 */

import { createHash, createHmac } from 'node:crypto'

const ALGORITHM = 'SDK-HMAC-SHA256'

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function hmacHex(key, message) {
  return createHmac('sha256', key).update(message).digest('hex')
}

/** 华为云 X-Sdk-Date 格式：20060102T150405Z（UTC，无分隔符无毫秒）。 */
export function sdkDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

/** 规范化 URI：逐段百分号编码，末尾补 `/`。 */
function canonicalUri(path) {
  let out = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  if (!out.endsWith('/')) out += '/'
  return out
}

/** 规范化 query：按 key 与 value 排序。 */
function canonicalQuery(raw) {
  if (!raw) return ''
  const params = new URLSearchParams(raw)
  const keys = [...new Set(params.keys())].sort()
  const parts = []
  for (const key of keys) {
    for (const value of params.getAll(key).sort()) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    }
  }
  return parts.join('&')
}

/**
 * 给一个 Request 补上签名头。
 *
 * `host` 由 URL 取出后补进待签集合：fetch 不允许手工设 Host，但签名必须含它。
 *
 * @param {Request} request
 * @param {Buffer} body 请求体（用于载荷哈希）
 * @param {{accessKeyId:string, secretAccessKey:string, securityToken?:string}} credential
 */
export function signRequest(request, body, credential) {
  const date = sdkDate()
  request.headers.set('X-Sdk-Date', date)
  if (credential.securityToken) request.headers.set('X-Security-Token', credential.securityToken)

  const payloadHash = sha256Hex(body)
  request.headers.set('X-Sdk-Content-Sha256', payloadHash)

  const url = new URL(request.url)
  const entries = []
  request.headers.forEach((value, key) => entries.push([key.toLowerCase(), value.trim()]))
  entries.push(['host', url.host])
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  let canonicalHeaders = ''
  const signedNames = []
  for (const [key, value] of entries) {
    canonicalHeaders += `${key}:${value}\n`
    signedNames.push(key)
  }
  const signedHeaders = signedNames.join(';')

  const canonicalRequest = [
    request.method,
    canonicalUri(url.pathname),
    canonicalQuery(url.search.slice(1)),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [ALGORITHM, date, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(credential.secretAccessKey, stringToSign)

  request.headers.set(
    'Authorization',
    `${ALGORITHM} Access=${credential.accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  )
  return request
}

/**
 * 带签名的 GET。
 *
 * @param {string} url
 * @param {{securityToken:string, accessKeyId?:string, secretAccessKey?:string}} credential
 * @param {string} [agentType] 需要的 `Agent-Type` 头（模型清单必须带 PromptCenter）
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok:boolean, status:number, text:string, message?:string}>}
 */
export async function signedGet(url, credential, agentType, signal) {
  const request = new Request(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Language': 'zh-cn',
      ...(agentType === undefined ? {} : { 'Agent-Type': agentType }),
      'X-Security-Token': credential.securityToken,
    },
  })
  if (credential.accessKeyId && credential.secretAccessKey) {
    signRequest(request, Buffer.from(''), {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
    })
  }
  let response
  try {
    response = await fetch(request, signal === undefined ? {} : { signal })
  } catch (error) {
    return { ok: false, status: 0, text: '', message: error instanceof Error ? error.message : String(error) }
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    return { ok: false, status: response.status, text, message: text.slice(0, 300) }
  }
  return { ok: true, status: response.status, text }
}
