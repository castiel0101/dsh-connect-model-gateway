/**
 * Auto 模式：候选按「平台 + 账号 + 模型」三元组排序，首包前出错就换下一个。
 *
 * 与「手选单个模型」严格分开：
 *  - Auto 只用候选自己绑定的账号，**不读也不写**平台全局当前账号；
 *  - 冷却按候选三元组各自计算，冷却中的候选直接跳过，不排队等；
 *  - 状态落 `~/.dsh/model-pool/auto.json`，与各平台状态文件互不相干。
 *
 * 为什么在 adapter 里桥接而不是在 loop 层切模型：宿主给插件的恢复动作只有
 * `{kind:'retry'}`（dsh-agent/src/runtime-types.ts），改不了模型；而 adapter 的
 * stream 是唯一能「用户无感地换一条路再发一次」的位置。
 *
 * 关键约束：**一旦向会话吐过内容块，就锁定当前候选**。内容已经进界面，重放
 * 会出现两段回答，所以后续错误原样上抛。
 *
 * @module dsh-connect-model-gateway/core/auto-route
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Auto 的 provider 路由键。和平台键不冲突（平台键沿用旧插件的值）。 */
export const AUTO_PROVIDER = 'auto'
/** Auto 只有一个模型条目。 */
export const AUTO_MODEL = 'auto'
/** 与服务端自动刷新解耦：状态文件独立。 */
const HISTORY_LIMIT = 50

/**
 * 默认切换策略。
 *
 * 勾上的都是「换个模型/账号大概率能成」的：限流、额度、登录、服务端、传输、
 * 空回复。刻意**不勾** INVALID_REQUEST（换模型可能蒙过，但会掩盖真 bug）和
 * CONTEXT_WINDOW_EXCEEDED（换模型也可能超窗，且属于该压缩了）。
 */
export const DEFAULT_SWITCH_CODES = Object.freeze([
  'RATE_LIMIT',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'AUTH',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'MISSING_CREDENTIAL',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'STREAM_CLOSED',
  'EMPTY_RESPONSE',
  'PI_AI_ERROR',
  'HTTP_429',
  'HTTP_402',
])

/** 可选但不默认勾的码，给高级用户。 */
export const OPTIONAL_SWITCH_CODES = Object.freeze([
  'INVALID_REQUEST',
  'CONTEXT_WINDOW_EXCEEDED',
  'MALFORMED_RESPONSE',
])

/**
 * 永远不切。
 *
 * - `ABORTED`：用户主动取消。
 * - `IMAGE_OFFLOAD_REQUIRED`：请求侧前置校验失败，换候选没有意义（消息历史和
 *   图片预算都一样）。它要求先由 `dsh-compaction-image-offload` 卸载最老的
 *   图片再重试整步；Auto 要做的只是把 failure 原样上抛（含 `offloadImages`），
 *   不要冷却、不要换下一个。
 */
const NEVER_SWITCH = new Set(['ABORTED', 'IMAGE_OFFLOAD_REQUIRED'])

/** 各类失败的冷却时长；没列到的用 policy.coolMs。 */
const COOLDOWN_BY_CODE = {
  QUOTA: 10 * 60_000,
  ACCOUNT_QUOTA: 10 * 60_000,
  HTTP_402: 10 * 60_000,
  AUTH: 2 * 60_000,
  ACCOUNT_SIGN_IN_REQUIRED: 2 * 60_000,
  ACCOUNT_TOKEN_INVALID: 2 * 60_000,
  MISSING_CREDENTIAL: 2 * 60_000,
  RATE_LIMIT: 60_000,
  HTTP_429: 60_000,
}

export const DEFAULT_POLICY = Object.freeze({
  /** 失败后冷却时长（毫秒），按候选算。 */
  coolMs: 60_000,
  /** 一次请求最多试几个候选。 */
  maxAttempts: 4,
  /** 命中这些码就换下一个。 */
  switchOn: DEFAULT_SWITCH_CODES,
})

/**
 * 把一次调用方的账号上下文带到下游 provider 的凭证解析里。
 *
 * 宿主给 PiAiAdapter 的 `resolveApiKey` / `prepareHeaders` 只带 provider 与 model，
 * 没有「这次用哪个账号」的位置；Auto 用 ALS 把它带过去，正常请求下 store 是空的，
 * 一切照旧。
 */
