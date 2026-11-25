/**
 * CodeArts 后台保活（独立子进程）。
 *
 * 为什么要单独进程：宿主进程忙或页面关掉时，主进程的定时器会被拖慢；
 * refresh_token 到期前没续上就掉登录。这里用独立进程按固定节奏续期，
 * 只写 `~/.dsh/.codearts-accounts.json`，不参与任何 UI。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 <node> keeper-main.js <accountsPath> [intervalMs]
 *
 * @module dsh-connect-model-gateway/core/keeper-main
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomBytes, createPrivateKey, createSign } from 'node:crypto'

const accountsPath = process.argv[2]
const intervalMs = Number(process.argv[3] ?? 15 * 60_000) || 15 * 60_000
const CLIENT_ID = 'codearts-agent'
const STS = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
const P256_HALF = P256_ORDER >> 1n

function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

function dpop(jwk, htu) {
  const key = createPrivateKey({ key: jwk, format: 'jwk' })
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } }
  const payload = { htm: 'POST', htu, iat: Math.floor(Date.now() / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(payload)))}`
  const sig = createSign('SHA256').update(input).sign({ key, dsaEncoding: 'ieee-p1363' })
  let s = sig.subarray(32, 64)
  let big = BigInt(`0x${s.toString('hex')}`)
  if (big > P256_HALF) {
    big = P256_ORDER - big
    s = Buffer.from(big.toString(16).padStart(64, '0'), 'hex')
  }
  return `${input}.${b64u(Buffer.concat([sig.subarray(0, 32), s]))}`
}

/** 续期一个账号；失败返回 undefined。 */
async function refresh(account) {
  if (typeof account.refreshToken !== 'string' || account.refreshToken === '' || account.dpopPrivateKey === undefined) return undefined
  const body = new URLSearchParams({
    client_id: account.clientId ?? CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
  }).toString()
  const response = await fetch(STS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: dpop(account.dpopPrivateKey, STS),
      'plugin-name': 'snap_AIIDE',
      'plugin-version': '5.2.0',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined)
  if (response === undefined || !response.ok) return undefined
  const json = await response.json().catch(() => undefined)
  if (json === undefined) return undefined
  const credentials = json.credentials ?? {}
  const token = credentials.security_token ?? credentials.SecurityToken ?? ''
  if (token === '') return undefined
  return {
    ...account,
    token,
    securityToken: token,
    accessKeyId: credentials.access_key_id ?? credentials.AccessKeyID ?? account.accessKeyId,
    secretAccessKey: credentials.secret_access_key ?? credentials.SecretAccessKey ?? account.secretAccessKey,
    expiration: credentials.expiration ?? credentials.Expiration ?? account.expiration,
    refreshToken: json.refresh_token ?? json.RefreshToken ?? account.refreshToken,
  }
}

async function tick() {
  let document
  try {
    document = JSON.parse(await readFile(accountsPath, 'utf8'))
  } catch {
    return
  }
  // 维护的是插件自己的状态：{ accounts: [{ id, label, credential }] }
  const accounts = Array.isArray(document.accounts) ? document.accounts : []
  let changed = false
  for (const entry of accounts) {
    const credential = entry?.credential
    if (credential === null || typeof credential !== 'object') continue
    const expiration = Date.parse(String(credential.expiration ?? '').replace(' ', 'T'))
    // 剩余不足 30 分钟就续
    if (!Number.isNaN(expiration) && expiration - Date.now() > 30 * 60_000) continue
    const next = await refresh(credential)
    if (next !== undefined) {
      entry.credential = next
      changed = true
    }
  }
  if (!changed) return
  const temporary = `${accountsPath}.keeper-${process.pid}`
  await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 })
  await rename(temporary, accountsPath)
}

await tick()
setInterval(() => void tick(), intervalMs)
