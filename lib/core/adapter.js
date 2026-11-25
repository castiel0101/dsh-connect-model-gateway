/**
 * 适配器契约 —— 一个新平台要接进来，只需要实现这几件事。
 *
 * 这一层存在的理由：六家 connect 插件各自把「登录、刷新积分、拿目录、
 * 签到、设置页、输入框胶囊」实现了一遍。合并成一个插件之后，这些动作
 * 必须只有一份实现，平台差异全部收敛到本接口背后。
 *
 * @module dsh-connect-model-gateway/core/adapter
 */

/**
 * 登录态。
 * - `signed-in`  可用
 * - `expiring`   能用但即将过期（提醒，不阻断）
 * - `expired`    需要重新登录
 * - `signed-out` 从未登录
 * @typedef {'signed-in'|'expiring'|'expired'|'signed-out'} AuthState
 */

/**
 * 一个账号的余额。
 * @typedef {object} Quota
 * @property {number|null} remaining  剩余积分/额度；null = 上游没给
 * @property {number|null} total      本轮总额度；null = 不适用
 * @property {string|null} resetAt    重置时间（ISO 或平台自己的措辞）
 * @property {number} fetchedAtMs     读取时刻
 */

/**
 * 一个模型条目。
 * @typedef {object} PoolModel
 * @property {string} id
 * @property {string} name
 * @property {number} contextWindow
 * @property {number} maxTokens
 * @property {boolean} vision
 * @property {string|null} badge      倍率等展示标签，如 "x0.11"
 * @property {string|null} note       促销/说明，如 "限时免费"
 * @property {boolean} enabled        是否出现在选择器里
 */

/**
 * 平台适配器。
 *
 * 只要求 `key / displayName / probe / listModels` 四个；其余按平台能力可选。
 * 没有签到能力的平台不实现 `checkIn`，调度器会跳过它。
 *
 * @typedef {object} PlatformAdapter
 * @property {string} key                        provider 路由键（沿用旧插件值）
 * @property {string} displayName
 * @property {() => Promise<{state: AuthState, account?: string, detail?: string}>} probe
 * @property {() => Promise<Quota>} [quota]
 * @property {() => Promise<PoolModel[]>} listModels
 * @property {() => Promise<{credit:number, streakDays?:number}>} [checkIn]
 * @property {() => Promise<void>} [login]      交互式登录（浏览器）
 * @property {() => string} [baseUrl]           推理请求的 baseURL
 * @property {() => Promise<string>} resolveApiKey
 */

/** 统一错误：上游说不行，且原因要原样给人看。 */
export class AdapterError extends Error {
  /**
   * @param {string} message
   * @param {{kind?: string, status?: number, permanent?: boolean}} [info]
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'AdapterError'
    this.kind = info.kind ?? 'upstream'
    this.status = info.status ?? 0
    /** permanent = 换网络/重试都不会变，只能重新登录或改配置。 */
    this.permanent = info.permanent ?? false
  }
}

/** 把任意异常收成一句人话。 */
export function describeError(error) {
  if (error instanceof AdapterError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