export const accountScope = new AsyncLocalStorage()

/** 三元组键：候选身份的唯一表示。 */
export function candidateKey(candidate) {
  return `${candidate.provider}|${candidate.accountId}|${candidate.model}`
}

/** 一次失败该不该换下一个候选。 */
export function shouldSwitch(failure, policy) {
  const code = typeof failure?.code === 'string' ? failure.code : ''
  if (code === '' || NEVER_SWITCH.has(code)) return false
  const list = Array.isArray(policy?.switchOn) ? policy.switchOn : DEFAULT_SWITCH_CODES
  return list.includes(code)
}

function normalizePolicy(raw) {
  const policy = { ...DEFAULT_POLICY, ...(raw !== null && typeof raw === 'object' ? raw : {}) }
  const coolMs = Number(policy.coolMs)
  policy.coolMs = Number.isFinite(coolMs) && coolMs >= 0 ? Math.min(coolMs, 3_600_000) : DEFAULT_POLICY.coolMs
  const maxAttempts = Number(policy.maxAttempts)
  policy.maxAttempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? Math.min(maxAttempts, 16) : DEFAULT_POLICY.maxAttempts
  const allowed = new Set([...DEFAULT_SWITCH_CODES, ...OPTIONAL_SWITCH_CODES])
  policy.switchOn = Array.isArray(policy.switchOn)
    ? [...new Set(policy.switchOn.filter((code) => typeof code === 'string' && allowed.has(code)))]
    : [...DEFAULT_SWITCH_CODES]
  return policy
}

function normalizeCandidate(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '' || provider === AUTO_PROVIDER) return undefined
  // accountId 允许为空串：魔桥单账号平台的旧数据可能没记（describe 里兜到当前账号），
  // 而 DSH 自带的 provider 根本没有账号概念，一律用空串。
  return { provider, accountId, model }
}

/**
 * 候选与策略的持久化容器。写盘用临时文件 + rename，权限 0600。
 *
 * @param {{path: string, warn?: (m: string) => void}} options
 */
