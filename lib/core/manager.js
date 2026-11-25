/**
 * 平台管理器：账号池、当前账号、模型开关、刷新与签到。
 *
 * 适配器是无状态的（凭证进来，数据出去），所以多账号、切换、持久化全部在这里。
 * 每个平台一份状态文件：`~/.dsh/model-pool/<provider>.json`。
 *
 * @module dsh-connect-model-gateway/core/manager
 */

import { join } from 'node:path'
import { readState, writeState, activeOf } from './state.js'
import { identityFromJwt } from './login.js'

/** 签到失败的退避节奏：3 次重试，间隔递增，当天不无限重来。 */
const CHECK_IN_BACKOFF_MS = [2_000, 10_000, 60_000]
/** 「今天暂不可签」的记录多久允许重新问一次上游（上游状态会变，不能封一整天）。 */
const CHECK_IN_REPROBE_MS = 30 * 60_000

/** 一天一次签到的本地日期键。 */
function todayKey() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 一个平台的运行时。
 *
 * @param {{
 *   adapter: object,
 *   providerKey: string,
 *   displayName: string,
 *   fallbackModels: Array<object>,
 *   stateDir: string,
 *   warn: (m: string) => void,
 * }} spec
 */
function createPlatform(spec) {
  const { adapter, providerKey, displayName, fallbackModels, stateDir, warn } = spec
  const statePath = join(stateDir, `${providerKey}.json`)

  const platform = {
    adapter,
    providerKey,
    displayName,
    statePath,
    state: { activeAccount: '', accounts: [], disabledModels: [], checkIn: {}, options: {} },
    /** 运行时数据，不落盘。 */
    runtime: {
      models: [...fallbackModels],
      quota: null,
      auth: { state: 'signed-out' },
      lastError: null,
      lastRefreshMs: 0,
    },

    async load() {
      this.state = await readState(statePath)
    },

    async save() {
      await writeState(statePath, this.state).catch((error) => {
        warn(`${displayName} 状态落盘失败：${String(error)}`)
      })
    },

    /** 当前账号对象（含凭证）。 */
    currentAccount() {
      return activeOf(this.state)
    },

    /** 当前账号的凭证；没有账号时抛错。 */
    currentCredential() {
      const account = this.currentAccount()
      if (account === undefined) throw new Error(`${displayName} 还没有账号`)
      return account.credential
    },

    /**
     * 凭证续期失败时的自愈：从磁盘重读该账号的最新凭证。
     *
     * 踩过的坑：CodeArts 的 keeper 是独立进程，它先一步用 refresh token 换到
     * 新 token 并写回状态文件；主进程内存里还是旧的那份，再续一次就回
     * `400 STS5.1806: the refresh token has been used`。这时候磁盘上的新 token
     * 才是有效的，重读一遍即可恢复，不该让用户删账号重新登录。
     */
    async reloadCredential(account) {
      try {
        const disk = await readState(statePath)
        const fresh = disk.accounts?.find((item) => item.id === account.id)
        if (fresh?.credential !== undefined) {
          account.credential = fresh.credential
          this.dirty = false // 磁盘已是最新，别把旧内存再写回去
          return true
        }
      } catch {
        // 读盘失败就保持原样
      }
      return false
    },

    /** 把适配器返回的（可能已续期的）凭证写回账号。 */
    adopt(account, credential) {
      if (account === undefined || credential === undefined) return
      account.credential = credential
      this.dirty = true
    },

    /**
     * 修补旧账号：凭证里没有 uid/nickname 的，从 access token 的 JWT 声明里补；
     * 补完如果撞上另一个账号的 uid，就合并（保留先出现的，凭证以新的为准）。
     */
    async repairAccounts() {
      let changed = false
      const seen = new Map()
      const kept = []
      for (const account of this.state.accounts) {
        const credential = account.credential ?? {}
        if (credential.uid === undefined || credential.uid === '') {
          const identity = identityFromJwt(credential.accessToken ?? credential.token ?? '')
          if (identity !== undefined) {
            credential.uid = identity.uid
            if (identity.nickname !== '') account.label = identity.nickname
            changed = true
          }
        }
        const key = credential.uid !== undefined && credential.uid !== '' ? credential.uid : account.id
        if (seen.has(key)) {
          // 合并到已有条目：用这条的凭证覆盖（更新的登录）
          const existing = seen.get(key)
          existing.credential = credential
          if (account.label !== '' && account.label !== 'WorkBuddy 账号') existing.label = account.label
          changed = true
          continue
        }
        seen.set(key, account)
        kept.push(account)
      }
      if (kept.length !== this.state.accounts.length) {
        this.state.accounts = kept
        if (!kept.some((account) => account.id === this.state.activeAccount)) {
          this.state.activeAccount = kept[0]?.id ?? ''
        }
        changed = true
      }
      if (changed) await this.save()
      return changed
    },

    /** 新增一个账号（登录流程拿到的），并设为当前。 */
    async addAccount(account) {
      const fingerprint = (item) => String(item.credential?.refreshToken ?? '') || String(item.credential?.token ?? '')
      const existing = this.state.accounts.find(
        (item) => item.id === account.id || (fingerprint(item) !== '' && fingerprint(item) === fingerprint(account)),
      )
      if (existing !== undefined) {
        existing.credential = account.credential
        existing.label = account.label
      } else {
        this.state.accounts.push({
          id: account.id,
          label: account.label,
          credential: account.credential,
          addedAt: Date.now(),
        })
      }
      this.state.activeAccount = account.id
      await this.save()
      await this.refresh()
      return this.snapshot()
    },
    /**
     * 就地重新认证：把新凭证写回**指定账号**，保留 id / 勾选状态 / 签到记录。
     *
     * 为什么必须有这个：会话过期后如果只能"删除 → 重新新增"，用户会丢掉
     * 该账号的模型勾选与签到历史，而且多账号时会错位。重新登录只该换凭证，
     * 不该把整条账号记录重建。
     *
     * @param {string} id 账号 id
     * @param {object} credential 新凭证
     * @param {string} [label] 可选的新显示名
     */
    async reauthenticate(id, credential, label) {
      const account = this.state.accounts.find((item) => item.id === id)
      if (account === undefined) throw new Error(`${displayName} 没有这个账号：${id}`)
      account.credential = credential
      if (typeof label === 'string' && label !== '') account.label = label
      account.reauthenticatedAt = Date.now()
      delete account.authError
      await this.save()
      await this.refresh()
      return this.snapshot()
    },

    /** 切换当前账号。 */
    async selectAccount(id) {
      if (!this.state.accounts.some((account) => account.id === id)) {
        throw new Error(`${displayName} 没有这个账号：${id}`)
      }
      this.state.activeAccount = id
      await this.save()
      await this.refresh()
    },

    /** 删除账号（从我们的池子里移除，不动本地客户端登录）。 */
    async removeAccount(id) {
      this.state.accounts = this.state.accounts.filter((account) => account.id !== id)
      if (this.state.activeAccount === id) {
        this.state.activeAccount = this.state.accounts[0]?.id ?? ''
      }
      await this.save()
      await this.refresh()
    },

    /**
     * 平台级开关（如 SCNet 的「只显示免费模型」）。
     * 落在状态文件里，重启后仍然生效；改完要 rebuild 让模型清单跟着变。
     */
    async setOption(key, value, options = {}) {
      this.state.options = { ...(this.state.options ?? {}), [key]: value }
      await this.save()
      // 有些开关（如并发上限）不影响模型清单，没必要为它打一轮上游。
      if (options.refresh !== false) await this.refresh()
    },

    getOption(key, fallback) {
      const value = (this.state.options ?? {})[key]
      return value === undefined ? fallback : value
    },

    /** 勾选/取消一个模型。 */
    async toggleModel(modelId, enabled) {
      const disabled = new Set(this.state.disabledModels)
      if (enabled) disabled.delete(modelId)
      else disabled.add(modelId)
      this.state.disabledModels = [...disabled]
      await this.save()
    },

    /** 批量开关：all 全开 / none 全关 / invert 反选。 */
    async bulkModels(mode) {
      const ids = this.runtime.models.map((model) => model.id)
      if (mode === 'all') this.state.disabledModels = []
      else if (mode === 'none') this.state.disabledModels = [...ids]
      else {
        const disabled = new Set(this.state.disabledModels)
        for (const id of ids) {
          if (disabled.has(id)) disabled.delete(id)
          else disabled.add(id)
        }
        this.state.disabledModels = [...disabled]
      }
      await this.save()
    },

    /** 这个模型是否启用。 */
    modelEnabled(modelId) {
      return !this.state.disabledModels.includes(modelId)
    },

    /** 单个模型的覆盖设置（图片输入、上下文窗口）。 */
    modelOverride(modelId) {
      return (this.state.modelSettings ?? {})[modelId] ?? {}
    },

    /** 改一个模型的设置：enabled / vision / contextWindow。 */
    async patchModel(modelId, patch) {
      if (this.state.modelSettings === undefined) this.state.modelSettings = {}
      if (typeof patch.enabled === 'boolean') {
        const disabled = new Set(this.state.disabledModels)
        if (patch.enabled) disabled.delete(modelId)
        else disabled.add(modelId)
        this.state.disabledModels = [...disabled]
      }
      const settings = { ...(this.state.modelSettings[modelId] ?? {}) }
      if (typeof patch.vision === 'boolean') settings.vision = patch.vision
      if (typeof patch.thinking === 'string') settings.thinking = patch.thinking
      if (patch.contextWindow === null) delete settings.contextWindow
      else if (typeof patch.contextWindow === 'number' && patch.contextWindow > 0) settings.contextWindow = patch.contextWindow
      this.state.modelSettings[modelId] = settings
      await this.save()
    },

    /** 实际进选择器的模型。 */
    enabledModels() {
      return this.runtime.models
        .filter((model) => this.modelEnabled(model.id))
        .map((model) => {
          const override = this.modelOverride(model.id)
          return {
            ...model,
            vision: override.vision === undefined ? model.vision : override.vision,
            contextWindow: override.contextWindow ?? model.contextWindow,
            thinking: override.thinking ?? model.thinkingDefault ?? null,
            thinkingOptions: model.thinkingOptions ?? [],
          }
        })
    },

    /** 拉一次账号状态 + 余额 + 目录。失败只记错误。 */
    async refresh() {
      this.runtime.lastRefreshMs = Date.now()
      const account = this.currentAccount()
      if (account === undefined) {
        this.runtime.auth = { state: 'signed-out' }
        this.runtime.models = [...fallbackModels]
        this.runtime.quota = null
        this.runtime.lastError = null
        return this.snapshot()
      }
      await this.refreshAllQuotas().catch(() => {})
      try {
        this.runtime.auth = await adapter.probe(account.credential)
        // 积分阶段已判定登录失效时，probe 的"看起来还有 token"不能把它盖回 signed-in
        if (this.authFailure === true) {
          this.runtime.auth = { ...this.runtime.auth, state: 'expired', detail: this.authDetail }
        }
        // 平台在 probe 里给出了更友好的账号名（如灵犀的 profile.name）就回写，
        // 否则列表里只会显示一串 id。
        const betterLabel = typeof this.runtime.auth?.label === 'string' ? this.runtime.auth.label : ''
        if (betterLabel !== '' && betterLabel !== account.label) {
          account.label = betterLabel
          this.dirty = true
        }
        if (this.runtime.auth.state !== 'expired') {
          const [models, quota] = await Promise.all([
            adapter.listModels(account.credential).catch((error) => {
              warn(`${displayName} 模型目录读取失败：${String(error?.message ?? error)}`)
              return undefined
            }),
            typeof adapter.quota === 'function'
              ? adapter.quota(account.credential).catch((error) => {
                  warn(`${displayName} 余额读取失败：${String(error?.message ?? error)}`)
                  return undefined
                })
              : Promise.resolve(undefined),
          ])
          // listModels 有的平台返回 {models, credential}，有的直接返回数组
          const modelList = Array.isArray(models) ? models : models?.models
          if (Array.isArray(modelList) && modelList.length > 0) {
            this.runtime.models = modelList
            await this.syncModels(modelList).catch(() => {})
          }
          if (!Array.isArray(models) && models?.credential !== undefined) this.adopt(account, models.credential)
          if (quota !== undefined && quota !== null) {
            this.runtime.quota = quota
            if (quota.credential !== undefined) this.adopt(account, quota.credential)
          }
        }
        this.runtime.lastError = null
      } catch (error) {
        this.runtime.lastError = error instanceof Error ? error.message : String(error)
      }
      if (this.dirty) {
        this.dirty = false
        await this.save()
      }
      return this.snapshot()
    },

    /**
     * 凭证续期/读取失败时，判断是不是「登录态真的没了」。
     * 是的话把平台状态升级成 expired 并给当前账号打 authError —— 否则会出现
     * 「概览卡片说正常、账号行说错误」的分裂（Meoo 令牌失效时就是这样）。
     */
    markAuthFailure(error) {
      const message = error instanceof Error ? error.message : String(error ?? '')
      const authLike = error?.kind === 'auth'
        || error?.status === 401
        || /失效|重新认证|invalid_grant|unauthor|token.*(invalid|expired|已过期)/i.test(message)
      if (!authLike) return false
      this.runtime.auth = { state: 'expired', account: this.runtime.auth?.account, detail: message }
      // 平台级标记：refresh() 里 probe() 跑在积分之后，不能让它把 expired 盖回去
      this.authFailure = true
      this.authDetail = message
      const active = this.state.accounts.find((account) => account.id === this.state.activeAccount)
      if (active !== undefined) active.authError = true
      this.dirty = true
      return true
    },

    /**
     * 每个账号各自的积分。
     *
     * 积分是账号级属性：多账号下各号余额不同，所以逐号拉、逐号缓存，
     * 一个号失败只影响它自己那一份。
     */
    async refreshAllQuotas() {
      if (typeof adapter.quota !== 'function') return
      this.quotaByAccount = this.quotaByAccount ?? {}
      for (const account of this.state.accounts) {
        try {
          const quota = await adapter.quota(account.credential)
          if (quota?.credential !== undefined) this.adopt(account, quota.credential)
          const { credential: _drop, ...rest } = quota ?? {}
          this.quotaByAccount[account.id] = { ...rest, at: Date.now() }
          if (account.id === this.state.activeAccount) {
            this.runtime.quota = quota ?? null
            this.authFailure = false
          }
        } catch (error) {
          this.quotaByAccount[account.id] = { error: error instanceof Error ? error.message : String(error), at: Date.now() }
          if (account.id === this.state.activeAccount) {
            this.runtime.quota = null
            this.markAuthFailure(error)
          }
        }
      }
      this.dirty = true
    },

    /** 单个账号刷积分。 */
    async refreshQuota(accountId) {
      if (typeof adapter.quota !== 'function') return
      const account = this.state.accounts.find((item) => item.id === accountId)
      if (account === undefined) return
      this.quotaByAccount = this.quotaByAccount ?? {}
      try {
        const quota = await adapter.quota(account.credential)
        if (quota?.credential !== undefined) this.adopt(account, quota.credential)
        const { credential: _drop, ...rest } = quota ?? {}
        this.quotaByAccount[accountId] = { ...rest, at: Date.now() }
        if (account.id === this.state.activeAccount) this.authFailure = false
        /**
         * 关键：卡片/胶囊读的是 `runtime.quota`，而这里以前只更新 quotaByAccount。
         * 于是 /status 每 30 秒确实拉了新余额，界面却一直显示 5 分钟前的值。
         * 刷的是当前账号时，必须同步 runtime.quota。
         */
        if (account.id === this.state.activeAccount) this.runtime.quota = quota ?? null
      } catch (error) {
        this.quotaByAccount[accountId] = { error: error instanceof Error ? error.message : String(error), at: Date.now() }
        if (account.id === this.state.activeAccount) {
          this.runtime.quota = null
          this.markAuthFailure(error)
        }
      }
      this.dirty = true
      await this.save()
    },

    /**
     * 模型目录每天回源；新出现的模型默认启用。
     * 已手动关掉的模型不动（它们在 disabledModels 里）。
     */
    async syncModels(models) {
      const today = todayKey()
      const meta = this.state.modelMeta ?? { lastSyncDate: '', knownModels: [] }
      const known = new Set(meta.knownModels)
      const fresh = models.map((model) => model.id).filter((id) => !known.has(id))
      if (fresh.length > 0 || meta.lastSyncDate !== today) {
        for (const id of fresh) known.add(id)
        this.state.modelMeta = { lastSyncDate: today, knownModels: [...known] }
        await this.save()
      }
      return fresh
    },

    /**
     * 对一个账号签到。
     *
     * 重试策略（用户要求）：可恢复的失败退避重试，当天封顶；
     * 「没有活动」「今天已领」这类终态不重试。
     */
    async checkInAccount(account, options = {}) {
      if (typeof adapter.checkIn !== 'function') return undefined
      const record = this.state.checkInByAccount?.[account.id]
      if (record !== undefined && record.date === todayKey() && record.alreadyCheckedIn === true) return record
      if (options.force !== true && record !== undefined && record.date === todayKey()) {
        /**
         * 当天已尝试过且不是「已签」，默认不再打上游（避免一小时一次的无用请求）。
         * 但**不能整天封死**：上游状态会变（例如灵犀的 daily 任务从 incomplete
         * 变成 claimable/claimed），封一天就会一整天显示「未签到」。
         * 所以给一个冷却窗口：超过 30 分钟就允许重新探一次。
         */
        const at = typeof record.at === 'number' ? record.at : 0
        if (record.unavailable === true && Date.now() - at < CHECK_IN_REPROBE_MS) return record
      }

      const delays = options.delays ?? CHECK_IN_BACKOFF_MS
      let last
      for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        try {
          const result = await adapter.checkIn(account.credential)
          if (result.credential !== undefined) this.adopt(account, result.credential)
          const next = {
            date: todayKey(),
            at: Date.now(),
            credit: result.credit ?? 0,
            alreadyCheckedIn: result.alreadyCheckedIn === true,
            // 概览卡片要显示「连续 N 天」，这个数只有适配器知道
            ...(typeof result.streakDays === 'number' ? { streakDays: result.streakDays } : {}),
            unavailable: result.unavailable === true,
            error: result.error,
            detail: result.detail,
            attempts: attempt + 1,
          }
          this.state.checkInByAccount = { ...(this.state.checkInByAccount ?? {}), [account.id]: next }
          await this.save()
          // 终态不重试：已签 / 无活动；有 error 才继续
          if (next.error === undefined) return next
          last = next
        } catch (error) {
          last = { date: todayKey(), error: error instanceof Error ? error.message : String(error), attempts: attempt + 1 }
          this.state.checkInByAccount = { ...(this.state.checkInByAccount ?? {}), [account.id]: last }
          await this.save()
        }
        if (attempt < delays.length) await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
      }
      return last
    },

    /** 对**所有**账号签到（用户要求：不止当前账号）。 */
    async checkInAllAccounts(options = {}) {
      if (typeof adapter.checkIn !== 'function') return []
      const results = []
      for (const account of this.state.accounts) {
        const result = await this.checkInAccount(account, options)
        if (result !== undefined) results.push({ accountId: account.id, label: account.label, ...result })
      }
      return results
    },

    /** 单个账号手动补签（跳过当天已试过的限制）。 */
    async checkInOne(accountId) {
      const account = this.state.accounts.find((item) => item.id === accountId)
      if (account === undefined) return undefined
      return this.checkInAccount(account, { force: true })
    },
    /** 这个平台有没有签到能力，以及当前账号可不可签。 */
    checkInCapability() {
      return typeof adapter.checkIn === 'function'
    },
    /** 给界面/路由的快照。凭证一律剥掉，只留可展示数据。 */
    snapshot() {
      const rawQuota = this.runtime.quota ?? {}
      const { credential: _dropCredential, ...quota } = rawQuota
      return {
        provider: this.providerKey,
        displayName: this.displayName,
        auth: this.runtime.auth,
        quota,
        lastError: this.runtime.lastError,
        lastRefreshMs: this.runtime.lastRefreshMs,
        activeAccount: this.state.activeAccount,
        accounts: this.state.accounts.map((account) => ({
          id: account.id,
          label: account.label,
          active: account.id === this.state.activeAccount,
          reauthenticatedAt: account.reauthenticatedAt ?? null,
        })),
        models: this.runtime.models.map((model) => {
          const override = this.modelOverride(model.id)
          return {
            ...model,
            vision: override.vision === undefined ? model.vision : override.vision,
            contextWindow: override.contextWindow ?? model.contextWindow,
            hasContextOverride: override.contextWindow !== undefined,
            thinking: override.thinking ?? model.thinkingDefault ?? null,
            thinkingIsDefault: override.thinking === undefined,
            thinkingOptions: model.thinkingOptions ?? [],
            enabled: this.modelEnabled(model.id),
          }
        }),
        enabledCount: this.enabledModels().length,
        registeredNames: this.registeredNames ?? [],
        rebuildAt: this.rebuildAt ?? null,
        rebuildError: this.rebuildError ?? null,
        checkIn: (this.state.checkInByAccount ?? {})[this.currentAccount()?.id ?? ''] ?? {},
        checkInSupported: typeof adapter.checkIn === 'function',
        options: { ...(this.state.options ?? {}) },
        quotaByAccount: (this.state.accounts ?? []).map((account) => ({
          id: account.id,
          label: account.label,
          ...(this.quotaByAccount?.[account.id] ?? {}),
        })),
        checkInByAccount: Object.entries(this.state.checkInByAccount ?? {}).map(([id, record]) => ({
          id,
          label: this.state.accounts.find((account) => account.id === id)?.label ?? id,
          ...record,
        })),
      }
    },

    /** 推理需要的 baseUrl / apiKey。 */
    async inferenceTarget() {
      const account = this.currentAccount()
      if (account === undefined) throw new Error(`${displayName} 还没有账号`)
      let credential
      try {
        credential = await adapter.refresh(account.credential)
      } catch (error) {
        // keeper 竞态：磁盘可能已有更新后的 token，重读后再试一次
        const message = error instanceof Error ? error.message : String(error)
        if (/has been used|invalid refresh token/i.test(message) && await this.reloadCredential(account)) {
          try {
            credential = await adapter.refresh(account.credential)
          } catch {
            credential = account.credential
          }
        } else {
          credential = account.credential
        }
      }
      this.adopt(account, credential)
      const baseUrl = adapter.chatBase(credential)
      return { baseUrl, apiKey: credential.accessToken ?? credential.token ?? '' }
    },
  }

  return platform
}

