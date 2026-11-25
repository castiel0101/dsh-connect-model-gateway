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

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createWorkBuddyAdapter, KEY as WORKBUDDY_KEY } from './adapters/workbuddy.js'
import { createCodeArtsAdapter, defaultAccountsPath, canonicalModel, KEY as CODEARTS_KEY } from './adapters/codearts.js'
import { createMeooAdapter, accountFromApiKey, accountFromServiceAk, KEY as MEOO_KEY } from './adapters/meoo.js'
import { createScnetAdapter, KEY as SCNET_KEY } from './adapters/scnet.js'
import { createLingxiAdapter, KEY as LINGXI_KEY } from './adapters/lingxi.js'
import { withRetryFriendlyApi } from './core/retry-fetch.js'
import { startLingxiShim } from './core/lingxi-shim.js'
import { startCodeArtsShim } from './core/shim.js'
import { startWorkBuddyShim } from './core/workbuddy-shim.js'
import { loadHostPeers } from './core/host-peers.js'
import { createManager } from './core/manager.js'
import { startKeeper } from './core/keeper.js'
import { startWorkBuddyLogin, pollWorkBuddyLogin, startCodeArtsLogin, pollCodeArtsLogin, startMeooLogin, pollMeooLogin, startScnetLogin, startScnetCaptcha, refreshScnetCaptcha, submitScnetLogin, startLingxiLogin, pollLingxiLogin, disposeLogins } from './core/login.js'

export const name = 'dsh-connect-model-gateway'
export const inject = ['llm']

const STATE_DIRNAME = 'model-pool'
const CHECK_IN_INTERVAL_MS = 3600_000
/** 积分自动刷新间隔（用户要求自动刷，去掉手动按钮）。 */
const QUOTA_REFRESH_INTERVAL_MS = 5 * 60_000

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImages: 8,
  imageOffloadCountQuantum: 4,
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
        credentialForShim: async () => {
          const platform = manager.byKey.get(CODEARTS_KEY)
          const account = platform?.currentAccount()
          if (account === undefined) throw new Error('CodeArts 还没有账号')
          const credential = await codearts.ensureFresh(account.credential)
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

  // 灵犀需要本地 shim 做三步握手 + SSE 翻译（回环随机端口 + Bearer）。
  let lingxiShim
  try {
    lingxiShim = await startLingxiShim({
      warn,
      onChat: () => manager.markUsed(LINGXI_KEY),
      credential: async () => {
        const platform = manager.byKey.get(LINGXI_KEY)
        return platform?.currentAccount()?.credential
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
      credential: async () => {
        const platform = manager.byKey.get(WORKBUDDY_KEY)
        const account = platform?.currentAccount()
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

  // ---- 注册 LLM 路由 ----
  const releaseAdapters = []
  const releaseDirectories = []
  const releaseDiscoveries = []

  for (const platform of manager.platforms) {
    const providerKey = platform.providerKey

    /** 每个平台的推理目标：baseUrl 随当前账号变化，所以每次重建 provider。 */
    const inferenceFor = async () => {
      if (providerKey === CODEARTS_KEY && shim !== undefined) {
        return { baseUrl: `${shim.url}/codearts/v1`, apiKey: shim.token }
      }
      if (providerKey === WORKBUDDY_KEY && workbuddyShim !== undefined) {
        return { baseUrl: `${workbuddyShim.url}/workbuddy/v1`, apiKey: workbuddyShim.token }
      }
      // Meoo 走适配器自带的推理目标：网关本身就是 OpenAI 兼容，无需 shim；
      // 且 baseUrl 已含 /v1，apiKey 是项目服务 AK（每次现场解析）。
      if (providerKey === MEOO_KEY && typeof meoo.inferenceTarget === 'function') {
        const account = platform.currentAccount()
        if (account === undefined) throw new Error('Meoo 还没有账号')
        const result = await meoo.inferenceTarget(account.credential)
        platform.adopt(account, result.credential)
        return { baseUrl: result.baseUrl, apiKey: result.apiKey }
      }
      if (providerKey === SCNET_KEY) {
        const account = platform.currentAccount()
        if (account === undefined) throw new Error('SCNet 还没有账号')
        const result = await scnet.inferenceTarget(account.credential)
        platform.adopt(account, result.credential)
        return { baseUrl: result.baseUrl, apiKey: result.apiKey }
      }
      if (providerKey === LINGXI_KEY && lingxiShim !== undefined) {
        return { baseUrl: `${lingxiShim.url}/v1`, apiKey: lingxiShim.token }
      }
      const target = await platform.inferenceTarget()
      return { baseUrl: target.baseUrl, apiKey: target.apiKey }
    }

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
      ...REQUEST_IMAGE_BUDGETS,
      piProvider: provider,
    })
    let profiles = new Map([[providerKey, profileFor()]])

    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => (await inferenceFor()).apiKey,
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
      sendJson(response, 200, { platforms: manager.snapshot(), lastUsed: manager.lastUsedSnapshot() })
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
  }

  ctx.inject(['webServer'], (webCtx) => mountRoutes(webCtx))

  // 附件服务可能比本插件晚就绪：一旦可用就重建模型，把图片输入打开
  ctx.inject(['attachments'], () => {
    setTimeout(() => {
      refreshAll().catch((error) => warn(`附件服务就绪后重建失败：${String(error)}`))
    }, 0).unref?.()
  })

  ctx.effect(() => async () => {
    clearInterval(timer)
    clearInterval(quotaTimer)
    clearInterval(probeTimer)
    keeper?.stop()
    for (const release of releaseDiscoveries) release()
    for (const release of releaseDirectories) release()
    for (const release of releaseAdapters) release()
    await shim?.close()
    await workbuddyShim?.close()
    await lingxiShim?.close()
    disposeLogins()
  })

  ctx.logger?.info?.(`[${name}] 已启动：${manager.platforms.map((platform) => platform.displayName).join(' / ')}`)
}