export function createAutoStore(options) {
  const { path, warn = () => {} } = options
  const state = { enabled: true, candidates: [], policy: { ...DEFAULT_POLICY }, updatedAt: 0 }

  const store = {
    get path() {
      return path
    },

    get enabled() {
      return state.enabled
    },

    get policy() {
      return state.policy
    },

    /** 候选快照（只读副本）。 */
    candidates() {
      return state.candidates.map((candidate) => ({ ...candidate }))
    },

    async load() {
      let raw
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return store
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return store
        state.enabled = parsed.enabled !== false
        state.candidates = Array.isArray(parsed.candidates)
          ? parsed.candidates.map(normalizeCandidate).filter((candidate) => candidate !== undefined)
          : []
        state.policy = normalizePolicy(parsed.policy)
        state.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
        // 同一个三元组只留第一条：手改文件或旧版本重复写都收敛到这里
        const seen = new Set()
        state.candidates = state.candidates.filter((candidate) => {
          const key = candidateKey(candidate)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      } catch (error) {
        warn(`Auto 状态文件解析失败，按空配置启动：${String(error)}`)
      }
      return store
    },

    async save() {
      state.updatedAt = Date.now()
      const temporary = `${path}.tmp-${process.pid}`
      try {
        await writeFile(temporary, JSON.stringify({
          enabled: state.enabled,
          candidates: state.candidates,
          policy: state.policy,
          updatedAt: state.updatedAt,
        }, null, 2), { mode: 0o600 })
        await rename(temporary, path)
      } catch (error) {
        warn(`Auto 状态落盘失败：${String(error)}`)
      }
    },

    async setEnabled(enabled) {
      state.enabled = enabled === true
      await store.save()
      return state.enabled
    },

    async patchPolicy(patch) {
      if (patch !== null && typeof patch === 'object') {
        state.policy = normalizePolicy({ ...state.policy, ...patch })
        await store.save()
      }
      return state.policy
    },

    /**
     * 批量添加候选。按三元组去重（前端也会挡，但弹窗可能开着很久，状态会过期，
     * 服务端必须再判一次）。
     *
     * @returns {{added: object[], skipped: object[]}}
     */
    async addCandidates(items) {
      const existing = new Set(state.candidates.map(candidateKey))
      const added = []
      const skipped = []
      for (const item of Array.isArray(items) ? items : []) {
        const candidate = normalizeCandidate(item)
        if (candidate === undefined) {
          skipped.push({ item, reason: 'invalid' })
          continue
        }
        const key = candidateKey(candidate)
        if (existing.has(key)) {
          skipped.push({ ...candidate, key, reason: 'duplicate' })
          continue
        }
        existing.add(key)
        state.candidates.push(candidate)
        added.push({ ...candidate, key })
      }
      if (added.length > 0) await store.save()
      return { added, skipped }
    },

    async removeCandidate(key) {
      const before = state.candidates.length
      state.candidates = state.candidates.filter((candidate) => candidateKey(candidate) !== key)
      const removed = before !== state.candidates.length
      if (removed) await store.save()
      return removed
    },

    /** 上下移动一位：delta = -1 上移，+1 下移。 */
    async moveCandidate(key, delta) {
      const index = state.candidates.findIndex((candidate) => candidateKey(candidate) === key)
      const target = index + Math.sign(Number(delta) || 0)
      if (index === -1 || target < 0 || target >= state.candidates.length) return false
      const [moved] = state.candidates.splice(index, 1)
      state.candidates.splice(target, 0, moved)
      await store.save()
      return true
    },

    /** 拖拽排序：直接挪到第 index 位（0 起）。 */
    async reorderCandidate(key, index) {
      const from = state.candidates.findIndex((candidate) => candidateKey(candidate) === key)
      const to = Math.max(0, Math.min(state.candidates.length - 1, Math.trunc(Number(index))))
      if (from === -1 || !Number.isFinite(to) || from === to) return false
      const [moved] = state.candidates.splice(from, 1)
      state.candidates.splice(to, 0, moved)
      await store.save()
      return true
    },

    /** 状态文件被外部改动（手改）后重读。 */
    async reload() {
      state.candidates = []
      state.policy = { ...DEFAULT_POLICY }
      return store.load()
    },
  }

  return store
}

/**
 * 冷却表：内存态，重启清空。键是三元组。
 *
 * 不落盘是刻意的——上游 429 是瞬时的，重启后重新试一次没有损失。
 */
export function createCooling({ now = Date.now } = {}) {
  const entries = new Map()
  return {
    /** 该候选是否还在冷却。过期的顺手清掉。 */
    active(key) {
      const entry = entries.get(key)
      if (entry === undefined) return false
      if (entry.until <= now()) {
        entries.delete(key)
        return false
      }
      return true
    },
    remainingMs(key) {
      const entry = entries.get(key)
      if (entry === undefined) return 0
      return Math.max(0, entry.until - now())
    },
    code(key) {
      return entries.get(key)?.code ?? null
    },
    mark(key, code, coolMs) {
      const base = COOLDOWN_BY_CODE[code] ?? coolMs
      // 自定义 coolMs 更短时尊重用户设置，取两者较短
      const ttl = Math.min(base, Math.max(coolMs, 1_000))
      entries.set(key, { until: now() + ttl, code, at: now() })
      return ttl
    },
    clear(key) {
      if (key === undefined) entries.clear()
      else entries.delete(key)
    },
    snapshot() {
      const out = []
      for (const [key, entry] of entries) {
        const remainingMs = entry.until - now()
        if (remainingMs <= 0) continue
        out.push({ key, code: entry.code, remainingMs })
      }
      return out
    },
  }
}

/**
 * 魔桥以外的 provider 目录（DSH 自带的 DeepSeek、用户自己配的 OpenAI 兼容等）。
 *
 * 这些 provider 没有账号概念，凭证由它们自己的适配器解析，所以 Auto 只负责
 * 「排优先级」和「失败了换下一个」，不碰它们的登录态。
 *
 * 元数据是异步取的（`llm.listModels` / `llm.resolveModelInfo`），但 describe()
 * 必须同步返回，所以这里维护一份缓存，由 `llm/adapters-updated` 与
 * `llm/models-updated` 事件驱动重建。
 *
 * @param {{ctx: object, exclude: Set<string>, warn?: (m: string) => void}} options
 */
export function createExternalCatalog(options) {
  const { ctx, exclude, warn = () => {} } = options
  /** provider → { id, name, models: Map<modelId, meta> } */
  const byProvider = new Map()
  let inflight

  async function build() {
    const llm = ctx.llm
    if (llm === undefined || typeof llm.listProviders !== 'function') return
    const providers = llm.listProviders()
    const next = new Map()
    for (const info of providers) {
      if (info.id === AUTO_PROVIDER || exclude.has(info.id)) continue
      try {
        const models = await llm.listModels(info.id)
        const entries = new Map()
        for (const model of models) {
          let resolved
          try {
            resolved = await llm.resolveModelInfo(info.id, model.id)
          } catch {
            // 单个模型的元数据失败不该让整个 provider 消失
            resolved = undefined
          }
          const modalities = resolved?.inputModalities ?? model.inputModalities ?? ['text']
          const badgeText = model.badge !== undefined && typeof model.badge.text === 'string'
            ? model.badge.text
            : undefined
          entries.set(model.id, {
            id: model.id,
            name: model.name,
            contextWindow: resolved?.context?.contextWindow,
            maxTokens: resolved?.defaultMaxTokens,
            vision: modalities.includes('image'),
            thinkingOptions: (resolved?.reasoning?.efforts ?? []).map((effort) => effort.id),
            defaultEffort: resolved?.reasoning?.defaultEffort,
            badge: badgeText,
          })
        }
        if (entries.size > 0) next.set(info.id, { id: info.id, name: info.name, models: entries })
      } catch (error) {
        warn(`Auto 读取 ${info.name} 的模型目录失败：${String(error)}`)
      }
    }
    byProvider.clear()
    for (const [key, value] of next) byProvider.set(key, value)
  }

  return {
    /** 重建缓存；并发调用共享同一次构建。 */
    refresh() {
      if (inflight !== undefined) return inflight
      inflight = build().catch((error) => {
        warn(`Auto 刷新外部 provider 目录失败：${String(error)}`)
      }).finally(() => {
        inflight = undefined
      })
      return inflight
    },

    get(provider) {
      return byProvider.get(provider)
    },

    /** 给添加候选弹窗用的目录快照。 */
    all() {
      return [...byProvider.values()].map((entry) => ({
        provider: entry.id,
        displayName: entry.name,
        external: true,
        accounts: [{ id: '', label: '无需账号（用 provider 自己的配置）', active: true, authError: false }],
        models: [...entry.models.values()].map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow ?? 0,
          badge: model.badge ?? null,
        })),
      }))
    },
  }
}

