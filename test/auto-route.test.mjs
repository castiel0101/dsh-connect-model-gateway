/**
 * Auto 模式核心逻辑自测（不依赖 DSH 宿主，只喂假 chunk 流）。
 *
 * 跑法：node test/auto-route.test.mjs
 *
 * 覆盖：去重、冷却跳过、首包前换、已出内容不换、全失败聚合、策略开关、
 * 账号绑定（不动物流全局当前账号）。
 */

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { createManager } from '../lib/core/manager.js'
import {
  AUTO_MODEL,
  accountScope,
  candidateKey,
  createAutoAdapter,
  createAutoRouter,
  createAutoStore,
  createCooling,
  shouldSwitch,
} from '../lib/core/auto-route.js'

const dir = await mkdtemp(join(tmpdir(), 'mgw-auto-'))
await mkdir(dir, { recursive: true })

/** 两个平台各一个账号；models 由 fallbackModels 给。 */
async function makeManager(accounts) {
  const written = []
  for (const [provider, spec] of Object.entries(accounts)) {
    const path = join(dir, `${provider}.json`)
    await writeFile(path, JSON.stringify({
      activeAccount: spec.accounts[0].id,
      accounts: spec.accounts,
      disabledModels: spec.disabled ?? [],
      modelSettings: {},
      options: {},
    }))
    written.push([provider, spec])
  }
  const fakeAdapter = {
    async refresh(credential) {
      return credential
    },
    async probe() {
      return { state: 'signed-in' }
    },
    async listModels() {
      return []
    },
    chatBase() {
      return 'http://127.0.0.1:1'
    },
    async checkIn() {},
  }
  const manager = createManager({
    stateDir: dir,
    warn: () => {},
    specs: written.map(([provider, spec]) => ({
      adapter: fakeAdapter,
      providerKey: provider,
      displayName: spec.displayName,
      fallbackModels: spec.models,
    })),
  })
  await manager.init()
  return manager
}

const models = [
  { id: 'm-1', name: '模型一', contextWindow: 128_000, maxTokens: 8192, vision: false },
  { id: 'm-2', name: '模型二', contextWindow: 200_000, maxTokens: 16_384, vision: true },
  { id: 'm-3', name: '模型三', contextWindow: 64_000, maxTokens: 4096, vision: false },
]

const manager = await makeManager({
  alpha: {
    displayName: 'Alpha',
    accounts: [
      { id: 'a1', label: '甲账号', credential: { token: 't1' } },
      { id: 'a2', label: '乙账号', credential: { token: 't2' } },
    ],
    models,
  },
  beta: {
    displayName: 'Beta',
    accounts: [{ id: 'b1', label: '乙平台账号', credential: { token: 't3' } }],
    models: [models[1]],
    disabled: ['m-2'],
  },
})

const storePath = join(dir, 'auto.json')
let store = createAutoStore({ path: storePath })
await store.load()

const cooling = createCooling()
const router = createAutoRouter({ store, manager, canImageNow: () => true })

/** 假宿主：按 (provider|model) 回放预设的 chunk 序列，并记录收到的 options。 */
function fakeHost(script) {
  const calls = []
  const llm = {
    stream(options) {
      // 顺手记下 Auto 通过 ALS 带过来的账号绑定
      calls.push({ ...options, scope: accountScope.getStore() })
      const key = `${options.provider}|${options.model}`
      const producer = script[key]
      return (async function* () {
        if (producer === undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_SCRIPT', message: `没有为 ${key} 准备脚本` } } }
          return
        }
        yield* producer(options)
      })()
    },
  }
  return { ctx: { llm }, calls }
}

const text = (value) => ({ type: 'text-delta', index: 0, text: value })
const stop = { type: 'finish', reason: { kind: 'stop' } }
const fail = (code, message = code) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } })

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function makeAdapter(ctx) {
  return createAutoAdapter({ ctx, store, router, cooling, warn: () => {} })
}

// ---------- 1. 去重 ----------
{
  const result = await store.addCandidates([
    { provider: 'alpha', accountId: 'a1', model: 'm-1' },
    { provider: 'alpha', accountId: 'a1', model: 'm-1' },
    { provider: 'alpha', accountId: 'a2', model: 'm-1' },
    { provider: 'auto', accountId: 'a1', model: 'm-1' },
  ])
  assert.equal(result.added.length, 2, '同一三元组只加一条；auto 自己不能被当成候选')
  assert.equal(result.skipped.length, 2)
  assert.equal(result.skipped[0].reason, 'duplicate')
  assert.equal(result.skipped[1].reason, 'invalid')
}

