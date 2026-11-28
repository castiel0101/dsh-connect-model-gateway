/**
 * 豆包适配器（无状态：凭证由 manager 传入）。
 *
 * 平台差异封在 shim 里；adapter 只做四件事：登录态判定、额度、目录、推理基址。
 *
 * 豆包单账号：cookie 是按浏览器 profile 走的，多账号轮换等于多个浏览器身份，
 * 风控会把它们串成一台机器上的多个账号。所以这里不做 pool 自动轮换 ——
 * 要换号就重新扫码，这是**有意的安全取舍**。
 *
 * @module dsh-connect-model-gateway/adapters/doubao
 */

import { AdapterError } from '../core/adapter.js'
import {
  CORE_AUTH_COOKIE_NAMES, hasCredentials, loadCredentials,
  invalidateCredentialCache, clearCredentials,
} from '../core/doubao-auth.js'
import { discoveryDiagnostics, refreshDiscovery, staticModels } from '../core/doubao-discovery.js'
import { fetchQuota } from '../core/doubao-quota.js'
import { ERROR_HINTS } from '../core/doubao-upstream.js'

export const KEY = 'doubao'
export const DISPLAY_NAME = '豆包'

/**
 * 登录态表示：
 * 魔桥的账号池期望每个账号有一个 `credential` 对象，而豆包所有账号共用
 * 一份本机密封会话。所以这里用固定 id 的单账号，credential 里只放**非机密**
 * 的标记；真正的 cookie 由 shim 在请求时现读。这样 `snapshot()` 里不会出现
 * cookie，Auto 的候选键也不会带上它。
 */
const ACCOUNT_ID = 'doubao-local'
const CREDENTIAL = { source: 'browser-login', ok: true }

/** 不落盘、只给 manager 用来判定「是否要显示扫码按钮」。 */
export function accountFromCredential() {
  return {
    id: ACCOUNT_ID,
    label: '豆包网页登录',
    credential: CREDENTIAL,
  }
}

export function createDoubaoAdapter() {
  const fingerprint = () => undefined

  return {
    key: KEY,
    displayName: DISPLAY_NAME,
    fallbackModels: staticModels(),

    /** 没有 refresh token：会话由上游轮转，shim 每次请求现读当前 cookie。 */
    async refresh(credential) {
      return credential
    },

    /**
     * 登录态：只看本机有没有可用会话，不发网络请求。
     *
     * 为什么不做 `probeLive`：豆包没有轻量的「whoami」接口，能验证会话的
     * 只有 chat 本身。拿 chat 探活会白烧额度，而且每次启动都发一轮请求。
     */
    async probe() {
      const session = loadCredentials()
      if (session.ok !== true) {
        return { state: 'signed-out', detail: session.reason ?? ERROR_HINTS.session_dead }
      }
      if (!hasCredentials()) return { state: 'signed-out' }
      return { state: 'signed-in', account: '豆包网页登录' }
    },

    /** 额度按百分比窗口折算；失败交给 manager 记到 lastError。 */
    async quota() {
      const session = loadCredentials()
      if (session.ok !== true) {
        throw new AdapterError(session.reason ?? '还没有豆包登录态', { kind: 'auth', status: 401, permanent: true })
      }
      const data = await fetchQuota({ credentials: session, fingerprint: fingerprint() })
      return {
        remaining: data.remaining,
        total: data.total,
        // manager 的 UI 直接显示这个字符串；豆包没有整数余额，微软那边别写「积分」
        resetAt: data.resetAtMs === null ? null : new Date(data.resetAtMs).toLocaleString('zh-CN'),
        remainingPercent: data.remainingPercent,
        exhausted: data.exhausted,
        windows: data.windows,
        fetchedAtMs: data.fetchedAtMs,
      }
    },

    /** 目录：HTTP 菜单优先，本地缓存与静态目录兜底。 */
    async listModels() {
      const session = loadCredentials()
      let models
      if (session.ok === true) {
        const result = await refreshDiscovery(session, { fingerprint: fingerprint() })
        models = result.models
      } else {
        models = staticModels()
      }
      if (!Array.isArray(models) || models.length === 0) {
        throw new AdapterError('豆包模型目录为空', { kind: 'upstream', status: 502 })
      }
      return { models, credential: CREDENTIAL }
    },

    /** 实际地址由 index.js 覆盖成本机 shim。 */
    chatBase() {
      return 'http://127.0.0.1:0/v1'
    },

    /** Bearer 是 shim 的随机 token，由 index.js 提供。 */
    async resolveApiKey() {
      return ''
    },

    /** 诊断：给设置页显示「模型列表来自哪里」与「上次发现失败原因」。 */
    diagnostics() {
      return { discovery: discoveryDiagnostics(), cookies: CORE_AUTH_COOKIE_NAMES.slice() }
    },
  }
}

/** 重新扫码成功后调它，让所有缓存立刻失效。 */
export function onDoubaoLogin() {
  invalidateCredentialCache()
}

/** 退出登录。 */
export function onDoubaoLogout() {
  clearCredentials()
}