/**
 * 把候选解释成「能不能用、用了会怎样」。
 *
 * 两类候选：
 *  - 魔桥平台的（provider 在 manager.byKey 里）：带账号，登录态/模型开关都要判；
 *  - 其他 provider（DSH 自带的、用户自配的）：没有账号，元数据来自外部目录缓存，
 *    可用性交给它自己的适配器 —— Auto 只负责排序与换路。
 *
 * @param {{
 *   store: object,
 *   manager: object,
 *   external?: {get: (provider: string) => object | undefined},
 *   canImageNow?: () => boolean,
 * }} deps
 */
export function createAutoRouter(deps) {
  const { store, manager, external, canImageNow = () => false } = deps

  /** 一个候选的完整描述；不可用时给出原因。 */
  function describe(candidate) {
    const key = candidateKey(candidate)
    const platform = manager.byKey.get(candidate.provider)
    if (platform === undefined) {
      // 不是魔桥的平台：查外部目录（DSH 自带 / 用户自配的 provider）
      const entry = external?.get(candidate.provider)
      if (entry === undefined) {
        return { ...candidate, key, ready: false, reason: '平台未接入' }
      }
      const model = entry.models.get(candidate.model)
      if (model === undefined) {
        return {
          ...candidate,
          key,
          providerName: entry.name,
          ready: false,
          reason: '模型不在目录里',
        }
      }
      return {
        ...candidate,
        key,
        accountId: '',
        accountLabel: '',
        providerName: entry.name,
        displayName: entry.name,
        modelName: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        vision: model.vision === true,
        badge: model.badge ?? null,
        thinkingOptions: model.thinkingOptions ?? [],
        external: true,
        modelEnabled: true,
        ready: true,
        reason: null,
      }
    }
    // accountId 为空时兜到当前账号：单账号平台的旧数据不该因此失效
    const accounts = platform.state.accounts ?? []
    const account = candidate.accountId === ''
      ? platform.currentAccount()
      : accounts.find((item) => item.id === candidate.accountId)
    if (account === undefined) {
      return { ...candidate, key, providerName: platform.displayName, ready: false, reason: '账号已移除' }
    }
    const modelMeta = platform.modelMeta(candidate.model)
    if (modelMeta === undefined) {
      return {
        ...candidate,
        key,
        accountId: account.id,
        accountLabel: account.label,
        providerName: platform.displayName,
        ready: false,
        reason: '模型不在目录里',
      }
    }
    /**
     * 登录态只在「确定失效」时才挡候选。
     *
     * 注意 'signed-out'：平台的 runtime.auth 只描述当前账号，插件刚启动、探活
     * 还没跑时它一律是 signed-out。把它当失效会把刚启动的 Auto 全判死，所以
     * 只认 expired / authError —— 剩下的一律让它真去打一次，失败了自然进冷却。
     */
    const authState = platform.accountState(account.id)
    const signedOut = authState.authError === true || authState.state === 'expired'
    return {
      ...candidate,
      key,
      accountId: account.id,
      accountLabel: account.label,
      providerName: platform.displayName,
      displayName: platform.displayName,
      modelName: modelMeta.name,
      contextWindow: modelMeta.contextWindow,
      maxTokens: modelMeta.maxTokens,
      vision: modelMeta.vision === true,
      badge: modelMeta.badge ?? null,
      thinkingOptions: modelMeta.thinkingOptions ?? [],
      modelEnabled: modelMeta.enabled,
      ready: !signedOut && modelMeta.enabled,
      reason: signedOut ? '未登录' : modelMeta.enabled ? null : '模型已停用',
    }
  }

  return {
    describe,

    /** 全部候选的展示态（含冷却剩余、不可用原因），给设置页用。 */
    list(cooling) {
      return store.candidates().map((candidate) => {
        const described = describe(candidate)
        return {
          ...described,
          coolingMs: cooling === undefined ? 0 : cooling.remainingMs(described.key),
          coolingCode: cooling === undefined ? null : cooling.code(described.key),
        }
      })
    },

    /**
     * 这次请求实际要尝试的序列：按优先级、跳过不可用与冷却中、截到 maxAttempts。
     *
     * @returns {object[]}
     */
    plan(cooling) {
      const policy = store.policy
      const out = []
      for (const candidate of store.candidates()) {
        const described = describe(candidate)
        if (!described.ready) continue
        if (cooling !== undefined && cooling.active(described.key)) continue
        out.push(described)
        if (out.length >= policy.maxAttempts) break
      }
      return out
    },

    /** 只按「可用」算的能力并集/交集，给 resolveModel 用。 */
    capabilities() {
      const ready = store.candidates().map(describe).filter((entry) => entry.ready)
      if (ready.length === 0) return null
      const contexts = ready.map((entry) => entry.contextWindow).filter((value) => typeof value === 'number' && value > 0)
      return {
        count: ready.length,
        // 取最小值：宁可提前触发压缩，也不要发出一个只有部分候选吃得下的请求
        contextWindow: contexts.length > 0 ? Math.min(...contexts) : undefined,
        // 只有全部候选都支持图片，才对会话声明图片能力
        vision: canImageNow() && ready.every((entry) => entry.vision === true),
        first: ready[0],
      }
    },
  }
}