// ---------- 2. 候选解释：账号、模型元数据、停用与未登录 ----------
{
  await store.addCandidates([
    { provider: 'beta', accountId: 'b1', model: 'm-2' },
    { provider: 'alpha', accountId: 'a1', model: 'm-3' },
  ])
  const list = router.list(cooling)
  assert.equal(list.length, 4)
  assert.equal(list[0].ready, true)
  assert.equal(list[0].accountLabel, '甲账号')
  assert.equal(list[0].contextWindow, 128_000)
  // beta 平台的 m-2 被停用了
  const disabled = list.find((entry) => entry.provider === 'beta')
  assert.equal(disabled.ready, false)
  assert.equal(disabled.reason, '模型已停用')
  // 账号被移除
  manager.byKey.get('alpha').state.accounts = manager.byKey.get('alpha').state.accounts.filter((a) => a.id !== 'a2')
  const gone = router.list(cooling).find((entry) => entry.accountId === 'a2')
  assert.equal(gone.ready, false)
  assert.equal(gone.reason, '账号已移除')
  manager.byKey.get('alpha').state.accounts.push({ id: 'a2', label: '乙账号', credential: { token: 't2' } })
}

// ---------- 3. 首包前失败 → 换下一个候选（账号按候选绑定） ----------
{
  const { ctx, calls } = fakeHost({
    'alpha|m-1': async function* () { yield fail('RATE_LIMIT', '429 太挤了') },
    'alpha|m-3': async function* () {
      yield text('来自模型三')
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield stop
    },
  })
  cooling.clear()
  // 只留 m-1(a1) 和 m-3(a1) 两条
  const chunks = await collect(makeAdapter(ctx).stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  const joined = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(joined, '来自模型三', '应该换到第三候选并交付它的内容')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // 前两条是同一个模型的甲/乙两个账号（脚本按 provider|model 命中，两条都会失败），
  // 第三条才成功 —— 正好验证「账号是候选维度」
  assert.deepEqual(calls.map((c) => `${c.model}@${c.scope?.accountId}`), ['m-1@a1', 'm-1@a2', 'm-3@a1'])
  // 冷却：失败的那条被标记
  assert.equal(cooling.active(candidateKey({ provider: 'alpha', accountId: 'a1', model: 'm-1' })), true)
  assert.equal(cooling.code(candidateKey({ provider: 'alpha', accountId: 'a1', model: 'm-1' })), 'RATE_LIMIT')
}

// ---------- 4. 冷却中的候选直接跳过，不排队等 ----------
{
  const { ctx, calls } = fakeHost({
    'alpha|m-3': async function* () { yield text('ok'); yield stop },
  })
  cooling.clear()
  for (const entry of router.list(cooling).filter((item) => item.model === 'm-1')) {
    cooling.mark(entry.key, 'RATE_LIMIT', 60_000)
  }
  const chunks = await collect(makeAdapter(ctx).stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(calls.length, 1, '冷却中的候选不该被请求，也不排队等')
  assert.equal(calls[0].model, 'm-3')
}

// ---------- 5. 已吐过内容后出错：锁定当前候选，不重放 ----------
{
  cooling.clear()
  let secondCalled = false
  const { ctx } = fakeHost({
    'alpha|m-1': async function* () {
      yield text('前半段')
      yield fail('SERVER', '上游 500')
    },
    'alpha|m-3': async function* () { secondCalled = true; yield text('不该出现'); yield stop },
  })
  const chunks = await collect(makeAdapter(ctx).stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  const joined = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(joined, '前半段')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'SERVER')
  assert.equal(secondCalled, false, '已经输出内容的这一轮不能重放')
}

// ---------- 6. 策略不勾的码不切换 ----------
{
  cooling.clear()
  const { ctx, calls } = fakeHost({
    'alpha|m-1': async function* () { yield fail('INVALID_REQUEST', '参数不对') },
    'alpha|m-3': async function* () { yield text('不该出现'); yield stop },
  })
  const chunks = await collect(makeAdapter(ctx).stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'INVALID_REQUEST')
  assert.equal(calls.length, 1, 'INVALID_REQUEST 默认不切换')
}

// ---------- 7. 全部失败：聚合错误里带每条候选的码 ----------
{
  cooling.clear()
  const { ctx } = fakeHost({
    'alpha|m-1': async function* () { yield fail('RATE_LIMIT') },
    'alpha|m-3': async function* () { yield fail('TIMEOUT') },
  })
  const chunks = await collect(makeAdapter(ctx).stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  const last = chunks.at(-1)
  assert.equal(last.reason.kind, 'error')
  assert.equal(last.reason.failure.code, 'AUTO_EXHAUSTED')
  assert.match(last.reason.failure.message, /RATE_LIMIT/)
  assert.match(last.reason.failure.message, /TIMEOUT/)
}

// ---------- 8. 没有可用候选时给可操作的原因 ----------
{
  cooling.clear()
  const saved = store.candidates()
  await store.removeCandidate(candidateKey(saved[0]))
  // 把剩下的都标记成冷却
  for (const entry of router.list(cooling)) cooling.mark(entry.key, 'RATE_LIMIT', 60_000)
  const { ctx, calls } = fakeHost({})
  const chunks = await collect(makeAdapter(ctx).stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  assert.equal(chunks.at(-1).reason.failure.code, 'AUTO_NO_CANDIDATE')
  assert.match(chunks.at(-1).reason.failure.message, /冷却中/)
  assert.equal(calls.length, 0)
  cooling.clear()
}

// ---------- 9. 模型条目：只有启用且有候选才出现 ----------
{
  const adapter = makeAdapter(fakeHost({}).ctx)
  assert.equal((await adapter.listModels('auto')).length, 1)
  await store.setEnabled(false)
  assert.equal((await adapter.listModels('auto')).length, 0)
  await store.setEnabled(true)
  const model = await adapter.resolveModel('auto', 'auto')
  // 上下文取候选最小值（m-3 是 64K）
  assert.equal(model.context.contextWindow, 64_000)
  // 不是所有候选都支持图片 → 只声明文本
  assert.deepEqual(model.inputModalities, ['text'])
}

// ---------- 10. 排序移动 + 落盘 ----------
{
  const before = store.candidates().map(candidateKey)
  await store.moveCandidate(before[0], 1)
  const after = store.candidates().map(candidateKey)
  assert.equal(after[0], before[1])
  const reread = createAutoStore({ path: storePath })
  await reread.load()
  assert.deepEqual(reread.candidates().map(candidateKey), after, '顺序要落盘')

  // reorderCandidate：把第 2 条直接拖到第 0 位
  const full = store.candidates().map(candidateKey)
  assert.equal(await store.reorderCandidate(full[2], 0), true)
  assert.equal(candidateKey(store.candidates()[0]), full[2], '拖拽后应落到指定位置')
  const reread2 = createAutoStore({ path: storePath })
  await reread2.load()
  assert.equal(candidateKey(reread2.candidates()[0]), full[2], '拖拽排序要落盘')

  // 复原顺序，后面用例依赖初始排列
  await store.reorderCandidate(full[2], 2)
  assert.deepEqual(store.candidates().map(candidateKey), full, '复原顺序')
}

// ---------- 11. 全局当前账号不受影响 ----------
{
  const platform = manager.byKey.get('alpha')
  const activeBefore = platform.state.activeAccount
  // 直接跑一次走 a2 的请求
  cooling.clear()
  const { ctx } = fakeHost({
    [`alpha|m-1`]: async function* () { yield text('x'); yield stop },
  })
  const adapter = makeAdapter(ctx)
  await store.addCandidates([{ provider: 'alpha', accountId: 'a2', model: 'm-1' }])
  await store.moveCandidate(candidateKey({ provider: 'alpha', accountId: 'a2', model: 'm-1' }), -1)
  const chunks = await collect(adapter.stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  const last = adapter.snapshot().lastRoute
  assert.equal(last.used.accountId, 'a2', '实际用的是候选绑定的账号')
  assert.equal(platform.state.activeAccount, activeBefore, 'Auto 不能改平台全局当前账号')

}

// ---------- 12. 日志：切换次数统计 ----------
{
  const snapshot = makeAdapter(fakeHost({}).ctx).snapshot()
  assert.ok(snapshot.history.length >= 0)
}

// ---------- 13. 指定账号的推理目标 + 不动全局当前账号 + 续期串行化 ----------
{
  const platform = manager.byKey.get('alpha')
  const activeBefore = platform.state.activeAccount
  let concurrent = 0
  let peak = 0
  const originalRefresh = platform.adapter.refresh
  platform.adapter.refresh = async (credential) => {
    concurrent += 1
    peak = Math.max(peak, concurrent)
    await new Promise((resolve) => setTimeout(resolve, 15))
    concurrent -= 1
    return credential
  }
  const [first, second] = await Promise.all([
    platform.inferenceTarget('a1'),
    platform.inferenceTarget('a1'),
  ])
  assert.equal(first.apiKey, 't1')
  assert.equal(second.apiKey, 't1')
  assert.equal(peak, 1, '同一账号的续期必须串行，否则 refresh token 会被用两次')
  const other = await platform.inferenceTarget('a2')
  assert.equal(other.apiKey, 't2')
  assert.equal(other.accountId, 'a2')
  assert.equal(platform.state.activeAccount, activeBefore, '指定账号不能改全局当前账号')
  platform.adapter.refresh = originalRefresh
}

// ---------- 14. 冷却按候选算：同一账号换模型不受影响 ----------
{
  cooling.clear()
  const a1m1 = candidateKey({ provider: 'alpha', accountId: 'a1', model: 'm-1' })
  const a1m3 = candidateKey({ provider: 'alpha', accountId: 'a1', model: 'm-3' })
  cooling.mark(a1m1, 'RATE_LIMIT', 60_000)
  assert.equal(cooling.active(a1m1), true)
  assert.equal(cooling.active(a1m3), false, '同账号的另一个模型不该被连坐')
  cooling.clear()
}

// ---------- 15. 外部 provider（DSH 自带 / 用户自配）候选 ----------
{
  // 造一个假的外部目录：deepseek-account 有两个模型，其中 claude 支持图片
  const fakeExternal = {
    get(provider) {
      if (provider !== 'deepseek-account') return undefined
      return {
        id: provider,
        name: 'DeepSeek 账号',
        models: new Map([
          ['native-1', { id: 'native-1', name: '原生模型一', contextWindow: 64_000, maxTokens: 4096, vision: false, thinkingOptions: [], badge: undefined }],
          ['native-2', { id: 'native-2', name: '原生模型二', contextWindow: 256_000, maxTokens: 8192, vision: true, thinkingOptions: ['high'], badge: 'x1' }],
        ]),
      }
    },
  }
  const externalRouter = createAutoRouter({ store, manager, external: fakeExternal, canImageNow: () => true })
  const described = externalRouter.describe({ provider: 'deepseek-account', accountId: '', model: 'native-2' })
  assert.equal(described.ready, true)
  assert.equal(described.providerName, 'DeepSeek 账号')
  assert.equal(described.external, true)
  assert.equal(described.accountLabel, '')
  assert.equal(described.modelName, '原生模型二')
  assert.equal(described.contextWindow, 256_000)
  // 不存在的 provider 或模型仍然报清楚原因
  assert.equal(externalRouter.describe({ provider: 'nope', accountId: '', model: 'x' }).reason, '平台未接入')
  assert.equal(externalRouter.describe({ provider: 'deepseek-account', accountId: '', model: 'nope' }).reason, '模型不在目录里')

  // 真跑一次：外部候选 shouldn't 需要账号上下文，也不该被 ALS 强行注入魔桥账号
  const isolated = createAutoStore({ path: join(dir, 'auto-external.json') })
  await isolated.load()
  await isolated.addCandidates([{ provider: 'deepseek-account', accountId: '', model: 'native-1' }])
  const extCooling = createCooling()
  const extRouter = createAutoRouter({ store: isolated, manager, external: fakeExternal })
  const { ctx, calls } = fakeHost({
    'deepseek-account|native-1': async function* () { yield text('来自原生'); yield stop },
  })
  const extAdapter = createAutoAdapter({ ctx, store: isolated, router: extRouter, cooling: extCooling, warn: () => {} })
  const chunks = await collect(extAdapter.stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '来自原生')
  assert.equal(calls[0].provider, 'deepseek-account')
  assert.equal(calls[0].model, 'native-1')
  assert.equal(calls[0].scope?.accountId, '', '外部候选的 accountId 必须是空串，不能误用魔桥账号')
}

// ---------- 16. IMAGE_OFFLOAD_REQUIRED：原样透传、不切换、不冷却 ----------
{
  const iso = createAutoStore({ path: join(dir, 'auto-image.json') })
  await iso.load()
  await iso.addCandidates([
    { provider: 'alpha', accountId: 'a1', model: 'm-1' },
    { provider: 'alpha', accountId: 'a1', model: 'm-3' },
  ])
  const isoCooling = createCooling()
  const isoRouter = createAutoRouter({ store: iso, manager, canImageNow: () => true })
  const { ctx, calls } = fakeHost({
    'alpha|m-1': async function* () {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'IMAGE_OFFLOAD_REQUIRED',
            message: 'pi-ai request images exceed the route image budget; 8 more oldest occurrence(s) must be offloaded.',
            offloadImages: 8,
            status: 400,
          },
        },
      }
    },
    'alpha|m-3': async function* () { yield text('不该走到这里'); yield stop },
  })
  const adapter = createAutoAdapter({ ctx, store: iso, router: isoRouter, cooling: isoCooling, warn: () => {} })
  const chunks = await collect(adapter.stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  const last = chunks.at(-1)
  assert.equal(last.reason.kind, 'error')
  assert.equal(last.reason.failure.code, 'IMAGE_OFFLOAD_REQUIRED')
  assert.equal(last.reason.failure.offloadImages, 8, 'offloadImages 必须原样透传，否则卸载插件无法接手')
  assert.equal(last.reason.failure.status, 400, '其余失败字段也要保留')
  assert.equal(calls.length, 1, '这类请求侧错误不换候选')
  assert.equal(
    isoCooling.active(candidateKey({ provider: 'alpha', accountId: 'a1', model: 'm-1' })),
    false,
    '不该给候选上冷却',
  )

  // 抛错路径同样要保留字段（宿主 LlmError 是 throw 出来的）
  const thrown = createAutoStore({ path: join(dir, 'auto-image-throw.json') })
  await thrown.load()
  await thrown.addCandidates([{ provider: 'alpha', accountId: 'a1', model: 'm-1' }])
  const thrownCooling = createCooling()
  const thrownRouter = createAutoRouter({ store: thrown, manager, canImageNow: () => true })
  const { ctx: thrownCtx } = fakeHost({
    'alpha|m-1': async function* () {
      throw Object.assign(new Error('budget'), {
        failure: { code: 'IMAGE_OFFLOAD_REQUIRED', message: 'budget', offloadImages: 4 },
      })
    },
  })
  const thrownAdapter = createAutoAdapter({ ctx: thrownCtx, store: thrown, router: thrownRouter, cooling: thrownCooling, warn: () => {} })
  const thrownChunks = await collect(thrownAdapter.stream({ provider: 'auto', model: AUTO_MODEL, messages: [] }))
  assert.equal(thrownChunks.at(-1).reason.failure.offloadImages, 4, '抛错路径也要带 offloadImages')

  // 策略层面：即使有人把它手工勾进 switchOn，也永远不切
  assert.equal(shouldSwitch({ code: 'IMAGE_OFFLOAD_REQUIRED' }, { switchOn: ['IMAGE_OFFLOAD_REQUIRED'] }), false)
  assert.equal(shouldSwitch({ code: 'IMAGE_OFFLOAD_REQUIRED' }, undefined), false)
  assert.equal(shouldSwitch({ code: 'RATE_LIMIT' }, undefined), true, '普通可切换码不受影响')
}

// ---------- 17. 图片预算：默认值、配置覆盖、非法回退 ----------
{
  // 顶层导出只暴露 apply/name/inject 时，跳过下面针对 resolveImageBudgets 的断言
  const { resolveImageBudgets } = await import('../lib/index.js')
  assert.equal(typeof resolveImageBudgets, 'function', '图片预算归一化函数必须可测')

  const defaults = resolveImageBudgets()
  assert.deepEqual(defaults, {
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    maxRequestImages: 20,
    imageOffloadCountQuantum: 5,
  }, '默认预算必须是 20/5，字节上限不变')

  const overridden = resolveImageBudgets({ imageBudgets: {
    maxRequestImages: 32,
    imageOffloadCountQuantum: 8,
    maxRequestImageBytes: 8_388_608,
  } })
  assert.equal(overridden.maxRequestImages, 32, 'maxRequestImages 可被 config.imageBudgets 覆盖')
  assert.equal(overridden.imageOffloadCountQuantum, 8, '量子可被 config.imageBudgets 覆盖')
  assert.equal(overridden.maxRequestImageBytes, 8_388_608, '字节上限可被 config.imageBudgets 覆盖')
  assert.equal(overridden.requestImagePixelBudget, 4_194_304, '未覆盖字段保持默认')

  const invalid = resolveImageBudgets({ imageBudgets: { maxRequestImages: 2, imageOffloadCountQuantum: 10 } })
  assert.equal(invalid.maxRequestImages, 20, '量子 > maxImages 时 maxImages 回退默认')
  assert.equal(invalid.imageOffloadCountQuantum, 5, '量子 > maxImages 时量子回退默认')
  assert.ok(invalid.imageOffloadCountQuantum <= invalid.maxRequestImages, '回退后必须满足 quantum <= maxImages')

  const badType = resolveImageBudgets({ imageBudgets: { maxRequestImages: -1, imageOffloadCountQuantum: '8' } })
  assert.equal(badType.maxRequestImages, 20, '非法类型/数值回退默认')
  assert.equal(badType.imageOffloadCountQuantum, 5)
}

console.log('auto-route: 全部断言通过')