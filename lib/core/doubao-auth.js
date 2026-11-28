/**
 * 豆包凭据：扫码登录抓 cookie，本机 AES-256-GCM 密封。
 *
 * 为什么只有这一个来源（照抄旧插件踩过的坑，别再走回头路）：
 * - 读桌面客户端 cookie jar 的方案已经删掉，不是弃用。客户端运行时对
 *   `Default/Network/Cookies` 持有**排他锁**，而这个插件存在的意义恰恰是给
 *   「客户端正在跑」的账号用；于是正常场景读不到，代码退化成 12 小时前的
 *   密封副本，服务端一轮换会话就全盘 401，而本地状态还显示「已登录」。
 * - 浏览器扫码没有这两种失败模式：cookie 从一次性 Chromium profile 经 CDP
 *   抓回来，没有锁要丢；密封的就是刚抓到的，没有旧副本可优先。
 *
 * 安全：cookie 只在本进程内存与一个密封文件里。macOS 走 Keychain 取密钥
 * （Keychain 不可写时退化为 0600 的密钥文件），Windows 走 DPAPI。不落日志，
 * 不出现在环境变量里，唯一出口是出站请求的 `Cookie:` 头。
 *
 * @module dsh-connect-model-gateway/core/doubao-auth
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'

/** 登录结果在进程缓存里的存活时间。不是安全边界，只是省掉重复解密。 */
export const CREDENTIAL_TTL_MS = 10 * 60 * 1000

/**
 * 真正决定认证成败的 cookie。
 *
 * 登录时仍会等那一整套（含 ttwid / s_v_web_id 这类反爬与过期标记），但
 * 加载时不会因为某个辅助跟踪 cookie 被拦就丢掉一份本来能用的会话。
 */
export const CORE_AUTH_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt']

export const REQUIRED_COOKIE_NAMES = [
  'sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt',
  'ttwid', 'odin_tt', 'passport_csrf_token', 's_v_web_id',
]

/** 密封文件与指纹文件。文件名沿用旧插件，已登录的机器不用重扫。 */
export function credentialsPath() {
  return join(homedir(), '.dsh', 'doubao-credentials-browser.dpapi')
}

export function fingerprintPath() {
  return join(homedir(), '.dsh', 'doubao-browser-fingerprint.json')
}

const PORTABLE_MAGIC = Buffer.from('DSHDOUBAO2')
const PORTABLE_IV_BYTES = 12
const PORTABLE_TAG_BYTES = 16
const PORTABLE_KEY_BYTES = 32
/**
 * Keychain 条目名沿用旧插件 dsh-connect-doubao 的值。
 *
 * 换了名字就等于换了一把密钥：已经扫码登录过的机器会因为「解不开」被要求
 * 重新扫码，而用户完全没做错任何事。账号名用登录名，同样是旧值。
 */
const KEYCHAIN_SERVICE = 'dsh-connect-doubao-credentials'
const KEYCHAIN_ACCOUNT = process.env.USER ?? process.env.LOGNAME ?? 'doubao'
const HEX_KEY = /^[0-9a-f]{64}$/i

/** 密钥随机会话的落盘路径（Keychain 写不进去时才用）。 */
function portableKeyFile() {
  return join(homedir(), '.dsh', '.doubao-credentials.key')
}

/** Keychain 读 32 字节密钥。macOS 之外或 Keychain 不可用时返回 undefined。 */
function keychainReadKey() {
  if (process.platform !== 'darwin') return undefined
  const res = spawnSync('security', [
    'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w',
  ], { encoding: 'utf8', timeout: 5_000 })
  if (res.status !== 0 || typeof res.stdout !== 'string') return undefined
  const hex = res.stdout.trim()
  // 旧插件存的是 hex；这里也接受 base64，免得两代版本互相看不见对方写的密钥
  if (HEX_KEY.test(hex)) return Buffer.from(hex, 'hex')
  try {
    const buf = Buffer.from(hex, 'base64')
    return buf.length === PORTABLE_KEY_BYTES ? buf : undefined
  } catch {
    return undefined
  }
}

/** 写 32 字节密钥到 Keychain；成功返回 true。 */
function keychainWriteKey(key) {
  if (process.platform !== 'darwin') return false
  // -U 覆盖同名条目：重复登录不该堆一串孤儿密钥。
  const res = spawnSync('security', [
    'add-generic-password', '-U',
    '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT,
    '-w', key.toString('hex'),
  ], { encoding: 'utf8', timeout: 5_000 })
  return res.status === 0
}