/**
 * 判断一帧是否算「已经交付给界面的内容」——一旦为真就不能再换候选。
 *
 * 只有**用户可见的正文/工具调用**才算。思考过程（`reasoning-delta`）和块边界
 * （`block-start`/`block-end`）不算：它们先堆在 `buffered` 里没有下发，此时
 * 上游截断仍可安全换候选。以前把 `reasoning-delta` 计入，推理模型在思考阶段
 * 被上游掐断就会锁死在一个坏候选上，用户只看到「本轮运行失败」。
 */
function isContentChunk(chunk) {
  return chunk?.type === 'text-delta'
    || chunk?.type === 'tool-call-delta'
}

function finishError(failure) {
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/**
 * 把一次调用失败收成可序列化的 failure。
 *
 * 宿主的 `LlmError.failure` 除了 `code`/`message` 还带 `offloadImages`、`status`、
 * `requestId` 这类字段，**必须原样透传**：`dsh-compaction-image-offload` 只有看到
 * `code === 'IMAGE_OFFLOAD_REQUIRED'` 且 `offloadImages !== undefined` 才会卸载旧图
 * 并重试整步。早先这里只挑 `code`/`message`，图片超预算的请求就永远无法自愈，
 * 用户只会看到「8 more oldest occurrence(s) must be offloaded.」
 */
function failureOf(error) {
  const failure = error?.failure
  // 只透传形状合法的 failure（宿主 LlmError 保证 code/message 非空字符串）；
  // 其余来源仍走下面的归一化，避免把残件当失败对象塞进 finish。
  if (failure !== undefined && typeof failure === 'object'
    && typeof failure.code === 'string' && failure.code !== ''
    && typeof failure.message === 'string' && failure.message !== '') return failure
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error ?? '未知错误'),
  }
}

