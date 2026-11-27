/**
 * dsh-connect-model-gateway —— 一个插件管住多家「积分换模型」的平台。
 *
 * 代替 dsh-connect-workbuddy / dsh-codearts 等一家一个的插件：账号池、积分、
 * 模型目录与开关、自动签到、设置页只实现一次，平台差异收敛在 adapters/ 下。
 *
 * 设计约束（都是踩过的坑）：
 * 1. provider 路由键沿用旧插件值（workbuddy / codearts），历史会话的模型引用不断。
 * 2. 适配器注册不能等网络：目录先给静态兜底，账号可用后再刷新。
 * 3. 一个平台故障不能拖垮整个插件：每个平台的刷新各自 try。
 * 4. 宿主包只在 app.asar 内，必须运行期解析（core/host-peers.js）。
 * 5. 路由必须用 ctx.inject 的**回调参数** webCtx 注册（外层 ctx.webServer 是 undefined）。
 *
 * @module dsh-connect-model-gateway
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'

import { createWorkBuddyAdapter, KEY as WORKBUDDY_KEY } from './adapters/workbuddy.js'
import { createCodeArtsAdapter, defaultAccountsPath, canonicalModel, KEY as CODEARTS_KEY } from './adapters/codearts.js'
import { createMeooAdapter, accountFromApiKey, accountFromServiceAk, KEY as MEOO_KEY } from './adapters/meoo.js'
import { createScnetAdapter, KEY as SCNET_KEY } from './adapters/scnet.js'
import { createLingxiAdapter, KEY as LINGXI_KEY } from './adapters/lingxi.js'
import { createRaccoonAdapter, KEY as RACCOON_KEY } from './adapters/raccoon.js'
import { withRetryFriendlyApi } from './core/retry-fetch.js'
import { startLingxiShim } from './core/lingxi-shim.js'
import { startCodeArtsShim } from './core/shim.js'
import { startWorkBuddyShim } from './core/workbuddy-shim.js'
import { loadHostPeers } from './core/host-peers.js'
import { createGateway } from './core/openai-gateway.js'
import { createKeyStore, defaultAuditPath, defaultKeysPath } from './core/gateway-keys.js'
import { createManager, withCredentialLock } from './core/manager.js'
import { AUTO_PROVIDER, accountScope, createAutoAdapter, createAutoRouter, createAutoStore, createCooling, createExternalCatalog } from './core/auto-route.js'
import { startKeeper } from './core/keeper.js'
import { startWorkBuddyLogin, pollWorkBuddyLogin, startCodeArtsLogin, pollCodeArtsLogin, startMeooLogin, pollMeooLogin, startScnetLogin, startScnetCaptcha, refreshScnetCaptcha, submitScnetLogin, startLingxiLogin, pollLingxiLogin, startRaccoonLogin, pollRaccoonLogin, disposeLogins } from './core/login.js'

export const name = 'dsh-connect-model-gateway'
export const inject = ['llm']

const STATE_DIRNAME = 'model-pool'
const CHECK_IN_INTERVAL_MS = 3600_000
/** 积分自动刷新间隔（用户要求自动刷，去掉手动按钮）。 */
const QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * 请求侧图片预算默认值。
 *
 * 取值依据：
 * - 旧值 8/4 来自 0.11.0 首提交，无注释、无依据。
 * - pi-ai 默认 50/10 是 Azure 标准，六家私有接口不适用。
 * - 长会话实测保留 13-16 张图即触发，故 maxRequestImages 提到 20。
 * - 量子保持 maxImages 的 1/4 比例（5/20），一次只丢 5 张，不会一口气清空上下文。
 * - maxRequestImageBytes 保持 20 MiB 不变：base64 展开后约 14 张满尺寸图就先占满字节上限，本轮不动。
 * - pi-ai 校验 imageOffloadCountQuantum <= maxRequestImages，非法配置必须回退到默认值，不能启动崩溃。
 */
const DEFAULT_IMAGE_BUDGETS = Object.freeze({
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImages: 20,
  imageOffloadCountQuantum: 5,
})

/** 从 config.imageBudgets 归一化图片预算；非法值回退默认值，保证 quantum <= maxImages。 */
export function resolveImageBudgets(config = {}) {
  const imageBudgets = config !== null && typeof config === 'object' ? config.imageBudgets : undefined
  const overrides = imageBudgets !== null && typeof imageBudgets === 'object' ? imageBudgets : {}
  const budgets = { ...DEFAULT_IMAGE_BUDGETS }
  for (const key of Object.keys(DEFAULT_IMAGE_BUDGETS)) {
    const value = overrides[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) budgets[key] = value
  }
  if (budgets.imageOffloadCountQuantum > budgets.maxRequestImages) {
    budgets.maxRequestImages = DEFAULT_IMAGE_BUDGETS.maxRequestImages
    budgets.imageOffloadCountQuantum = DEFAULT_IMAGE_BUDGETS.imageOffloadCountQuantum
  }
  return budgets
}

const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-connect-model-gateway: 该路由没有 pi-ai 凭据生命周期')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