/**
 * 管理器。
 *
 * @param {{specs: Array<object>, stateDir: string, warn: (m: string) => void}} options
 */
export function createManager(options) {
  const platforms = options.specs.map((spec) => createPlatform({ ...spec, stateDir: options.stateDir, warn: options.warn }))
  const byKey = new Map(platforms.map((platform) => [platform.providerKey, platform]))

  return {
    platforms,
    byKey,

    /** 记一次「这个平台刚被用过」，用来决定会话区胶囊显不显示。 */
    markUsed(providerKey) {
      this.lastUsed = { provider: providerKey, at: Date.now() }
    },

    get(providerKey) {
      const platform = byKey.get(providerKey)
      if (platform === undefined) throw new Error(`没有这个平台：${providerKey}`)
      return platform
    },

    /** 读状态。账号只能来自真实登录，不再从本地客户端导入。 */
    async init() {
      for (const platform of platforms) {
        await platform.load()
        // 旧版本登录的账号可能没有身份：从 token 里补一次，并按身份去重
        if (platform.repairAccounts !== undefined) await platform.repairAccounts().catch(() => {})
        // 账号上的凭证可能过期，进来先续一遍，避免首屏显示过期
        for (const account of platform.state.accounts) {
          try {
            const next = await platform.adapter.refresh(account.credential)
            if (next !== undefined) platform.adopt(account, next)
          } catch (error) {
            // keeper 进程可能已经续过并写盘：重读一次再试，避免"token has been used"
            const message = error instanceof Error ? error.message : String(error)
            if (/has been used|invalid refresh token|refresh token/i.test(message)) {
              if (await platform.reloadCredential(account)) {
                try {
                  const retry = await platform.adapter.refresh(account.credential)
                  if (retry !== undefined) platform.adopt(account, retry)
                } catch {
                  // 磁盘那份也不行，才真的需要重新认证
                }
              }
            }
          }
        }
        if (platform.dirty) {
          platform.dirty = false
          await platform.save()
        }
      }
    },

    async refreshAll() {
      const results = []
      for (const platform of platforms) {
        // 先从磁盘重读一次：外部改过状态文件（或别的进程写过）时，内存里的
        // disabledModels / accounts 不该继续用旧的那份。
        await platform.load().catch(() => {})
        await platform.refresh()
        results.push(platform.snapshot())
      }
      return results
    },

    async checkInAll() {
      for (const platform of platforms) {
        await platform.checkInAllAccounts().catch((error) => {
          options.warn(`${platform.displayName} 签到失败：${String(error)}`)
        })
      }
    },

    snapshot() {
      return platforms.map((platform) => platform.snapshot())
    },

    lastUsedSnapshot() {
      return this.lastUsed ?? null
    },
  }
}