function readPortableKeyFile() {
  try {
    const raw = readFileSync(portableKeyFile(), 'utf8').trim()
    if (HEX_KEY.test(raw)) return Buffer.from(raw, 'hex')
    // 兼容本插件早期写的二进制形态
    const buf = readFileSync(portableKeyFile())
    return buf.length === PORTABLE_KEY_BYTES ? buf : undefined
  } catch {
    return undefined
  }
}

function writePortableKeyFile(key) {
  const path = portableKeyFile()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, key.toString('hex'), { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

/**
 * 取本机密钥：先文件、再 Keychain（文件优先，因为 Keychain 拒绝写入时
 * 插件创建的就是文件形态；由 Keychain 创建的密钥第二步仍能找到）。
 */
function portableKey(create) {
  const fromFile = readPortableKeyFile()
  if (fromFile !== undefined) return fromFile
  const fromKeychain = keychainReadKey()
  if (fromKeychain !== undefined) return fromKeychain
  if (!create) return undefined
  const key = randomBytes(PORTABLE_KEY_BYTES)
  if (keychainWriteKey(key)) return key
  writePortableKeyFile(key)
  return key
}

/** AES-256-GCM：`magic | iv | tag | ciphertext`。 */
function portableSeal(plaintext) {
  const key = portableKey(true)
  const iv = randomBytes(PORTABLE_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([PORTABLE_MAGIC, iv, cipher.getAuthTag(), sealed])
}

function portableOpen(blob) {
  if (blob.length < PORTABLE_MAGIC.length + PORTABLE_IV_BYTES + PORTABLE_TAG_BYTES) return undefined
  if (!blob.subarray(0, PORTABLE_MAGIC.length).equals(PORTABLE_MAGIC)) return undefined
  const key = portableKey(false)
  if (key === undefined) return undefined
  let at = PORTABLE_MAGIC.length
  const iv = blob.subarray(at, at + PORTABLE_IV_BYTES); at += PORTABLE_IV_BYTES
  const tag = blob.subarray(at, at + PORTABLE_TAG_BYTES); at += PORTABLE_TAG_BYTES
  const body = blob.subarray(at)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    return undefined
  }
}

/**
 * Windows DPAPI（当前用户作用域）。只在 win32 上走；macOS/Linux 用上面的
 * AES-GCM 便携密封，文件名保持同一个。
 */
function dpapiCall(mode, blob) {
  const op = mode === 'protect' ? 'Protect' : 'Unprotect'
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$in = [Console]::In.ReadToEnd()',
    '$bytes = [System.Convert]::FromBase64String($in.Trim())',
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($bytes, $null, $scope)`,
    '[Console]::Out.Write([System.Convert]::ToBase64String($out))',
  ].join('\r\n')
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
    windowsHide: true,
    input: blob.toString('base64'),
  })
  if (res.status !== 0 || typeof res.stdout !== 'string' || res.stdout.trim() === '') return undefined
  try {
    return Buffer.from(res.stdout.trim(), 'base64')
  } catch {
    return undefined
  }
}

function seal(plaintext) {
  return process.platform === 'win32' ? dpapiCall('protect', plaintext) : portableSeal(plaintext)
}

function open(blob) {
  return process.platform === 'win32' ? dpapiCall('unprotect', blob) : portableOpen(blob)
}

/** 待密封的会话载荷。 */
function encodeSession(cookies) {
  const pairs = [...cookies.entries()]
  const header = pairs.map(([name, value]) => `${name}=${value}`).join('; ')
  // 同时写两种字段：本插件读 cookies，旧插件读 pairs/header。同一份会话，
  // 两个插件都还能用，卸载重装来回切换不会掉登录。
  return Buffer.from(JSON.stringify({
    version: 2,
    savedAt: Date.now(),
    source: 'browser',
    header,
    pairs,
    cookies: pairs.map(([name, value]) => ({ name, value })),
  }), 'utf8')
}

function decodeSession(plaintext) {
  let parsed
  try {
    parsed = JSON.parse(plaintext.toString('utf8'))
  } catch {
    return undefined
  }
  const pairs = new Map()
  // 本插件格式：{ cookies: [{name, value}] }
  for (const item of Array.isArray(parsed?.cookies) ? parsed.cookies : []) {
    if (typeof item?.name === 'string' && typeof item?.value === 'string' && item.name !== '' && item.value !== '') {
      pairs.set(item.name, item.value)
    }
  }
  // 旧插件 dsh-connect-doubao 格式：{ pairs: [[name, value]] }，或只有 header。
  // 兼容它是为了让已经扫码登录过的机器不用重扫 —— 凭据格式换代不该让用户买单。
  for (const item of Array.isArray(parsed?.pairs) ? parsed.pairs : []) {
    if (!Array.isArray(item) || item.length < 2) continue
    const [name, value] = item
    if (typeof name === 'string' && typeof value === 'string' && name !== '' && value !== '') {
      if (!pairs.has(name)) pairs.set(name, value)
    }
  }
  if (pairs.size === 0 && typeof parsed?.header === 'string' && parsed.header !== '') {
    for (const part of parsed.header.split(/;\s*/)) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const name = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (name !== '' && value !== '') pairs.set(name, value)
    }
  }
  return pairs.size === 0 ? undefined : pairs
}

let cachedSession
let cachedAt = 0

/**
 * 当前登录态。
 *
 * `ok:false` 时 `reason` 给人看，永不含机密。cookie 过期由上游的第一个 401
 * 作为准确信号——豆包自己会在服务端轮换 cookie，本地无从预判。
 */
export function loadCredentials() {
  const now = Date.now()
  if (cachedSession !== undefined && now - cachedAt < CREDENTIAL_TTL_MS) return cachedSession
  const missing = () => ({
    header: '', pairs: new Map(), ok: false,
    reason: '还没有豆包登录态。请在魔桥设置页的豆包卡片里点「扫码登录」。',
  })
  const path = credentialsPath()
  if (!existsSync(path)) {
    cachedSession = missing()
    cachedAt = now
    return cachedSession
  }
  let blob
  try {
    blob = readFileSync(path)
  } catch (error) {
    cachedSession = { ...missing(), reason: `读取豆包凭据失败：${error.message}` }
    cachedAt = now
    return cachedSession
  }
  const plaintext = open(blob)
  const pairs = plaintext === undefined ? undefined : decodeSession(plaintext)
  if (pairs === undefined) {
    cachedSession = { header: '', pairs: new Map(), ok: false, reason: '豆包凭据无法解封（密钥变了）。请重新扫码登录。' }
    cachedAt = now
    return cachedSession
  }
  const absent = CORE_AUTH_COOKIE_NAMES.filter((name) => !pairs.get(name))
  if (absent.length > 0) {
    cachedSession = { ...missing(), reason: `豆包会话缺少关键 cookie：${absent.join(', ')}。请重新扫码登录。` }
    cachedAt = now
    return cachedSession
  }
  cachedSession = {
    header: [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    pairs,
    ok: true,
  }
  cachedAt = now
  return cachedSession
}

/** 清掉内存缓存，下次重新读盘。 */
export function invalidateCredentialCache() {
  cachedSession = undefined
  cachedAt = 0
}

/** 密封并写盘；同时刷新内存缓存。 */
export function saveCredentials(pairs) {
  const sealed = seal(encodeSession(pairs))
  const path = credentialsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, sealed, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
  cachedSession = {
    header: [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    pairs,
    ok: true,
  }
  cachedAt = Date.now()
  return path
}

/** 删除已保存的会话（重新登录前、或用户主动退出）。 */
export function clearCredentials() {
  invalidateCredentialCache()
  try { rmSync(credentialsPath(), { force: true }) } catch {}
}

export function hasCredentials() {
  return existsSync(credentialsPath())
}

/**
 * 浏览器候选：macOS 扫 /Applications 与所有挂载卷，Windows 扫常规安装位置。
 * 显式环境变量优先，任何平台都如此。
 */
const DARWIN_APP_BUNDLES = [
  ['Google Chrome', 'Google Chrome'],
  ['Microsoft Edge', 'Microsoft Edge'],
  ['Brave Browser', 'Brave Browser'],
  ['Chromium', 'Chromium'],
]

export function browserCandidates(env = process.env, platform = process.platform) {
  const seen = new Set()
  const out = []
  const push = (candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return
    const key = candidate.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(candidate)
  }
  for (const name of ['DSH_DOUBAO_BROWSER', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'DSH_MGW_BROWSER']) {
    push(env[name]?.trim())
  }
  if (platform === 'darwin') {
    const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir()
    for (const base of ['/Applications', join(home, 'Applications')]) {
      for (const [app, exe] of DARWIN_APP_BUNDLES) {
        push(join(base, `${app}.app`, 'Contents', 'MacOS', exe))
      }
    }
    // 外置硬盘装 Chrome 很常见，扫所有挂载卷的 Applications
    try {
      for (const volume of macVolumes()) {
        for (const [app, exe] of DARWIN_APP_BUNDLES) {
          push(join(volume, 'Applications', `${app}.app`, 'Contents', 'MacOS', exe))
        }
      }
    } catch {}
    for (const candidate of bundledChromium(home)) push(candidate)
    return out
  }
  const roots = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
  for (const root of roots) {
    push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  return out
}

function macVolumes() {
  const out = []
  try {
    for (const name of readdirSync('/Volumes')) {
      if (name === 'Macintosh HD' || name.startsWith('.')) continue
      out.push(join('/Volumes', name))
    }
  } catch {}
  return out
}

function bundledChromium(home) {
  const out = []
  // Playwright / Puppeteer 下载的 Chromium：没有系统浏览器时的兜底
  try {
    const base = join(home, 'Library', 'Caches', 'ms-playwright')
    for (const dir of readdirSync(base)) {
      if (!dir.startsWith('chromium-')) continue
      out.push(join(base, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
      out.push(join(base, dir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
    }
  } catch {}
  return out
}

/** 找到可用浏览器；找不到返回 undefined。 */
export function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 登录成功后把浏览器身份记下来，下次直接复用，不再全盘扫描。 */
function rememberedBrowserPath() {
  return join(homedir(), '.dsh', 'doubao-browser.json')
}

function rememberBrowser(path) {
  try {
    mkdirSync(dirname(rememberedBrowserPath()), { recursive: true })
    writeFileSync(rememberedBrowserPath(), JSON.stringify({ path }), { mode: 0o600 })
  } catch {}
}

function readRememberedBrowser() {
  try {
    const parsed = JSON.parse(readFileSync(rememberedBrowserPath(), 'utf8'))
    return typeof parsed?.path === 'string' && existsSync(parsed.path) ? parsed.path : undefined
  } catch {
    return undefined
  }
}

/** 找出可用浏览器：记忆路径 → 候选扫描。 */
export function resolveBrowser() {
  return readRememberedBrowser() ?? findBrowser()
}

/** 独立一次性 profile 目录（不碰用户日常浏览器的 cookie）。 */
export function loginProfileDir() {
  return join(homedir(), '.dsh', 'doubao-login-profile')
}

const LOGIN_URL = 'https://www.doubao.com/chat/'

/** 等 DevToolsActivePort 出现；超时抛错。 */
async function waitForPort(userDataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')
      const port = Number(text.split('\n')[0])
      if (Number.isInteger(port) && port > 0) return port
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return undefined
}

/** 最小 CDP 客户端：只需要 Network.getAllCookies 与一个 Runtime.evaluate。 */
function cdpConnect(wsUrl) {
  const Ctor = globalThis.WebSocket
  if (typeof Ctor !== 'function') return Promise.reject(new Error('当前 Node 没有 WebSocket，无法连接浏览器调试端口'))
  return new Promise((resolve, reject) => {
    const ws = new Ctor(wsUrl)
    const pending = new Map()
    let next = 1
    const timer = setTimeout(() => { try { ws.close() } catch {}; reject(new Error('CDP 超时')) }, 10_000)
    const send = (method, params) => new Promise((res, rej) => {
      const id = next
      next += 1
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
    ws.onopen = () => { clearTimeout(timer); resolve({ send, close: () => { try { ws.close() } catch {} } }) }
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data))
        const waiter = msg.id === undefined ? undefined : pending.get(msg.id)
        if (waiter === undefined) return
        pending.delete(msg.id)
        if (msg.error !== undefined) waiter.rej(new Error(msg.error?.message ?? 'CDP 错误'))
        else waiter.res(msg.result ?? {})
      } catch {}
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }
  })
}

/** 列页面目标。 */
async function pageTarget(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) })
    const list = await res.json()
    return (Array.isArray(list) ? list : []).find(
      (target) => target?.type === 'page' && typeof target?.webSocketDebuggerUrl === 'string',
    )
  } catch {
    return undefined
  }
}

/**
 * 抓 cookie 并密封。
 *
 * 必须 `Network.enable` 之后 `Network.getAllCookies`——顺序反了 CDP 会拒绝
 * 或返回空列表。
 */
export async function captureCookies(port) {
  const page = await pageTarget(port)
  if (page === undefined) return undefined
  const session = await cdpConnect(page.webSocketDebuggerUrl)
  try {
    await session.send('Network.enable')
    const result = await session.send('Network.getAllCookies')
    const cookies = Array.isArray(result?.cookies) ? result.cookies : []
    const pairs = new Map()
    for (const cookie of cookies) {
      // 只认豆包主域的 cookie：临时 profile 里不该有别的站点，但上游会把
      // 账豆、字节的跟踪站点也写上，越界的东西不进会话
      const domain = String(cookie?.domain ?? '')
      if (!domain.includes('doubao.com')) continue
      if (cookie?.name === undefined || cookie?.value === undefined) continue
      if (String(cookie.value) === '') continue
      pairs.set(String(cookie.name), String(cookie.value))
    }
    if (pairs.size === 0) return undefined
    return pairs
  } finally {
    session.close()
  }
}

/**
 * 一次完整的扫码登录：起独立浏览器 → 用户自己扫码 → 轮询抓 cookie。
 *
 * 返回 `{ ok, reason? }`；成功时会话已落盘。
 */
export async function browserLogin(options = {}) {
  const say = options.onProgress ?? (() => {})
  const timeoutMs = options.timeoutMs ?? 180_000
  const exe = resolveBrowser()
  if (exe === undefined) {
    return { ok: false, reason: '没找到 Chrome / Edge / Chromium。装了任一即可，或用 DSH_DOUBAO_BROWSER 指定路径。' }
  }
  const profile = loginProfileDir()
  mkdirSync(profile, { recursive: true })
  const child = spawn(exe, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    LOGIN_URL,
  ], { stdio: 'ignore', detached: true })
  child.unref?.()
  rememberBrowser(exe)

  const port = await waitForPort(profile, 20_000)
  if (port === undefined) {
    terminate(child, profile)
    return { ok: false, reason: '浏览器调试端口没就绪，请重试' }
  }
  say('浏览器已打开，请在窗口里扫码登录豆包…')
  const deadline = Date.now() + timeoutMs
  let saved
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) break
    const pairs = await captureCookies(port)
    if (pairs !== undefined) {
      const missing = CORE_AUTH_COOKIE_NAMES.filter((name) => !pairs.get(name))
      if (missing.length === 0) {
        saveCredentials(pairs)
        saved = true
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  terminate(child, profile)
  if (saved === true) return { ok: true }
  return { ok: false, reason: '登录超时，没有抓到豆包会话 cookie' }
}

function terminate(child, profile) {
  try {
    if (profile !== undefined) {
      spawnSync('pkill', ['-TERM', '-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
    }
  } catch {}
  try { child.kill() } catch {}
}

/* ------------------------------------------------------------------ 浏览器身份 */

/** 读浏览器身份（非机密），undefined 表示没抓过。 */
export function readBrowserFingerprint() {
  try {
    const parsed = JSON.parse(readFileSync(fingerprintPath(), 'utf8'))
    if (typeof parsed?.userAgent !== 'string' || typeof parsed?.referer !== 'string') return undefined
    const query = parsed.query
    if (query === undefined || typeof query !== 'object' || Array.isArray(query)) return undefined
    const pairs = Object.entries(query).filter((entry) => typeof entry[1] === 'string')
    return {
      userAgent: parsed.userAgent,
      referer: parsed.referer,
      ...(typeof parsed.secChUa === 'string' ? { secChUa: parsed.secChUa } : {}),
      query: Object.fromEntries(pairs),
    }
  } catch {
    return undefined
  }
}

/** 目前不自动抓身份：留接口给 doctor，缺身份时上游照桌面身份发并提示一次。 */
export function writeBrowserFingerprint(fingerprint) {
  const path = fingerprintPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(fingerprint, null, 2) + '\n', 'utf8')
  return path
}