function toPiModel(model, providerKey, baseUrl, allowImage) {
  // 支持列表非空才算有思考能力（空数组是 shim 用来区分 thinking 开关的哨兵）
  const thinkingLevels = Array.isArray(model.thinkingOptions) ? model.thinkingOptions : []
  const thinking = thinkingLevels.length > 0 ? (model.thinkingDefault ?? 'high') : null
  // 选择器读的是 provider 的模型清单（不是发现接口），那里没有 badge 字段，
  // 所以倍率/促销只能写进 name —— 旧插件也是这么做的。
  const priceTag = (() => {
    const badge = typeof model.badge === 'string' ? model.badge.trim() : ''
    const zero = /^x?0(\.0+)?$/i.test(badge)
    const parts = []
    if (zero) parts.push('免费')
    else if (badge !== '') parts.push(badge)
    if (model.promo?.label) parts.push(model.promo.label)
    return parts.join(' · ')
  })()
  const displayName = priceTag === '' ? model.name : `${model.name} · ${priceTag}`
  return {
    id: model.id,
    name: displayName,
    api: 'openai-completions',
    provider: providerKey,
    baseUrl,
    input: model.vision && allowImage ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // 用户在模型卡片里选的思考档位；off 表示不发 reasoning_effort
    ...(thinking !== null && thinking !== 'off' ? { reasoning: thinking, thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' } } : {}),
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      ...(thinking !== null && thinking !== 'off' ? { supportsReasoningEffort: true } : {}),
    },
  }
}

function toLlmModelInfo(model, providerKey, displayName, allowImage) {
  const parts = [displayName]
  if (model.badge) parts.push(model.badge)
  if (model.contextWindow > 0) parts.push(`${Math.round(model.contextWindow / 1000)}K`)
  // 选择器里的徽标：倍率 + 促销一起给，宿主会画在模型名右侧
  const badgeText = [model.badge, model.promo?.label].filter((x) => typeof x === 'string' && x !== '').join(' · ')

  return {
    provider: providerKey,
    id: model.id,
    // 前缀渠道名：不同渠道可能有同名模型（如两家都有 GLM-5.3-Flash），不带前缀分不清
    name: `${displayName} · ${model.name}`,
    description: parts.join(' · '),
    inputModalities: model.vision && allowImage ? ['text', 'image'] : ['text'],
    ...(badgeText === ''
      ? {}
      : { badge: { text: badgeText, tone: model.promo !== null && model.promo !== undefined ? 'success' : 'neutral' } }),
  }
}

/** 读请求体（上限 1MB，够用）。 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_048_576) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

export async function apply(ctx, config = {}) {
  const home = homedir()
  const stateDir = config.stateDir || join(home, '.dsh', STATE_DIRNAME)
  await mkdir(stateDir, { recursive: true })

  const warn = (message) => ctx.logger?.warn?.(`[${name}] ${message}`)
  /**
   * 图片能力必须**运行期**判断，不能在 apply 时定死。
   *
   * 踩过的坑：早先在这里取一次 `ctx.get('attachments')` 存成常量，插件启动时
   * 该服务还没挂上，于是模型被永久声明成纯文本；之后会话历史里一旦有图片，
   * pi-ai 会走 textOnly 转换并抛 "requires the durable attachment service"。
   * 新会话没有图片所以看不出来，任务中途切模型就必炸。
   */
  const canImageNow = () => ctx.get?.('attachments') !== undefined
  const { PiAiAdapter, resolveRetryPolicy, createProvider, openAICompletionsApi } = await loadHostPeers()

  // ---- CodeArts 需要本地 shim 做 AK/SK 签名 ----
  const codearts = createCodeArtsAdapter({
    accountsPath: () => config.codeartsAccountsPath || defaultAccountsPath(home),
    warn,
  })
  // 并发上限初值从配置读；manager 起来后再用状态文件里的值覆盖。
  const defaultMaxConcurrent = config.maxConcurrent ?? 2
  let shim
  try {
    shim = await startCodeArtsShim({
      canonicalize: canonicalModel,
      warn,
      maxConcurrent: defaultMaxConcurrent,
      onChat: () => manager.markUsed(CODEARTS_KEY),
      // shim 每次请求向管理器要当前账号的凭证
      adapter: {
        chatUrl: () => codearts.chatUrl(),
        // accountId 由 Auto 的候选带进来；不带就是当前账号（手选模型的老路）
        credentialForShim: async (accountId) => {
          const platform = manager.byKey.get(CODEARTS_KEY)
          const account = accountId === undefined ? platform?.currentAccount() : platform?.accountById(accountId)
          if (account === undefined) throw new Error('CodeArts 还没有账号')
          // 续期按账号串行：并发 refresh 会让 refresh token 一次性失效
          const credential = await withCredentialLock(`${CODEARTS_KEY}|${account.id}`, () => codearts.ensureFresh(account.credential))
          platform?.adopt(account, credential)
          return credential
        },
        listModels: async () => {
          const platform = manager.byKey.get(CODEARTS_KEY)
          const account = platform?.currentAccount()
          if (account === undefined) return []
          const result = await codearts.listModels(account.credential)
          return Array.isArray(result) ? result : result.models ?? []
        },
      },
    })
  } catch (error) {
    warn(`CodeArts 转发端点启动失败，CodeArts 不可用：${String(error)}`)
  }

  const workbuddy = createWorkBuddyAdapter({ warn })
  const meoo = createMeooAdapter()
  const scnet = createScnetAdapter()
  const lingxi = createLingxiAdapter()
  const raccoon = createRaccoonAdapter()

  // 灵犀需要本地 shim 做三步握手 + SSE 翻译（回环随机端口 + Bearer）。
  let lingxiShim
  try {
    lingxiShim = await startLingxiShim({
      warn,
      onChat: () => manager.markUsed(LINGXI_KEY),
      credential: async (accountId) => {
        const platform = manager.byKey.get(LINGXI_KEY)
        const account = accountId === undefined ? platform?.currentAccount() : platform?.accountById(accountId)
        return account?.credential
      },
    })
  } catch (error) {
    warn(`灵犀转发端点启动失败，灵犀不可用：${String(error)}`)
  }

  // 正文要过渠道校验、头要按官方客户端自称，所以 WorkBuddy 也要走本地转发端点。
  let workbuddyShim
  try {
    workbuddyShim = await startWorkBuddyShim({
      warn,
      onChat: () => manager.markUsed(WORKBUDDY_KEY),
      credential: async (accountId) => {
        const platform = manager.byKey.get(WORKBUDDY_KEY)
        const account = accountId === undefined ? platform?.currentAccount() : platform?.accountById(accountId)
        if (account === undefined) throw new Error('WorkBuddy 还没有账号')
        return account.credential
      },
    })
  } catch (error) {
    warn(`WorkBuddy 转发端点启动失败，WorkBuddy 不可用：${String(error)}`)
  }

  const manager = createManager({
    stateDir,
    warn,
    specs: [
      {
        adapter: workbuddy,
        providerKey: WORKBUDDY_KEY,
        displayName: 'WorkBuddy',
        fallbackModels: [
          {
            id: 'deepseek-v4.1-flash',
            name: 'DeepSeek V4.1 Flash',
            contextWindow: 300_000,
            maxTokens: 32_000,
            vision: true,
            badge: 'x0.11',
            note: null,
            reasoning: true,
          },
        ],
      },
      {
        adapter: codearts,
        providerKey: CODEARTS_KEY,
        displayName: 'CodeArts',
        fallbackModels: [
          {
            id: 'GLM-5.2',
            name: 'GLM-5.2',
            contextWindow: 202_752,
            maxTokens: 65_536,
            vision: false,
            badge: '0.7x',
            note: null,
            reasoning: false,
          },
        ],
      },
      {
        adapter: meoo,
        providerKey: MEOO_KEY,
        displayName: 'Meoo 秒悟',
        fallbackModels: meoo.fallbackModels,
      },
      {
        adapter: scnet,
        providerKey: SCNET_KEY,
        displayName: 'SCNet',
        fallbackModels: scnet.fallbackModels,
      },
      {
        adapter: lingxi,
        providerKey: LINGXI_KEY,
        displayName: 'WPS 灵犀',
        fallbackModels: lingxi.fallbackModels,
      },
      {
        adapter: raccoon,
        providerKey: RACCOON_KEY,
        displayName: '商汤小浣熊',
        fallbackModels: raccoon.fallbackModels,
      },
    ],
  })

  await manager.init()

  // 并发上限落盘在 codearts 平台 options 里；启动时覆盖 shim 的默认值。
  const codeartsPlatform = manager.byKey.get(CODEARTS_KEY)
  const storedConcurrency = codeartsPlatform?.getOption('maxConcurrent', defaultMaxConcurrent)
  shim?.setMaxConcurrent?.(storedConcurrency)

  // SCNet 的「只显示免费模型」开关：默认 true（旧插件默认），可从状态文件恢复。
  const scnetPlatform = manager.byKey.get(SCNET_KEY)
  if (scnetPlatform !== undefined && typeof scnet.setFreeOnly === 'function') {
    scnet.setFreeOnly(scnetPlatform.getOption('scnetFreeOnly', true))
  }

  // ---- Auto 模式（兜底换模型）----
  // 存储、冷却、路由与各平台状态文件完全独立：Auto 只用候选绑定的账号，
  // 不读也不写平台的全局当前账号。
  const autoStore = createAutoStore({ path: join(stateDir, 'auto.json'), warn })
  await autoStore.load()
  const autoCooling = createCooling()
  // 外部 provider（DSH 自带 / 用户自配）目录：由宿主事件驱动重建，添加候选时可用。
  const managedKeys = new Set(manager.platforms.map((platform) => platform.providerKey))
  const externalCatalog = createExternalCatalog({ ctx, exclude: managedKeys, warn })
  // 启动时先建一次；后续由 adapters-updated / models-updated 事件刷新。
  void externalCatalog.refresh()
  ctx.on('llm/adapters-updated', () => { void externalCatalog.refresh() })
  ctx.on('llm/models-updated', (provider) => {
    if (managedKeys.has(provider)) return
    void externalCatalog.refresh()
  })
  const autoRouter = createAutoRouter({ store: autoStore, manager, external: externalCatalog, canImageNow })
  const autoAdapter = createAutoAdapter({ ctx, store: autoStore, router: autoRouter, cooling: autoCooling, warn })

  // ---- 注册 LLM 路由 ----
  const releaseAdapters = []
  const releaseDirectories = []
  const releaseDiscoveries = []

  // ---- 注册 Auto 路由 ----
  /**
   * 必须抢在平台之前注册。
   *
   * 选择器里的 provider 顺序 = `ctx.llm.listProviders()` 的返回顺序
   * （dsh-llm/src/index.ts:498，adapter 注册顺序），宿主的 orderModelProviders()
   * 只把 deepseek-account / deepseek-official 提到最前，其余保持原序。
   * 所以想让 Auto 排在所有平台之上，唯一的控制点就是注册时机。
   *
   * 注意：它不依赖下面的 for 循环，只依赖 autoAdapter 与 manager 已就绪。
   */
  const notifyAuto = () => {
    try {
      autoHandle?.replace([AUTO_PROVIDER])
    } catch {
      // 已释放时忽略
    }
  }

  let autoHandle
  try {
    autoHandle = ctx.llm.registerAdapter([AUTO_PROVIDER], autoAdapter)
    releaseAdapters.push(autoHandle)
    releaseDirectories.push(
      ctx.llm.registerConfigurableProviders([
        {
          provider: AUTO_PROVIDER,
          displayName: '魔桥 Auto',
          settingsNs: 'model-pool-auto',
          settingsPath: [],
          declared: false,
        },
      ]),
    )
    releaseDiscoveries.push(
      ctx.llm.registerModelDiscovery('model-pool-auto', async () => autoAdapter.listModels(AUTO_PROVIDER)),
    )
  } catch (error) {
    warn(`Auto 路由注册失败：${String(error)}`)
  }

  for (const platform of manager.platforms) {
    const providerKey = platform.providerKey

    /**
     * 每个平台的推理目标：baseUrl 随账号变化，所以每次重建 provider。
     *
     * accountId 只有 Auto 会传：按候选绑定的账号取凭证，**不动物流全局当前账号**。
     * 省略就是当前账号，与手选模型完全一致。
     */
    const inferenceFor = async (accountId) => {
      const accountOf = () => (accountId === undefined ? platform.currentAccount() : platform.accountById(accountId))
      if (providerKey === CODEARTS_KEY && shim !== undefined) {
        return { baseUrl: `${shim.url}/codearts/v1`, apiKey: shim.token }
      }
      if (providerKey === WORKBUDDY_KEY && workbuddyShim !== undefined) {
        return { baseUrl: `${workbuddyShim.url}/workbuddy/v1`, apiKey: workbuddyShim.token }
      }
      // Meoo 走适配器自带的推理目标：网关本身就是 OpenAI 兼容，无需 shim；
      // 且 baseUrl 已含 /v1，apiKey 是项目服务 AK（每次现场解析）。
      if (providerKey === MEOO_KEY && typeof meoo.inferenceTarget === 'function') {
        const account = accountOf()
        if (account === undefined) throw new Error('Meoo 还没有账号')
        const result = await withCredentialLock(`${MEOO_KEY}|${account.id}`, () => meoo.inferenceTarget(account.credential))
        platform.adopt(account, result.credential)
        return { baseUrl: result.baseUrl, apiKey: result.apiKey }
      }
      if (providerKey === SCNET_KEY) {
        const account = accountOf()
        if (account === undefined) throw new Error('SCNet 还没有账号')
        const result = await withCredentialLock(`${SCNET_KEY}|${account.id}`, () => scnet.inferenceTarget(account.credential))
        platform.adopt(account, result.credential)
        return { baseUrl: result.baseUrl, apiKey: result.apiKey }
      }
      if (providerKey === LINGXI_KEY && lingxiShim !== undefined) {
        return { baseUrl: `${lingxiShim.url}/v1`, apiKey: lingxiShim.token }
      }
      const target = await platform.inferenceTarget(accountId)
      return { baseUrl: target.baseUrl, apiKey: target.apiKey }
    }

    /** 这三个平台的请求要经过本地 shim，账号靠一条私有头带过去。 */
    const SHIMMED = new Set([CODEARTS_KEY, WORKBUDDY_KEY, LINGXI_KEY])

    const buildProvider = (baseUrl) =>
      createProvider({
        id: providerKey,
        name: platform.displayName,
        auth: {
          apiKey: {
            name: `${platform.displayName} 登录态`,
            async resolve({ credential }) {
              const key = credential?.key
              return key === undefined || key.length === 0 ? undefined : { auth: { apiKey: key }, source: platform.displayName }
            },
          },
        },
        models: platform.enabledModels().map((model) => toPiModel(model, providerKey, baseUrl, canImageNow())),
        // SCNet 的四类抖动必须在 fetch 层归一化，否则全部退化成不可重试
        api: providerKey === SCNET_KEY
          ? withRetryFriendlyApi(openAICompletionsApi())
          : openAICompletionsApi(),
      })

    let provider = buildProvider('http://127.0.0.1:0')
    const profileFor = () => ({
      provider: providerKey,
      displayName: platform.displayName,
      streamIdleTimeoutMs: 180_000,
      retryPolicy: resolveRetryPolicy(undefined, `dsh-connect-model-gateway ${providerKey}`),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      ...resolveImageBudgets(config),
      piProvider: provider,
    })
    let profiles = new Map([[providerKey, profileFor()]])

    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      // Auto 把「这条候选绑定的账号」放进 ALS；手选请求下 store 为空，照旧走当前账号。
      resolveApiKey: async () => {
        const scope = accountScope.getStore()
        const accountId = scope !== undefined && scope.provider === providerKey ? scope.accountId : undefined
        return (await inferenceFor(accountId)).apiKey
      },
      // 走 shim 的三个平台没法用 apiKey 区分账号，加一条私有头让 shim 自己取凭证。
      prepareHeaders: (_request, headers) => {
        if (!SHIMMED.has(providerKey)) return headers
        const scope = accountScope.getStore()
        if (scope !== undefined && scope.provider === providerKey && typeof scope.accountId === 'string' && scope.accountId !== '') {
          headers.set('x-mgw-account', scope.accountId)
        }
        return headers
      },
      // 这个必须在构造参数里：PiAiAdapter 从 config 读它，
      // 写在 profile 对象里会被忽略，于是历史里有图片就报
      // 「pi-ai image input requires the durable attachment service」。
      resolveAttachments: () => ctx.get?.('attachments'),
    })

    /** 账号/目录变化后重建 provider，让 baseUrl 与模型清单跟着走。 */
    platform.rebuild = async () => {
      try {
      const { baseUrl } = await inferenceFor().catch(() => ({ baseUrl: 'http://127.0.0.1:0' }))
      provider = buildProvider(baseUrl)
      profiles = new Map([[providerKey, profileFor()]])
      // 记下注册给宿主的模型名，便于核对选择器应该显示什么。
      // 注意别读 piProvider.models —— createProvider 的结果不暴露它，
      // 读它会抛异常把整个 rebuild 带崩（选择器就永远停在旧清单）。
      platform.registeredNames = platform
        .enabledModels()
        .map((model) => toPiModel(model, providerKey, baseUrl, canImageNow()).name)
      // 通知宿主模型目录变了，否则选择器还停在启动时那一份
      try {
        platform.adapterHandle?.replace([providerKey])
      } catch {
        // 已被释放时忽略
      }
      platform.rebuildAt = Date.now()
      } catch (error) {
        platform.rebuildError = error instanceof Error ? error.message : String(error)
        warn(`${platform.displayName} 重建模型清单失败：${platform.rebuildError}`)
      }
    }

    try {
      const handle = ctx.llm.registerAdapter([providerKey], adapter)
      releaseAdapters.push(handle)
      platform.adapterHandle = handle
      releaseDirectories.push(
        ctx.llm.registerConfigurableProviders([
          {
            provider: providerKey,
            displayName: platform.displayName,
            settingsNs: `model-pool-${providerKey}`,
            settingsPath: [],
            declared: false,
          },
        ]),
      )
      releaseDiscoveries.push(
        ctx.llm.registerModelDiscovery(`model-pool-${providerKey}`, async () => {
          const enabled = platform.enabledModels()
          return enabled.map((model) => toLlmModelInfo(model, providerKey, platform.displayName, canImageNow()))
        }),
      )
    } catch (error) {
      warn(`${platform.displayName} 路由注册失败：${String(error)}`)
    }
  }

  /** 刷新全部 + 重建 provider。 */
  const refreshAll = async () => {
    for (const platform of manager.platforms) {
      await platform.refresh().catch((error) => warn(`${platform.displayName} 刷新失败：${String(error)}`))
      await platform.rebuild?.().catch(() => {})
    }
    // 再重建一轮：某个平台的目录可能在上一轮后半段才拿到（续期/慢请求），
    // 这一轮把它们的模型名补齐，避免选择器里只剩兜底的那一条。
    for (const platform of manager.platforms) {
      await platform.rebuild?.().catch(() => {})
    }
    return manager.snapshot()
  }

  // 先注册，再异步刷新：装好立即可用，账号状态随后补上。
  setTimeout(() => {
    refreshAll()
      .then(() => manager.checkInAll())
      .catch((error) => warn(`初始化刷新失败：${String(error)}`))
  }, 0).unref?.()

  // CodeArts 保活子进程（用户要求）：独立进程续期，主进程忙时也不掉登录
  const keeper = config.keeper === false
    ? undefined
    : startKeeper({
        // 保活我们自己的账号状态（原生文件只在登录时读一次）
        accountsPath: join(stateDir, `${CODEARTS_KEY}.json`),
        intervalMs: config.keeperIntervalMs ?? 15 * 60_000,
        warn,
      })

  const timer = setInterval(() => {
    manager.checkInAll().catch((error) => warn(`签到调度失败：${String(error)}`))
  }, CHECK_IN_INTERVAL_MS)
  timer.unref?.()

  // 积分自动刷新：每 5 分钟把每个账号的余额拉一遍
  const quotaTimer = setInterval(() => {
    for (const platform of manager.platforms) {
      platform.refreshAllQuotas().catch(() => {})
    }
  }, QUOTA_REFRESH_INTERVAL_MS)
  quotaTimer.unref?.()

  // 探活：每 5 分钟对当前账号做一次真网络检查，掉登录就自愈（续期 / 重读盘）。
  // 这是为了补 CodeArts/SCNet 的漏洞——只看本地 expiration 不会发现上游单方面
  // 吊销 token，用户会等到推理失败才发现「未登录」。
  const PROBE_INTERVAL_MS = 5 * 60_000
  const probeAll = async () => {
    for (const platform of manager.platforms) {
      try {
        const auth = await platform.probeAndHeal()
        if (auth !== undefined) await platform.rebuild?.()
      } catch (error) {
        warn(`${platform.displayName} 定时探活异常：${String(error)}`)
      }
    }
  }
  const probeTimer = setInterval(() => { void probeAll() }, PROBE_INTERVAL_MS)
  probeTimer.unref?.()
  // 启动后先探一次（延迟到首轮 refreshAll 之后，避免并发打上游）
  setTimeout(() => { void probeAll() }, 10_000).unref?.()

  /** 添加候选弹窗要用：每个平台的账号 + 已启用模型。 */
  const autoCatalog = () => [
    ...manager.platforms.map((platform) => ({
      provider: platform.providerKey,
      displayName: platform.displayName,
      auth: platform.runtime.auth,
      accounts: (platform.state.accounts ?? []).map((account) => ({
        id: account.id,
        label: account.label,
        active: account.id === platform.state.activeAccount,
        authError: account.authError === true,
      })),
      models: (platform.runtime.models ?? [])
        .filter((model) => platform.modelEnabled(model.id))
        .map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          badge: model.badge ?? null,
        })),
    })),
    ...externalCatalog.all(),
  ]

  /** 设置页 Auto 面板的完整视图。 */
  const autoView = () => ({
    ...autoAdapter.snapshot(),
    candidates: autoRouter.list(autoCooling),
    catalog: autoCatalog(),
  })

  /**
   * 概览卡片 + 会话区胶囊用的轻量视图。
   *
   * 只带前 6 条候选的展示名：设置页点「管理」再拉完整视图（含目录与日志），
   * 免得每 20 秒轮询一次状态接口就搬一大堆账号和模型。
   */
  const autoBrief = () => {
    const snapshot = autoAdapter.snapshot()
    const listed = autoRouter.list(autoCooling)
    return {
      enabled: snapshot.enabled,
      lastRoute: snapshot.lastRoute,
      coolingCount: snapshot.coolingCount,
      switchCount24h: snapshot.switchCount24h,
      candidateCount: listed.length,
      availableCount: listed.filter((entry) => entry.ready && entry.coolingMs === 0).length,
      chain: listed.slice(0, 6).map((entry) => ({
        key: entry.key,
        providerName: entry.providerName ?? entry.provider,
        modelName: entry.modelName ?? entry.model,
        accountLabel: entry.accountLabel ?? '',
        ready: entry.ready,
        reason: entry.reason,
        coolingMs: entry.coolingMs,
      })),
    }
  }

  // ---- OpenAI 网关（TK-0004）：装配、运行期启停与设置页视图 ----
  /**
   * 网关的「可写配置」单独落一个文件。
   *
   * 为什么不用 gateway.json（Key 存储）的 options 字段：Key 存储门面只对外暴露
   * Key 相关方法（lib/core/gateway-keys.js，本单不允许改），读改写 options 会绕开
   * 它的串行化事务。别名表仍放在这里，但**同一个对象**既给网关又给路由，改了立即生效。
   *
   * 默认 enabled=false：升级插件绝不能擅自开监听端口。
   */
  const gatewayKeysPath = typeof config.gateway?.keysPath === 'string' && config.gateway.keysPath !== ''
    ? config.gateway.keysPath
    : config.stateDir === undefined ? defaultKeysPath() : join(stateDir, 'gateway.json')
  const gatewayAuditPath = typeof config.gateway?.auditPath === 'string' && config.gateway.auditPath !== ''
    ? config.gateway.auditPath
    : config.stateDir === undefined ? defaultAuditPath() : join(stateDir, 'gateway-audit.ndjson')
  const gatewaySettingsPath = join(stateDir, 'gateway-settings.json')

  const clampInt = (value, fallback, min, max) => {
    const n = Math.floor(Number(value))
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback
  }

  const gatewayDefaults = () => ({
    enabled: config.gateway?.enabled === true,
    host: typeof config.gateway?.bind === 'string' && config.gateway.bind !== ''
      ? config.gateway.bind
      : typeof config.gateway?.host === 'string' && config.gateway.host !== '' ? config.gateway.host : '127.0.0.1',
    port: clampInt(config.gateway?.port, 8765, 0, 65535),
    concurrency: clampInt(config.gateway?.concurrency, 4, 1, 64),
    perMinute: clampInt(config.gateway?.perMinute, 120, 1, 100_000),
    audit: config.gateway?.audit !== false,
    tls: false,
  })

  const gatewayAliasTable = {}
  let gatewaySettings = gatewayDefaults()

  /** 从磁盘恢复：坏文件按默认值处理，不能让插件起不来。 */
  const loadGatewaySettings = async () => {
    let stored = {}
    try {
      const raw = await readFile(gatewaySettingsPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`网关配置读取失败（已用默认值）：${String(error)}`)
    }
    const defaults = gatewayDefaults()
    gatewaySettings = {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : defaults.enabled,
      host: typeof stored.host === 'string' && stored.host !== '' ? stored.host : defaults.host,
      port: clampInt(stored.port, defaults.port, 0, 65535),
      concurrency: clampInt(stored.concurrency, defaults.concurrency, 1, 64),
      perMinute: clampInt(stored.perMinute, defaults.perMinute, 1, 100_000),
      audit: typeof stored.audit === 'boolean' ? stored.audit : defaults.audit,
      tls: false,
    }
    if (stored.aliases !== null && typeof stored.aliases === 'object' && !Array.isArray(stored.aliases)) {
      for (const [alias, target] of Object.entries(stored.aliases)) {
        if (typeof target === 'string' && target !== '') gatewayAliasTable[alias] = target
      }
    }
  }
  await loadGatewaySettings()

  const saveGatewaySettings = async () => {
    const text = `${JSON.stringify({ version: 1, ...gatewaySettings, aliases: { ...gatewayAliasTable } }, null, 2)}\n`
    const temp = `${gatewaySettingsPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, text, { mode: 0o600 })
    try {
      await rename(temp, gatewaySettingsPath)
      await chmod(gatewaySettingsPath, 0o600)
    } catch (error) {
      warn(`网关配置保存失败：${String(error)}`)
      throw error
    }
  }

  /** Key 门面：审计开关在这里拦截，其余方法原样转发。 */
  const gatewayKeyStore = createKeyStore({ keysPath: gatewayKeysPath, auditPath: gatewayAuditPath, warn })
  const gatewayKeyFacade = {
    ...gatewayKeyStore,
    appendAudit: (record) => (gatewaySettings.audit === false ? Promise.resolve() : gatewayKeyStore.appendAudit(record)),
  }

  /** 候选绑定地址：回环 + 本机内网 IPv4（界面下拉用，不联网）。 */
  const gatewayHostCandidates = () => {
    const found = [{ host: '127.0.0.1', label: '127.0.0.1' }]
    try {
      for (const [name, addresses] of Object.entries(networkInterfaces())) {
        for (const info of addresses ?? []) {
          if (info?.family !== 'IPv4' || info.internal === true) continue
          if (found.some((entry) => entry.host === info.address)) continue
          found.push({ host: info.address, label: `${info.address}（${name}）` })
        }
      }
    } catch {
      // 拿不到网卡就只留回环
    }
    if (!found.some((entry) => entry.host === gatewaySettings.host)) {
      found.push({ host: gatewaySettings.host, label: gatewaySettings.host })
    }
    return found
  }

  /** `/v1/models` 的目录：当前启用模型 + mg:auto + 别名。 */
  const gatewayModelEntries = () => {
    const entries = ['mg:auto']
    for (const platform of manager.platforms) {
      for (const model of platform.enabledModels()) {
        entries.push(`mg:${platform.providerKey}:${model.id}`)
      }
    }
    for (const alias of Object.keys(gatewayAliasTable)) {
      if (!entries.includes(alias)) entries.push(alias)
    }
    return entries
  }

  /** 今日审计统计：只数请求条数与 token，正文从不落盘。 */
  const gatewayToday = async () => {
    let text
    try {
      text = await readFile(gatewayAuditPath, 'utf8')
    } catch {
      return { requests: 0, tokens: 0 }
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    // 只扫尾部：审计只用来展示「今天」的量，历史不需要精确到天
    const tail = lines.slice(-5000)
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    let requests = 0
    let tokens = 0
    for (const line of tail) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const at = typeof record?.at === 'string' ? new Date(record.at) : undefined
      if (at === undefined || Number.isNaN(at.getTime())) continue
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
      if (day !== today) continue
      requests += 1
      tokens += (Number(record.promptTokens) || 0) + (Number(record.completionTokens) || 0)
    }
    return { requests, tokens }
  }

  let gatewayInstance
  let gatewayRunning = false
  let gatewayLastError = ''

  const buildGateway = () => createGateway({
    ctx,
    config: { host: gatewaySettings.host, port: gatewaySettings.port, aliases: gatewayAliasTable },
    warn,
    modelsProvider: gatewayModelEntries,
    // 白名单运行期现取：平台开关、Auto 都随时可变
    providers: () => [AUTO_PROVIDER, ...manager.platforms.map((platform) => platform.providerKey)],
    limits: { concurrency: gatewaySettings.concurrency, perMinute: gatewaySettings.perMinute },
    keysPath: gatewayKeysPath,
    auditPath: gatewayAuditPath,
    keyStore: gatewayKeyFacade,
  })

  const startGateway = async () => {
    if (gatewayInstance === undefined) gatewayInstance = buildGateway()
    try {
      await gatewayInstance.start()
      gatewayRunning = true
      gatewayLastError = ''
    } catch (error) {
      gatewayRunning = false
      gatewayLastError = error instanceof Error ? error.message : String(error)
      warn(`OpenAI 网关监听失败（${gatewaySettings.host}:${gatewaySettings.port}）：${gatewayLastError}`)
      await gatewayInstance.stop().catch(() => {})
    }
    return gatewayRunning
  }

  const stopGateway = async () => {
    if (gatewayInstance === undefined) return
    await gatewayInstance.stop().catch((error) => warn(`关闭 OpenAI 网关失败：${String(error)}`))
    gatewayRunning = false
  }

  /** 改配置要重建实例：host/port/限流都在构造期定死。 */
  const restartGateway = async () => {
    await stopGateway()
    gatewayInstance = undefined
    if (gatewaySettings.enabled) await startGateway()
  }

  const gatewayView = async () => {
    const address = gatewayRunning ? gatewayInstance?.address() : undefined
    const keys = await gatewayKeyFacade.listKeys().catch((error) => {
      warn(`读取网关 Key 列表失败：${String(error)}`)
      return []
    })
    return {
      enabled: gatewaySettings.enabled,
      running: gatewayRunning && address !== undefined,
      address: {
        host: address?.host ?? gatewaySettings.host,
        port: address?.port ?? gatewaySettings.port,
        url: address?.url ?? null,
      },
      baseUrl: address === undefined ? null : `${address.url}/v1`,
      keyCount: keys.length,
      keys,
      aliases: { ...gatewayAliasTable },
      limits: { concurrency: gatewaySettings.concurrency, perMinute: gatewaySettings.perMinute },
      config: {
        host: gatewaySettings.host,
        port: gatewaySettings.port,
        concurrency: gatewaySettings.concurrency,
        perMinute: gatewaySettings.perMinute,
        audit: gatewaySettings.audit,
        tls: false,
      },
      candidates: gatewayHostCandidates(),
      today: await gatewayToday(),
      auditPath: gatewayAuditPath,
      keysPath: gatewayKeysPath,
      lastError: gatewayLastError,
    }
  }

  // ---- HTTP 路由（给浏览器半边） ----
  const mountRoutes = (webCtx) => {
    const sendJson = (response, status, payload) => {
      const text = JSON.stringify(payload)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      })
      response.end(text)
    }

    const mount = (path, method, handler) => {
      webCtx.effect(() =>
        webCtx.webServer.register({
          kind: 'exact',
          path,
          handler: async (request, response) => {
            if (request.method !== method && !(method === 'GET' && request.method === 'HEAD')) {
              sendJson(response, 405, { error: 'method not allowed' })
              return
            }
            try {
              await handler(request, response)
            } catch (error) {
              sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      )
    }

    mount('/model-pool/status', 'GET', async (request, response) => {
      // 当前账号的积分 30 秒内过期就顺手刷一次：用户在用的时候积分一直在掉，
      // 靠 5 分钟的定时器看数字会明显滞后。其它账号仍走 5 分钟定时器。
      const now = Date.now()
      for (const platform of manager.platforms) {
        const account = platform.currentAccount()
        if (account === undefined) continue
        const record = platform.quotaByAccount?.[account.id]
        if (record !== undefined && record.at !== undefined && now - record.at < 30_000) continue
        await platform.refreshQuota(account.id).catch(() => {})
      }
      sendJson(response, 200, { platforms: manager.snapshot(), lastUsed: manager.lastUsedSnapshot(), auto: autoBrief() })
    })

    mount('/model-pool/refresh', 'POST', async (request, response) => {
      sendJson(response, 200, { platforms: await refreshAll() })
    })

    mount('/model-pool/checkin', 'POST', async (request, response) => {
      const body = await readJsonBody(request).catch(() => ({}))
      // 带 id 就是单账号补签，不带就全部账号
      if (typeof body.id === 'string' && body.id !== '') {
        const platform = manager.get(body.provider)
        await platform.checkInOne(body.id)
      } else if (typeof body.provider === 'string' && body.provider !== '') {
        await manager.get(body.provider).checkInAllAccounts({ force: true })
      } else {
        await manager.checkInAll()
      }
      await refreshAll()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    mount('/model-pool/quota/refresh', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const platform = manager.get(body.provider)
      if (typeof body.id === 'string' && body.id !== '') await platform.refreshQuota(body.id)
      else await platform.refreshAllQuotas()
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    mount('/model-pool/account/select', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const platform = manager.get(body.provider)
      await platform.selectAccount(body.id)
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    mount('/model-pool/account/remove', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const platform = manager.get(body.provider)
      await platform.removeAccount(body.id)
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    mount('/model-pool/login/start', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const provider = String(body.provider ?? '')
      if (provider === MEOO_KEY) {
        sendJson(response, 200, await startMeooLogin())
        return
      }
      if (provider === LINGXI_KEY) {
        sendJson(response, 200, await startLingxiLogin())
        return
      }
      if (provider === RACCOON_KEY) {
        sendJson(response, 200, await startRaccoonLogin())
        return
      }
      if (provider === SCNET_KEY) {
        sendJson(response, 200, await startScnetLogin(String(body.loginId ?? ''), String(body.phone ?? ''), String(body.captcha ?? '')))
        return
      }
      const started = provider === CODEARTS_KEY ? await startCodeArtsLogin() : await startWorkBuddyLogin({ global: body.global === true })
      sendJson(response, 200, started)
    })

    mount('/model-pool/login/poll', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const provider = String(body.provider ?? '')
      const loginId = String(body.loginId ?? '')
      const outcome = provider === MEOO_KEY
        ? await pollMeooLogin(loginId)
        : provider === LINGXI_KEY
          ? await pollLingxiLogin(loginId)
          : provider === RACCOON_KEY
          ? await pollRaccoonLogin(loginId)
          : provider === SCNET_KEY
          ? await submitScnetLogin(loginId, String(body.smsCode ?? ''))
          : provider === CODEARTS_KEY
            ? await pollCodeArtsLogin(loginId)
            : await pollWorkBuddyLogin(loginId)
      if (outcome.done === true && outcome.account !== undefined) {
        const platform = manager.get(provider)
        // 带 reauthId 就是"就地重新认证"：只换凭证，保留账号 id / 模型勾选 / 签到记录。
        const reauthId = String(body.reauthId ?? '')
        if (reauthId !== '') {
          await platform.reauthenticate(reauthId, outcome.account.credential, outcome.account.label)
        } else {
          await platform.addAccount(outcome.account)
        }
        await platform.rebuild?.()
        sendJson(response, 200, { done: true, reauthenticated: reauthId !== '', platforms: manager.snapshot() })
        return
      }
      sendJson(response, 200, outcome)
    })

    mount('/model-pool/login/scnet/captcha', 'POST', async (request, response) => {
      sendJson(response, 200, await startScnetCaptcha())
    })

    mount('/model-pool/login/captcha', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      sendJson(response, 200, await refreshScnetCaptcha(String(body.loginId ?? '')))
    })

    // 就地重新认证：登录流程拿到新凭证后，替换指定账号的凭证（不删账号、不丢勾选/签到）。
    // 前端在 login/poll 成功后调这个，而不是删除重建。
    mount('/model-pool/account/reauth', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const platform = manager.get(body.provider)
      await platform.reauthenticate(String(body.id ?? ''), body.credential, typeof body.label === 'string' ? body.label : undefined)
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    // Meoo 添加账号：粘一个 meoo_ak_…（控制面 API Key），插件自己换出项目服务 AK。
    // 这不是「导入本机登录」—— key 是用户主动粘贴的自己的凭据。
    mount('/model-pool/meoo/apikey', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const key = String(body.apiKey ?? '').trim()
      const account = key.startsWith('meoo_project_service_v1.')
        ? await accountFromServiceAk(key)
        : await accountFromApiKey(key)
      const platform = manager.get(MEOO_KEY)
      const reauthId = String(body.reauthId ?? '')
      if (reauthId !== '') await platform.reauthenticate(reauthId, account.credential, account.label)
      else await platform.addAccount(account)
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    // 平台级开关（目前只有 SCNet 的「只显示免费模型」）
    mount('/model-pool/option', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const platform = manager.get(body.provider)
      const key = String(body.key ?? '')
      if (key === '') throw new Error('缺少 key')
      // 并发上限：即时生效，且不影响模型清单，不打上游。
      const isConcurrency = body.provider === CODEARTS_KEY && key === 'maxConcurrent'
      await platform.setOption(key, body.value, { refresh: !isConcurrency })
      if (isConcurrency) {
        shim?.setMaxConcurrent?.(body.value)
      }
      if (body.provider === SCNET_KEY && key === 'scnetFreeOnly' && typeof scnet.setFreeOnly === 'function') {
        scnet.setFreeOnly(body.value)
      }
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    mount('/model-pool/model/bulk', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const platform = manager.get(body.provider)
      await platform.bulkModels(String(body.mode ?? 'all'))
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    mount('/model-pool/model/patch', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const platform = manager.get(body.provider)
      await platform.patchModel(String(body.id), body.patch ?? {})
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    mount('/model-pool/model/toggle', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const platform = manager.get(body.provider)
      await platform.toggleModel(body.id, body.enabled === true)
      await platform.rebuild?.()
      sendJson(response, 200, { platforms: manager.snapshot() })
    })

    // ---- Auto 模式 ----
    // 说明：Auto 的响应统一带 platforms，前端可以复用同一套刷新逻辑。
    mount('/model-pool/auto', 'GET', async (request, response) => {
      sendJson(response, 200, { auto: autoView(), platforms: manager.snapshot() })
    })

    mount('/model-pool/auto/enable', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      await autoStore.setEnabled(body.enabled === true)
      notifyAuto()
      sendJson(response, 200, { auto: autoView(), platforms: manager.snapshot() })
    })

    mount('/model-pool/auto/policy', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      await autoStore.patchPolicy(body.patch ?? {})
      notifyAuto()
      sendJson(response, 200, { auto: autoView(), platforms: manager.snapshot() })
    })

    mount('/model-pool/auto/candidates/add', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const result = await autoStore.addCandidates(body.items)
      // 服务端再判一次重复：弹窗可能开着很久，期间别处可能已加过同一条
      if (result.added.length > 0) notifyAuto()
      sendJson(response, 200, { ...result, auto: autoView(), platforms: manager.snapshot() })
    })

    mount('/model-pool/auto/candidates/remove', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const removed = await autoStore.removeCandidate(String(body.key ?? ''))
      if (removed) notifyAuto()
      sendJson(response, 200, { removed, auto: autoView(), platforms: manager.snapshot() })
    })

    mount('/model-pool/auto/candidates/move', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      // index 给了就是拖拽落位（绝对位置）；否则按 delta 上下挪一位。
      const moved = body.index === undefined
        ? await autoStore.moveCandidate(String(body.key ?? ''), Number(body.delta ?? 0))
        : await autoStore.reorderCandidate(String(body.key ?? ''), Number(body.index))
      if (moved) notifyAuto()
      sendJson(response, 200, { moved, auto: autoView(), platforms: manager.snapshot() })
    })

    mount('/model-pool/auto/history/clear', 'POST', async (request, response) => {
      autoAdapter.clearHistory()
      autoCooling.clear()
      sendJson(response, 200, { auto: autoView(), platforms: manager.snapshot() })
    })

    // ---- OpenAI 网关设置（TK-0004） ----
    // 这些路由只服务设置页，webServer 本身只监听回环，不需要再套一层 Key 鉴权。
    mount('/model-pool/gateway', 'GET', async (request, response) => {
      sendJson(response, 200, await gatewayView())
    })

    mount('/model-pool/gateway/toggle', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const wanted = body.enabled === true
      gatewaySettings.enabled = wanted
      await saveGatewaySettings()
      if (wanted) await startGateway()
      else await stopGateway()
      sendJson(response, 200, await gatewayView())
    })

    mount('/model-pool/gateway/config', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const patch = {}
      if (typeof body.host === 'string' && body.host.trim() !== '') patch.host = body.host.trim()
      if (body.port !== undefined) patch.port = clampInt(body.port, gatewaySettings.port, 1, 65535)
      if (body.concurrency !== undefined) patch.concurrency = clampInt(body.concurrency, gatewaySettings.concurrency, 1, 64)
      if (body.perMinute !== undefined) patch.perMinute = clampInt(body.perMinute, gatewaySettings.perMinute, 1, 100_000)
      if (typeof body.audit === 'boolean') patch.audit = body.audit
      const serverChanged = (patch.host !== undefined && patch.host !== gatewaySettings.host)
        || (patch.port !== undefined && patch.port !== gatewaySettings.port)
        || (patch.concurrency !== undefined && patch.concurrency !== gatewaySettings.concurrency)
        || (patch.perMinute !== undefined && patch.perMinute !== gatewaySettings.perMinute)
      Object.assign(gatewaySettings, patch)
      await saveGatewaySettings()
      // 只改审计开关不需要重建监听；其余参数都在构造期定死，必须重启
      if (serverChanged) await restartGateway()
      sendJson(response, 200, await gatewayView())
    })

    mount('/model-pool/gateway/key/create', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const created = await gatewayKeyFacade.createKey(String(body.name ?? ''))
      // 明文只在这里返回一次，之后列表只有 prefix/suffix
      sendJson(response, 200, { id: created.id, name: created.name, key: created.key })
    })

    mount('/model-pool/gateway/key/toggle', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const updated = await gatewayKeyFacade.setEnabled(String(body.id ?? ''), body.enabled === true)
      if (updated === undefined) throw new Error('没有这把 Key')
      sendJson(response, 200, await gatewayView())
    })

    mount('/model-pool/gateway/key/remove', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const removed = await gatewayKeyFacade.removeKey(String(body.id ?? ''))
      if (!removed) throw new Error('没有这把 Key')
      sendJson(response, 200, await gatewayView())
    })

    mount('/model-pool/gateway/alias/set', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const name = String(body.name ?? '').trim()
      const target = String(body.target ?? '').trim()
      if (name === '') throw new Error('别名不能为空')
      // 别名不能带 mg: 前缀（会被 parseModel 先当前缀解析），也不能指向自己
      if (name.startsWith('mg:')) throw new Error('别名不能以 mg: 开头')
      if (name === target) throw new Error('别名不能指向自己')
      // 目标必须是 mg:auto 或 mg:<provider>:<model>，否则网关永远解析不出来
      if (!/^mg:auto$/.test(target) && !/^mg:[^:\s]+:[^\s]+$/.test(target)) {
        throw new Error('目标要写成 mg:auto 或 mg:<平台>:<模型>')
      }
      gatewayAliasTable[name] = target
      await saveGatewaySettings()
      sendJson(response, 200, await gatewayView())
    })

    mount('/model-pool/gateway/alias/remove', 'POST', async (request, response) => {
      const body = await readJsonBody(request)
      const name = String(body.name ?? '').trim()
      if (Object.hasOwn(gatewayAliasTable, name)) delete gatewayAliasTable[name]
      await saveGatewaySettings()
      sendJson(response, 200, await gatewayView())
    })
  }

  ctx.inject(['webServer'], (webCtx) => mountRoutes(webCtx))

  // 附件服务可能比本插件晚就绪：一旦可用就重建模型，把图片输入打开
  ctx.inject(['attachments'], () => {
    setTimeout(() => {
      refreshAll().catch((error) => warn(`附件服务就绪后重建失败：${String(error)}`))
    }, 0).unref?.()
  })

  // 网关启动放在清理链注册之后：apply 里即使 listen 失败也只是记一条 warn，
  // 不能让整个插件（六家平台）跟着起不来。
  if (gatewaySettings.enabled === true) {
    await startGateway()
  }

  ctx.effect(() => async () => {
    clearInterval(timer)
    clearInterval(quotaTimer)
    clearInterval(probeTimer)
    keeper?.stop()
    for (const release of releaseDiscoveries) release()
    for (const release of releaseDirectories) release()
    for (const release of releaseAdapters) release()
    await stopGateway()
    await shim?.close()
    await workbuddyShim?.close()
    await lingxiShim?.close()
    disposeLogins()
  })

  ctx.logger?.info?.(`[${name}] 已启动：${manager.platforms.map((platform) => platform.displayName).join(' / ')}`)
}