/**
 * Auto 适配器：一个 provider、一个模型，内部按候选链转发。
 *
 * @param {{
 *   ctx: object,
 *   store: object,
 *   router: object,
 *   cooling: object,
 *   warn?: (m: string) => void,
 *   now?: () => number,
 * }} deps
 */
export function createAutoAdapter(deps) {
  const { ctx, store, router, cooling, warn = () => {}, now = Date.now } = deps
  const history = []
  let lastRoute = null

  function record(entry) {
    lastRoute = entry
    history.unshift(entry)
    if (history.length > HISTORY_LIMIT) history.pop()
  }

  /** 只有启用且至少有一条候选，Auto 才出现在选择器里。 */
  function visible() {
    return store.enabled && store.candidates().length > 0
  }

  /** 一次请求的候选尝试：先取 plan，再把每条挂上元数据。 */
  function plan() {
    return router.plan(cooling)
  }

  /** 把外层的请求改写成指向某个候选；外层对象是深冻结的，必须新建。 */
  function innerOptions(options, candidate) {
    const next = { ...options, provider: candidate.provider, model: candidate.model }
    // maxTokens 不能超过候选自己的上限，否则第一个候选就因为超限失败
    const ceiling = candidate.maxTokens
    if (typeof ceiling === 'number' && ceiling > 0 && (next.maxTokens === undefined || next.maxTokens > ceiling)) {
      next.maxTokens = ceiling
    }
    // 外层是按 Auto 的能力解析的，可能带了候选不支持的思考档位；
    // 留着会被下部校验挡成 UNSUPPORTED_REASONING_EFFORT，白丢一次尝试。
    // 注意：thinkingOptions 为空数组时不能当「支持零个档位」——那是用来自定义
    // thinking 开关的哨兵。外部 provider 的 reasoning 元数据可能没拉到，
    // 这时宁可原样送，让它的适配器按自己的规则处理。
    const efforts = candidate.thinkingOptions
    if (Array.isArray(efforts) && efforts.length > 0
      && next.reasoningEffort !== undefined && !efforts.includes(next.reasoningEffort)) {
      delete next.reasoningEffort
    }
    return next
  }

  async function closeQuietly(iterator) {
    try {
      await iterator.return?.()
    } catch {
      // 关流失败不影响换下一个候选
    }
  }

  /**
   * 宿主调 adapter 的方法是直接打上去的（不是 instanceof LlmAdapter 才调），
   * 所以基类那几个「有默认实现」的钩子这里必须自己补齐：prepareCall /
   * imageRequestPricing / imageRequestTarget 都会在请求装配路径上被无保护地调用。
   */
  const api = {
    providerInfo(provider) {
      return { id: provider, name: '魔桥 Auto' }
    },

    /** 声明不做图片计价（Auto 只是转发，真正的计价在候选那一层）。 */
    imageRequestPricing() {
      return undefined
    },

    /** 保持图片原尺寸：Auto 不重新编码，尺寸由候选自己的适配器决定。 */
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    /** 与基类默认一致：绑一份模型元数据 + 这次调用的入口。 */
    async prepareCall(provider, model, signal) {
      const info = await api.resolveModel(provider, model, signal)
      return { model: info, stream: (options) => api.stream(options) }
    },

    /**
     * Auto 自己不做整步重试：候选链已经把「换一条路」做完了，再让宿主重试整步
     * 只会把同一条链再撞一遍，用户还得多等一个退避。
     */
    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: Object.freeze([]),
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        jitterRatio: 0.1,
      })
    },

    async listModels(provider) {
      if (!visible()) return []
      const capabilities = router.capabilities()
      const chain = store.candidates().length
      const first = capabilities?.first
      return [{
        provider,
        id: AUTO_MODEL,
        name: 'Auto 模式',
        description: first === undefined
          ? `${chain} 条候选（都没有可用账号）`
          : `${first.providerName} · ${first.modelName} 起 · ${chain} 条候选 · 首包前自动换`,
        inputModalities: capabilities?.vision === true ? ['text', 'image'] : ['text'],
      }]
    },

    async resolveModel(provider, model) {
      const capabilities = router.capabilities()
      return {
        provider,
        id: model,
        name: 'Auto 模式',
        ...(capabilities?.contextWindow === undefined
          ? {}
          : { context: { contextWindow: capabilities.contextWindow } }),
        inputModalities: capabilities?.vision === true ? ['text', 'image'] : ['text'],
      }
    },

    /**
     * 一次 Auto 请求：按候选顺序试，首包前失败就换下一个。
     *
     * 一旦有内容块吐出去就锁定当前候选——已经发到界面的内容收不回来，
     * 硬重放会让 UI 出现两段回答。
     */
    async * stream(options) {
      const attempts = plan()
      const startedAt = now()
      const trail = []
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null

      if (!store.enabled) {
        yield finishError({ message: 'Auto 模式已关闭', code: 'AUTO_DISABLED' })
        return
      }
      if (store.candidates().length === 0) {
        yield finishError({ message: 'Auto 模式还没有候选，请在设置里添加', code: 'AUTO_EMPTY' })
        return
      }
      if (attempts.length === 0) {
        // 全部不可用或全在冷却：给出可操作的原因，而不是干巴巴的「失败」
        const described = router.list(cooling)
        const reasons = described.map((entry) => {
          if (entry.coolingMs > 0) return `${entry.modelName ?? entry.model} 冷却中（${Math.ceil(entry.coolingMs / 1000)}s）`
          return `${entry.modelName ?? entry.model} ${entry.reason ?? '不可用'}`
        })
        yield finishError({
          message: `Auto 没有可用候选：${reasons.join('；') || '无'}`,
          code: 'AUTO_NO_CANDIDATE',
        })
        record({ at: startedAt, sessionId, attempts: [], used: null, outcome: 'empty', ms: 0 })
        return
      }

      for (const candidate of attempts) {
        const attemptStarted = now()
        let iterator
        try {
          const inner = innerOptions(options, candidate)
          iterator = accountScope.run(
            { provider: candidate.provider, accountId: candidate.accountId },
            () => ctx.llm.stream(inner)[Symbol.asyncIterator](),
          )
        } catch (error) {
          trail.push({ ...pick(candidate), code: failureOf(error).code, ms: now() - attemptStarted, result: 'fail' })
          continue
        }

        // 读完一帧要保持在同一个账号上下文里：PiAiAdapter 的凭证解析与上游请求
        // 都在 next() 内部发生。
        const advance = () => accountScope.run(
          { provider: candidate.provider, accountId: candidate.accountId },
          () => iterator.next(),
        )

        const buffered = []
        let failure = null
        let committed = false
        let sawFinish = false

        try {
          for (;;) {
            const step = await advance()
            if (step.done === true) break
            const chunk = step.value
            buffered.push(chunk)
            if (chunk?.type === 'finish') {
              sawFinish = true
              const reason = chunk.reason
              if (reason?.kind === 'error' || reason?.kind === 'aborted') {
                failure = reason.failure ?? { code: 'UNKNOWN', message: '上游未给出失败原因' }
              }
              break
            }
            if (isContentChunk(chunk)) {
              committed = true
              break
            }
          }
        } catch (error) {
          failure = failureOf(error)
        }

        if (committed) {
          // 已向界面吐过内容：锁定这个候选，把剩下的一路透传
          for (const chunk of buffered) yield chunk
          try {
            for (;;) {
              const step = await advance()
              if (step.done === true) break
              yield step.value
            }
          } catch (error) {
            yield finishError(failureOf(error))
          }
          trail.push({ ...pick(candidate), code: null, ms: now() - attemptStarted, result: 'ok' })
          record({
            at: startedAt,
            sessionId,
            attempts: trail,
            used: pick(candidate),
            outcome: 'ok',
            switched: trail.filter((entry) => entry.result === 'fail').length,
            ms: now() - startedAt,
          })
          return
        }

        if (failure === null && !sawFinish) {
          failure = { code: 'STREAM_CLOSED', message: '候选流在没有终止帧的情况下结束' }
        }

        if (failure === null && sawFinish) {
          // 成功终止（stop / tool-calls / max-tokens）：原样交付
          for (const chunk of buffered) yield chunk
          trail.push({ ...pick(candidate), code: null, ms: now() - attemptStarted, result: 'ok' })
          record({
            at: startedAt,
            sessionId,
            attempts: trail,
            used: pick(candidate),
            outcome: 'ok',
            switched: trail.filter((entry) => entry.result === 'fail').length,
            ms: now() - startedAt,
          })
          return
        }

        await closeQuietly(iterator)
        const failureCode = String(failure.code ?? 'UNKNOWN')
        trail.push({ ...pick(candidate), code: failureCode, ms: now() - attemptStarted, result: 'fail' })

        if (!shouldSwitch(failure, store.policy)) {
          warn(`Auto：${candidate.modelName ?? candidate.model} 报 ${failureCode}，策略不切，直接上抛`)
          record({
            at: startedAt,
            sessionId,
            attempts: trail,
            used: null,
            outcome: 'fail',
            switched: trail.length - 1,
            ms: now() - startedAt,
          })
          // 原样上抛：IMAGE_OFFLOAD_REQUIRED 要靠 failure.offloadImages 触发卸载重试，
          // 其余码也保留 status/requestId 供失败步骤做诊断。
          yield finishError(failure)
          return
        }

        const ttl = cooling.mark(candidate.key, failureCode, store.policy.coolMs)
        warn(`Auto：${candidate.providerName}/${candidate.accountLabel}/${candidate.modelName ?? candidate.model} 失败 ${failureCode}，冷却 ${Math.round(ttl / 1000)}s，换下一个候选`)
      }

      const detail = trail.map((entry) => `${entry.modelName ?? entry.model}${entry.accountLabel === undefined ? '' : `@${entry.accountLabel}`} → ${entry.code}`).join('；')
      record({
        at: startedAt,
        sessionId,
        attempts: trail,
        used: null,
        outcome: 'fail',
        switched: trail.length - 1,
        ms: now() - startedAt,
      })
      yield finishError({
        message: `Auto 的 ${trail.length} 条候选全部失败：${detail}`,
        code: 'AUTO_EXHAUSTED',
      })
    },

    /** 给界面用的运行态：最近路由 + 日志 + 冷却。 */
    snapshot() {
      return {
        enabled: store.enabled,
        policy: store.policy,
        cooling: cooling.snapshot(),
        lastRoute,
        history: history.map((entry) => ({ ...entry })),
        switchCount24h: history.filter((entry) => entry.at > now() - 86_400_000 && (entry.switched ?? 0) > 0).length,
        coolingCount: cooling.snapshot().length,
      }
    },

    /** 界面「清空日志」。 */
    clearHistory() {
      history.length = 0
      lastRoute = null
    },
  }

  return api
}

/** 日志里只记能给人看的字段，不记凭证。 */
function pick(candidate) {
  return {
    provider: candidate.provider,
    providerName: candidate.providerName ?? candidate.provider,
    accountId: candidate.accountId,
    accountLabel: candidate.accountLabel,
    model: candidate.model,
    modelName: candidate.modelName ?? candidate.model,
  }
}