/**
 * 魔桥 OpenAI 网关 · 协议层 + server 骨架自测（TK-0001）。
 *
 * 跑法：node test/openai-gateway.test.mjs
 *
 * 不依赖 DSH 宿主：协议层是纯函数，server 用假 `ctx`。
 * 覆盖：parseModel 四种、四种 role 转换、image_url 两种、tools、六类错误信封、
 * models 列表字段、healthz 503 分支、路由双挂、501 占位、鉴权钩子。
 */

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProtocolError,
  errorEnvelope,
  errorTypeForStatus,
  extractImageParts,
  finishReasonOf,
  modelObject,
  modelsList,
  applyAliases,
  parseImageUrl,
  parseModel,
  sanitizeErrorMessage,
  streamOptionsOf,
  toGenerateOptions,
} from '../lib/core/openai-protocol.js'
import { createGateway } from '../lib/core/openai-gateway.js'
import { createKeyStore } from '../lib/core/gateway-keys.js'
import { truncationMessage } from '../lib/core/openai-protocol.js'

// ------------------------------------------------------- TK-0003 测试夹具
//
// TK-0003 起网关默认要鉴权，旧测试（TK-0001/0002 时期鉴权是透传、不带 Key）
// 统一走下面这套夹具：临时目录 + 真实 Key 存储 + 一把合法 Key。
// **没有**把鉴权改回透传。

/** 所有共享夹具落在同一个临时目录，跑完不清理（/tmp 下的 mkdtemp 目录）。 */
const TEST_STATE_DIR = await mkdtemp(join(tmpdir(), 'mgw-test-'))

/** 默认 Key 存储（真实实现，落 TEST_STATE_DIR）。 */
const testKeys = createKeyStore({
  keysPath: join(TEST_STATE_DIR, 'gateway.json'),
  auditPath: join(TEST_STATE_DIR, 'gateway-audit.ndjson'),
})

/** setup 里 createKey 一次，全体旧测试复用。 */
const TEST_KEY = (await testKeys.createKey('测试用 Key')).key

/** 旧测试请求默认带的鉴权头。 */
function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TEST_KEY}`, ...extra }
}


let passed = 0
const failures = []

/** 逐条跑，一条挂了不挡住后面的。 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

/** 断言抛 ProtocolError 且字段符合预期。 */
function assertProtocolError(fn, expected) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ProtocolError, `期望 ProtocolError，实际：${String(caught)}`)
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(caught[key], value, `${key} 不符：期望 ${value}，实际 ${caught[key]}`)
  }
  return caught
}

/** 1x1 PNG（最短合法头 + 填充），够测 data URI 解析。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** 假附件服务：把 image part 压成一个固定 ref。 */
const fakeImageResolver = (part) => ({
  attachmentId: `att-${part.key}`,
  mediaType: part.parsed.mediaType,
  bytes: part.parsed.bytes,
  width: 1,
  height: 1,
})

/** 基础请求体。 */
function baseBody(overrides = {}) {
  return {
    model: 'mg-auto',
    messages: [{ role: 'user', content: '你好' }],
    ...overrides,
  }
}

// ---------------------------------------------------------------- parseModel

await test('parseModel: mg-auto', () => {
  assert.deepEqual(parseModel('mg-auto'), { provider: 'auto', actualModel: 'auto' })
})

await test('parseModel: mg-<provider>:<model>（model 里允许再带冒号）', () => {
  assert.deepEqual(parseModel('mg-workbuddy:claude-sonnet-4'), {
    provider: 'workbuddy',
    actualModel: 'claude-sonnet-4',
  })
  assert.deepEqual(parseModel('mg-scnet:org/model:v2'), {
    provider: 'scnet',
    actualModel: 'org/model:v2',
  })
})

await test('parseModel: 别名精确匹配（字符串 / 对象两种别名值）', () => {
  const aliases = {
    'gpt-4o': 'mg-workbuddy:claude-sonnet-4',
    'fast': { provider: 'scnet', model: 'SCNet-Max' },
  }
  assert.deepEqual(parseModel('gpt-4o', aliases), {
    provider: 'workbuddy',
    actualModel: 'claude-sonnet-4',
  })
  assert.deepEqual(parseModel('fast', aliases), { provider: 'scnet', actualModel: 'SCNet-Max' })
})

await test('parseModel: mg-auto:xxx 非法（auto 不是平台通道，只有 mg-auto 自身）', () => {
  // `mg-auto` 是完整 id，不接受再挂模型段
  assert.deepEqual(parseModel('mg-auto'), { provider: 'auto', actualModel: 'auto' })
  assertProtocolError(() => parseModel('mg-auto:auto'), { status: 400, code: 'model_not_found' })
  assertProtocolError(() => parseModel('mg-auto:gpt-4o'), { status: 400, code: 'model_not_found' })
})

await test('parseModel: 别名链式展开 + Map 别名表', () => {
  const aliases = new Map([
    ['a', 'b'],
    ['b', 'mg-auto'],
  ])
  assert.deepEqual(parseModel('a', aliases), { provider: 'auto', actualModel: 'auto' })
})

await test('parseModel: 其它一律 400 model_not_found（禁止模糊匹配/静默回退）', () => {
  assertProtocolError(() => parseModel('gpt-4o'), { status: 400, code: 'model_not_found' })
  // 大小写不同不算命中
  assertProtocolError(() => parseModel('MG:AUTO'), { status: 400, code: 'model_not_found' })
  // 前缀不完整
  assertProtocolError(() => parseModel('mg-workbuddy'), { status: 400, code: 'model_not_found' })
  assertProtocolError(() => parseModel('mg-:x'), { status: 400, code: 'model_not_found' })
  // 旧格式 mg: 已彻底废弃，必须拒绝（不保留兼容别名）
  assertProtocolError(() => parseModel('mg:auto'), { status: 400, code: 'model_not_found' })
  assertProtocolError(() => parseModel('mg:workbuddy:claude-sonnet-4'), { status: 400, code: 'model_not_found' })
  // 空值
  assertProtocolError(() => parseModel(''), { status: 400, code: 'model_not_found' })
  assertProtocolError(() => parseModel(undefined), { status: 400, code: 'model_not_found' })
  // 别名指向不存在的模型也不许回退
  assertProtocolError(() => parseModel('x', { x: 'nope' }), { status: 400, code: 'model_not_found' })
})

await test('parseModel: 别名成环报 400（不递归到栈溢出）', () => {
  assertProtocolError(() => parseModel('a', { a: 'b', b: 'a' }), { status: 400, code: 'model_not_found' })
})

await test('parseModel knownProviders: 未知 provider 400、已知通过、不传保持旧行为', () => {
  const known = ['auto', 'workbuddy', 'scnet']
  assert.deepEqual(parseModel('mg-workbuddy:claude-sonnet-4', {}, known), {
    provider: 'workbuddy',
    actualModel: 'claude-sonnet-4',
  })
  assert.deepEqual(parseModel('mg-auto', {}, new Set(known)), { provider: 'auto', actualModel: 'auto' })

  const unknown = assertProtocolError(
    () => parseModel('mg-nope:gpt-4o', {}, known),
    { status: 400, param: 'model', code: 'model_not_found' },
  )
  assert.ok(unknown.message.includes('nope'))
  assert.ok(!unknown.message.includes('workbuddy'), '错误文案不能列出内部平台清单')

  // 别名解析出来的 provider 也要过校验
  assertProtocolError(
    () => parseModel('fast', { fast: 'mg-nope:SCNet-Max' }, known),
    { status: 400, code: 'model_not_found' },
  )

  // 不传白名单 = 旧行为：格式合法就放行（纯函数可测性）
  assert.deepEqual(parseModel('mg-nope:gpt-4o'), { provider: 'nope', actualModel: 'gpt-4o' })
  assert.deepEqual(parseModel('mg-nope:gpt-4o', {}, undefined), { provider: 'nope', actualModel: 'gpt-4o' })
})

await test('applyAliases: 有别名就只报别名，同一模型不重复出现', () => {
  const entries = [
    'mg-auto',
    { id: 'mg-workbuddy:claude-sonnet-4', owned_by: 'workbuddy', context_length: 200000 },
    { id: 'mg-scnet:SCNet-Max', owned_by: 'scnet' },
  ]
  const out = applyAliases(entries, {
    'claude': 'mg-workbuddy:claude-sonnet-4',
  })
  // 原名必须消失，否则调用方会看到同一个模型两条
  assert.deepEqual(out.map((e) => (typeof e === 'string' ? e : e.id)), [
    'mg-auto', 'claude', 'mg-scnet:SCNet-Max',
  ])
  // 别名条目仍带能力字段（只是换了 id）
  assert.equal(out[1].context_length, 200000)
  assert.equal(out[1].owned_by, 'workbuddy')
})

await test('applyAliases: 一个模型只认第一个别名，多余的别名不额外产条目', () => {
  const out = applyAliases(
    [{ id: 'mg-scnet:SCNet-Max' }],
    { first: 'mg-scnet:SCNet-Max', second: 'mg-scnet:SCNet-Max' },
  )
  // 仍是一条，用第一个别名
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'first')
})

await test('applyAliases: mg-auto 也能起别名', () => {
  const out = applyAliases(['mg-auto'], { default: 'mg-auto' })
  assert.deepEqual(out, ['default'])
})

await test('applyAliases: 无别名的目录原样返回', () => {
  const entries = ['mg-auto', { id: 'mg-scnet:SCNet-Max' }]
  const out = applyAliases(entries, {})
  assert.deepEqual(out.map((e) => (typeof e === 'string' ? e : e.id)), ['mg-auto', 'mg-scnet:SCNet-Max'])
  assert.deepEqual(applyAliases(entries, undefined).length, 2)
})

await test('modelsList: 上下文窗口与能力字段（有值才输出，不编造）', () => {
  const list = modelsList([
    'mg-auto',
    {
      id: 'mg-workbuddy:claude-sonnet-4',
      owned_by: 'workbuddy',
      context_length: 200000,
      max_output_tokens: 8192,
      supports_vision: true,
      supports_tools: true,
      supports_reasoning: false,
    },
    { id: 'mg-scnet:SCNet-Max', context_length: 0, supports_vision: 'yes' },
  ])
  assert.deepEqual(Object.keys(list.data[0]).sort(), ['created', 'id', 'object', 'owned_by'])
  const rich = list.data[1]
  assert.equal(rich.context_length, 200000)
  assert.equal(rich.max_output_tokens, 8192)
  assert.equal(rich.supports_vision, true)
  assert.equal(rich.supports_tools, true)
  assert.equal(rich.supports_reasoning, false)
  // 非法值（0 / 非 boolean）必须丢掉，不能把 'yes' 塞给调用方
  assert.deepEqual(Object.keys(list.data[2]).sort(), ['created', 'id', 'object', 'owned_by'])
})

// -------------------------------------------------------- messages 各 role

await test('messages: system/user 字符串 content', () => {
  const options = toGenerateOptions({
    model: 'mg-auto',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ],
  }, { provider: 'auto', actualModel: 'auto' })

  assert.equal(options.provider, 'auto')
  assert.equal(options.model, 'auto')
  assert.deepEqual(options.messages[0], {
    id: 'mgw-msg-0',
    role: 'system',
    content: [{ type: 'text', text: '你是助手' }],
    source: { kind: 'system-prompt' },
  })
  assert.deepEqual(options.messages[1], {
    id: 'mgw-msg-1',
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
    source: { kind: 'user' },
  })
})

await test('messages: developer 归一到 system', () => {
  const options = toGenerateOptions(baseBody({
    messages: [{ role: 'developer', content: '规则' }],
  }), { provider: 'auto', actualModel: 'auto' })
  assert.equal(options.messages[0].role, 'system')
})

await test('messages: assistant 带 tool_calls → tool-call block', () => {
  const options = toGenerateOptions(baseBody({
    messages: [
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: '我查一下',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"济南"}' },
        }],
      },
    ],
  }), { provider: 'workbuddy', actualModel: 'claude-sonnet-4' })

  const assistant = options.messages[1]
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.source, {
    kind: 'model',
    provider: 'workbuddy',
    model: 'claude-sonnet-4',
  })
  assert.deepEqual(assistant.content, [
    { type: 'text', text: '我查一下' },
    { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"济南"}' },
  ])
})

await test('messages: tool 配 tool_call_id；缺 id 报 400', () => {
  const options = toGenerateOptions(baseBody({
    messages: [{ role: 'tool', tool_call_id: 'call_1', content: '晴' }],
  }), { provider: 'auto', actualModel: 'auto' })

  assert.deepEqual(options.messages[0], {
    id: 'mgw-msg-0',
    role: 'tool',
    toolCallId: 'call_1',
    content: [{ type: 'text', text: '晴' }],
    source: { kind: 'tool', callId: 'call_1' },
    isError: undefined,
  })

  assertProtocolError(
    () => toGenerateOptions(baseBody({
      messages: [{ role: 'tool', content: '晴' }],
    }), { provider: 'auto', actualModel: 'auto' }),
    { status: 400, code: 'missing_tool_call_id' },
  )
})

await test('messages: 空 messages / 非法 role / 非法 content 都 400', () => {
  const parsed = { provider: 'auto', actualModel: 'auto' }
  assertProtocolError(() => toGenerateOptions({ model: 'mg-auto', messages: [] }, parsed),
    { status: 400, code: 'messages_required' })
  assertProtocolError(() => toGenerateOptions({ model: 'mg-auto' }, parsed),
    { status: 400, code: 'messages_required' })
  assertProtocolError(
    () => toGenerateOptions(baseBody({ messages: [{ role: 'function', content: 'x' }] }), parsed),
    { status: 400, code: 'invalid_role' },
  )
  assertProtocolError(
    () => toGenerateOptions(baseBody({ messages: [{ role: 'user', content: 42 }] }), parsed),
    { status: 400, code: 'invalid_content' },
  )
})

// ------------------------------------------------------------- image_url

await test('image_url: data: URI 转 image block（text + image 共存）', () => {
  const options = toGenerateOptions(baseBody({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ],
    }],
  }), { provider: 'auto', actualModel: 'auto' }, { imageResolver: fakeImageResolver })

  assert.equal(options.messages[0].content.length, 2)
  assert.deepEqual(options.messages[0].content[0], { type: 'text', text: '这是什么' })
  const image = options.messages[0].content[1]
  assert.equal(image.type, 'image')
  assert.equal(image.attachment.attachmentId, 'att-0:1')
  assert.equal(image.attachment.mediaType, 'image/png')
  assert.ok(image.attachment.bytes > 0)
})

await test('image_url: http(s) URL 也转 image block', () => {
  const options = toGenerateOptions(baseBody({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }],
    }],
  }), { provider: 'auto', actualModel: 'auto' }, { imageResolver: fakeImageResolver })
  assert.equal(options.messages[0].content[0].type, 'image')
})

await test('image_url: 无附件服务时显式 400，不静默吞图', () => {
  const body = baseBody({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } }],
    }],
  })
  assertProtocolError(
    () => toGenerateOptions(body, { provider: 'auto', actualModel: 'auto' }),
    { status: 400, code: 'image_not_supported' },
  )
})

await test('parseImageUrl: 非法 data URI / 非 http 协议 都 400', () => {
  assertProtocolError(() => parseImageUrl('data:text/plain;base64,AAAA'), { status: 400 })
  assertProtocolError(() => parseImageUrl('data:image/png,rawbytes'), { status: 400 })
  assertProtocolError(() => parseImageUrl('file:///tmp/a.png'), { status: 400 })
  assertProtocolError(() => parseImageUrl(''), { status: 400 })
})

await test('extractImageParts: 先把图片 part 挑出来，供网关异步落盘', () => {
  const parts = extractImageParts(baseBody({
    messages: [
      { role: 'user', content: '纯文本没有图' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
          { type: 'text', text: 'x' },
        ],
      },
    ],
  }))
  assert.equal(parts.length, 1)
  assert.equal(parts[0].key, '1:0')
  assert.equal(parts[0].parsed.kind, 'data')
  assert.equal(parts[0].parsed.mediaType, 'image/png')
})

// --------------------------------------------------------------- tools

await test('tools: {type:function,function:{...}} → ToolSchema', () => {
  const options = toGenerateOptions(baseBody({
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
    tool_choice: 'auto',
  }), { provider: 'auto', actualModel: 'auto' })

  assert.deepEqual(options.tools, [{
    name: 'get_weather',
    description: '查天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }])
  // ToolSchema 只允许 name/description/parameters/deferLoading，不能带 strict
  assert.deepEqual(Object.keys(options.tools[0]).sort(), ['description', 'name', 'parameters'])
  assert.equal(options.mgw.toolChoice, 'auto')
})

await test('tools: tool_choice=none 时不下发 tools；指定函数记录 name', () => {
  const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }]
  const none = toGenerateOptions(baseBody({ tools, tool_choice: 'none' }), { provider: 'auto', actualModel: 'auto' })
  assert.equal(none.tools, undefined)
  assert.equal(none.mgw.toolChoice, 'none')

  const picked = toGenerateOptions(baseBody({
    tools,
    tool_choice: { type: 'function', function: { name: 'f' } },
  }), { provider: 'auto', actualModel: 'auto' })
  assert.deepEqual(picked.mgw.toolChoice, { name: 'f' })
  assert.equal(picked.tools.length, 1)
})

await test('tools: 非法结构 400（缺 name / parameters 非对象 / 非 function 类型）', () => {
  const parsed = { provider: 'auto', actualModel: 'auto' }
  assertProtocolError(
    () => toGenerateOptions(baseBody({ tools: [{ type: 'function', function: {} }] }), parsed),
    { status: 400, code: 'invalid_tools' },
  )
  assertProtocolError(
    () => toGenerateOptions(baseBody({ tools: [{ type: 'function', function: { name: 'f', parameters: [] } }] }), parsed),
    { status: 400, code: 'invalid_tools' },
  )
  assertProtocolError(
    () => toGenerateOptions(baseBody({ tools: [{ type: 'web_search', function: { name: 'f' } }] }), parsed),
    { status: 400, code: 'unsupported_tool_type' },
  )
})

// -------------------------------------------------- 参数映射 + mgw 私有字段

await test('参数: temperature / max_tokens / max_completion_tokens / stop', () => {
  const parsed = { provider: 'auto', actualModel: 'auto' }
  const plain = toGenerateOptions(baseBody({
    temperature: 0.3,
    max_tokens: 512,
    stop: 'END',
  }), parsed)
  assert.equal(plain.temperature, 0.3)
  assert.equal(plain.maxTokens, 512)
  assert.deepEqual(plain.stop, ['END'])

  const modern = toGenerateOptions(baseBody({ max_completion_tokens: 256, stop: ['a', 'b'] }), parsed)
  assert.equal(modern.maxTokens, 256)
  assert.deepEqual(modern.stop, ['a', 'b'])

  // max_tokens 优先于 max_completion_tokens
  const both = toGenerateOptions(baseBody({ max_tokens: 100, max_completion_tokens: 999 }), parsed)
  assert.equal(both.maxTokens, 100)

  assertProtocolError(() => toGenerateOptions(baseBody({ max_tokens: 0 }), parsed),
    { status: 400, code: 'invalid_max_tokens' })
  assertProtocolError(() => toGenerateOptions(baseBody({ temperature: 'hot' }), parsed),
    { status: 400, code: 'invalid_temperature' })
  assertProtocolError(() => toGenerateOptions(baseBody({ stop: [1] }), parsed),
    { status: 400, code: 'invalid_stop' })
})

await test('mgw: stream/include_usage 记录，streamOptionsOf 剥掉私有字段', () => {
  const options = toGenerateOptions(baseBody({
    stream: true,
    stream_options: { include_usage: true },
  }), { provider: 'auto', actualModel: 'auto' })

  assert.equal(options.mgw.stream, true)
  assert.equal(options.mgw.includeUsage, true)
  assert.equal(options.mgw.requestedModel, 'mg-auto')

  const clean = streamOptionsOf(options)
  assert.equal(clean.mgw, undefined)
  assert.deepEqual(Object.keys(clean).sort(), ['messages', 'model', 'provider'])
})

// ------------------------------------------------------------- 错误信封

await test('errorEnvelope: 六类状态码的 type 映射', () => {
  const cases = [
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [429, 'rate_limit_error'],
    [500, 'server_error'],
  ]
  for (const [status, type] of cases) {
    const envelope = errorEnvelope(status, undefined, null, null, '出错了')
    assert.deepEqual(Object.keys(envelope), ['error'])
    assert.deepEqual(Object.keys(envelope.error), ['message', 'type', 'param', 'code'])
    assert.equal(envelope.error.type, type, `status ${status}`)
    assert.equal(envelope.error.param, null)
    assert.equal(envelope.error.code, null)
    assert.equal(envelope.error.message, '出错了')
  }
  assert.equal(errorTypeForStatus(502), 'api_error')
  assert.equal(errorTypeForStatus(503), 'server_error')
})

await test('errorEnvelope: model_not_found 形状与规格 §1.3 一致', () => {
  const envelope = errorEnvelope(400, 'invalid_request_error', 'model', 'model_not_found', '未知模型')
  assert.deepEqual(envelope, {
    error: {
      message: '未知模型',
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  })
})

await test('脱敏: 不回显 Key / Bearer / 堆栈 / 控制字符', () => {
  const dirty = [
    'Authorization: Bearer mgw_live_abcdef1234567890',
    'api_key=sk-proj-abcdefghijklmnop',
    'upstream said 401 for token: abcdefghijk',
    'at Object.<anonymous> (/Users/jack/secret.js:1:1)',
    'Error:',
  ].join('\n')
  const message = sanitizeErrorMessage(dirty)
  assert.ok(!message.includes('mgw_live_abcdef'), message)
  assert.ok(!message.includes('sk-proj-abcdefghijklmnop'), message)
  assert.ok(!message.includes('abcdefghijk'), message)
  assert.ok(!message.includes('secret.js'), message)
  assert.ok(!message.includes('at Object'), message)
  // 保留下来的诊断信息
  assert.ok(message.includes('Authorization'), message)
  assert.ok(message.includes('upstream said 401'), message)
})

await test('脱敏: 超长 message 截断，错误信封不带堆栈字段', () => {
  const long = 'x'.repeat(1000)
  const envelope = errorEnvelope(500, 'server_error', null, 'internal_error', long)
  assert.ok(envelope.error.message.length <= 300)
  assert.equal(envelope.error.message.endsWith('…'), true)
  assert.deepEqual(Object.keys(envelope.error), ['message', 'type', 'param', 'code'])
})

await test('ProtocolError.toEnvelope 与 errorEnvelope 一致', () => {
  const error = assertProtocolError(() => parseModel('nope'), { status: 400 })
  assert.deepEqual(error.toEnvelope(), {
    error: {
      message: '未知模型：nope',
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  })
})

// ------------------------------------------------------------- models 列表

await test('modelsList: object:list + 每项 object:model/created/owned_by 齐全', () => {
  const list = modelsList(
    [
      'mg-auto',
      { id: 'mg-workbuddy:claude-sonnet-4', owned_by: 'workbuddy', created: 1700000000 },
    ],
    { created: 1699999999 },
  )
  assert.equal(list.object, 'list')
  assert.equal(list.data.length, 2)
  for (const item of list.data) {
    assert.deepEqual(Object.keys(item).sort(), ['created', 'id', 'object', 'owned_by'])
    assert.equal(item.object, 'model')
    assert.equal(typeof item.created, 'number')
    assert.equal(typeof item.owned_by, 'string')
  }
  assert.deepEqual(list.data[0], {
    id: 'mg-auto',
    object: 'model',
    created: 1699999999,
    owned_by: 'model-gateway',
  })
  assert.equal(list.data[1].owned_by, 'workbuddy')
  assert.equal(list.data[1].created, 1700000000)
  // 非标准扩展字段一个都不加
  assert.equal(list.data[0].context_window, undefined)
  assert.equal(list.data[0].capabilities, undefined)
})

await test('modelsList / modelObject: 空 id 跳过，非法入参抛 TypeError', () => {
  assert.deepEqual(modelsList([{ id: '' }, 'mg-auto']).data.map((item) => item.id), ['mg-auto'])
  assert.throws(() => modelsList('nope'), TypeError)
  assert.equal(modelObject({ id: 'mg-auto' }).id, 'mg-auto')
  assert.throws(() => modelObject({}), TypeError)
})

// ------------------------------------------------- finishReason 映射

await test('finishReasonOf: 五种 DSH kind + 未知兜底', () => {
  assert.equal(finishReasonOf({ kind: 'stop' }), 'stop')
  assert.equal(finishReasonOf({ kind: 'tool-calls' }), 'tool_calls')
  assert.equal(finishReasonOf({ kind: 'max-tokens' }), 'length')
  assert.equal(finishReasonOf({ kind: 'aborted', failure: {} }), null)
  assert.equal(finishReasonOf({ kind: 'error', failure: {} }), null)
  assert.equal(finishReasonOf({ kind: 'something-new' }), 'stop')
  assert.equal(finishReasonOf(undefined), 'stop')
  assert.equal(finishReasonOf('tool-calls'), 'tool_calls')
})

// ------------------------------------------------------------ server 骨架

/** 发一次 HTTP 请求，回 { status, headers, json, text }。默认带合法 Key（TK-0003 起必须鉴权）。 */
function call(url, { method = 'GET', body, headers = {}, noAuth = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json', 'content-length': payload.length }),
        ...(noAuth ? {} : authHeaders()),
        ...headers,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json })
      })
    })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

/** 起一个网关，用完关掉。缺省把 Key/审计落到临时目录，绝不碰 ~/.dsh。 */
async function withGateway(options, fn) {
  const gateway = createGateway({
    keysPath: join(TEST_STATE_DIR, 'gateway.json'),
    auditPath: join(TEST_STATE_DIR, 'gateway-audit.ndjson'),
    ...options,
  })
  const address = await gateway.start()
  try {
    await fn(gateway, address)
  } finally {
    await gateway.stop()
  }
}

await test('server: healthz — ctx.llm 缺失 503，可用 200', async () => {
  await withGateway({ ctx: {}, config: {} }, async (_gateway, address) => {
    for (const path of ['/healthz', '/v1/healthz', '/healthz/']) {
      const res = await call(`${address.url}${path}`)
      assert.equal(res.status, 503, path)
      assert.deepEqual(res.json, { status: 'unavailable' })
    }
  })

  await withGateway({ ctx: { llm: { stream: async function* () {} } }, config: {} }, async (_gateway, address) => {
    const res = await call(`${address.url}/healthz`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { status: 'ok' })
  })
})

await test('server: /v1/models 与 /models 双挂，字段合规', async () => {
  await withGateway({
    ctx: { llm: {} },
    config: { models: ['mg-auto', { id: 'mg-workbuddy:claude-sonnet-4', owned_by: 'workbuddy' }] },
  }, async (_gateway, address) => {
    for (const path of ['/v1/models', '/models', '/v1/models/']) {
      const res = await call(`${address.url}${path}`)
      assert.equal(res.status, 200, path)
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
      assert.equal(res.json.object, 'list')
      assert.equal(res.json.data.length, 2)
      assert.deepEqual(Object.keys(res.json.data[0]).sort(), ['created', 'id', 'object', 'owned_by'])
    }
  })
})

await test('server: GET /v1/models/:model — 命中 200，未命中 404', async () => {
  await withGateway({
    ctx: { llm: {} },
    config: { models: ['mg-auto'] },
  }, async (_gateway, address) => {
    const hit = await call(`${address.url}/v1/models/mg-auto`)
    assert.equal(hit.status, 200)
    assert.equal(hit.json.id, 'mg-auto')
    assert.equal(hit.json.object, 'model')

    const encoded = await call(`${address.url}/v1/models/${encodeURIComponent('mg-auto')}`)
    assert.equal(encoded.status, 200)

    const miss = await call(`${address.url}/v1/models/nope`)
    assert.equal(miss.status, 404)
    assert.equal(miss.json.error.type, 'not_found_error')
    assert.equal(miss.json.error.code, 'model_not_found')
  })
})

await test('server: GET /v1/models/:model 支持带斜杠的模型 id，非法转义 400', async () => {
  await withGateway({
    ctx: { llm: {} },
    config: { models: ['mg-scnet:org/model:v2'] },
  }, async (_gateway, address) => {
    const hit = await call(`${address.url}/v1/models/mg-scnet:org/model:v2`)
    assert.equal(hit.status, 200)
    assert.equal(hit.json.id, 'mg-scnet:org/model:v2')

    const badEscape = await call(`${address.url}/v1/models/%E0%A4%A`)
    assert.equal(badEscape.status, 400)
    assert.equal(badEscape.json.error.code, 'invalid_model_path')
  })
})

await test('server: 默认 modelsProvider 只给 mg-auto', async () => {
  await withGateway({ ctx: { llm: {} }, config: {} }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/models`)
    assert.deepEqual(res.json.data.map((item) => item.id), ['mg-auto'])
  })
})

await test('server: chat/completions 无 stream 能力 → 503 错误信封（TK-0002）', async () => {
  await withGateway({ ctx: { llm: {} }, config: {} }, async (_gateway, address) => {
    for (const path of ['/v1/chat/completions', '/chat/completions']) {
      const res = await call(`${address.url}${path}`, {
        method: 'POST',
        body: baseBody(),
      })
      assert.equal(res.status, 503, path)
      assert.equal(res.json.error.type, 'server_error')
      assert.equal(res.json.error.code, 'llm_unavailable')
      assert.ok(!res.text.includes('mg-auto'), '错误体不该回显请求正文')
    }
  })
})

await test('server: chat/completions 模型非法 → 400 model_not_found', async () => {
  await withGateway({ ctx: { llm: {} }, config: {} }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'gpt-4o' }),
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.error.param, 'model')
    assert.equal(res.json.error.code, 'model_not_found')
  })
})

await test('server: 未接入的 provider 400（从 modelsProvider 推导白名单）', async () => {
  await withGateway({
    ctx: { llm: {} },
    config: { aliases: { fast: 'mg-scnet:SCNet-Max' } },
    modelsProvider: () => ['mg-auto', { id: 'mg-workbuddy:claude-sonnet-4' }],
  }, async (_gateway, address) => {
    // workbuddy 在目录里、scnet 在别名目标里，两个都算已接入
    for (const model of ['mg-workbuddy:claude-sonnet-4', 'fast']) {
      const res = await call(`${address.url}/v1/chat/completions`, {
        method: 'POST',
        body: baseBody({ model }),
      })
      assert.equal(res.status, 503, `${model} 应通过 parseModel`)
      assert.equal(res.headers['x-mgw-provider'], decodeURIComponent(model === 'fast' ? 'scnet' : 'workbuddy'))
    }

    const unknown = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'mg-nope:gpt-4o' }),
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error.param, 'model')
    assert.equal(unknown.json.error.code, 'model_not_found')
    assert.ok(unknown.json.error.message.includes('nope'))
  })
})

await test('server: 显式 providers 钩子优先（函数形式，运行期可变）', async () => {
  let allow = ['auto', 'workbuddy']
  await withGateway({
    ctx: { llm: {} },
    config: { models: ['mg-auto'] },
    providers: () => allow,
  }, async (gateway, address) => {
    assert.deepEqual([...gateway.protocol.knownProviders()].sort(), ['auto', 'workbuddy'])

    const before = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'mg-scnet:SCNet-Max' }),
    })
    assert.equal(before.status, 400)

    allow = ['auto', 'workbuddy', 'scnet']
    const after = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'mg-scnet:SCNet-Max' }),
    })
    assert.equal(after.status, 503)
    assert.equal(after.headers['x-mgw-provider'], 'scnet')
  })
})

await test('server: models 列表 created 是网关启动时间戳（非 0）', async () => {
  const before = Math.floor(Date.now() / 1000)
  await withGateway({ ctx: { llm: {} }, config: { models: ['mg-auto'] } }, async (_gateway, address) => {
    const after = Math.floor(Date.now() / 1000)
    const res = await call(`${address.url}/v1/models`)
    const created = res.json.data[0].created
    assert.equal(typeof created, 'number')
    assert.ok(created >= before && created <= after, `created=${created} 不在 [${before}, ${after}]`)
    assert.ok(created !== 0)

    // 单个模型详情也要带同一个时间戳
    const one = await call(`${address.url}/v1/models/mg-auto`)
    assert.equal(one.json.created, created)
  })
})

await test('server: 非法 JSON / 空 messages 都是 400 信封', async () => {
  await withGateway({ ctx: { llm: {} }, config: {} }, async (_gateway, address) => {
    const bad = await new Promise((resolve, reject) => {
      const target = new URL(`${address.url}/v1/chat/completions`)
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode,
          json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }))
      })
      request.on('error', reject)
      request.end('{"model": ')
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'invalid_json')
    assert.ok(!bad.json.error.message.includes('{"model"'), 'JSON 解析错误不该回显正文')

    const emptyMessages = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: { model: 'mg-auto', messages: [] },
    })
    assert.equal(emptyMessages.status, 400)
    assert.equal(emptyMessages.json.error.code, 'messages_required')
  })
})

await test('server: chatHandler 注入点收到解析好的 GenerateOptions', async () => {
  const seen = []
  await withGateway({
    ctx: { llm: {} },
    config: { aliases: { fast: 'mg-scnet:SCNet-Max' } },
    chatHandler: async (hook) => {
      seen.push(hook)
      hook.response.writeHead(200, { 'content-type': 'application/json' })
      hook.response.end(JSON.stringify({ ok: true }))
    },
  }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'fast', stream: true }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true })
  })

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].parsed, { provider: 'scnet', actualModel: 'SCNet-Max' })
  assert.equal(seen[0].llmOptions.provider, 'scnet')
  assert.equal(seen[0].llmOptions.model, 'SCNet-Max')
  assert.equal(seen[0].llmOptions.mgw, undefined)
  assert.equal(seen[0].protocol.mgw.stream, true)
})

await test('server: 鉴权钩子 — 抛 ProtocolError 即拒绝，不泄漏原因', async () => {
  await withGateway({
    ctx: { llm: {} },
    config: {},
    authenticate: async (request) => {
      const authorization = request.headers.authorization ?? ''
      if (authorization !== 'Bearer good') {
        throw new ProtocolError(401, 'authentication_error', null, 'invalid_api_key', '缺少或无效的 API Key')
      }
    },
  }, async (_gateway, address) => {
    const denied = await call(`${address.url}/v1/models`, { headers: { authorization: 'Bearer bad' } })
    assert.equal(denied.status, 401)
    assert.equal(denied.json.error.type, 'authentication_error')
    assert.equal(denied.json.error.code, 'invalid_api_key')
    assert.ok(!denied.text.includes('Bad'), '不该回显客户端给的值')

    const allowed = await call(`${address.url}/v1/models`, { headers: { authorization: 'Bearer good' } })
    assert.equal(allowed.status, 200)
  })
})

await test('server: healthz 不走鉴权（探针不带 Key），models 必须过鉴权', async () => {
  let authCalls = 0
  await withGateway({
    ctx: { llm: {} },
    config: {},
    authenticate: async () => {
      authCalls += 1
      throw new ProtocolError(401, 'authentication_error', null, 'invalid_api_key', '缺少或无效的 API Key')
    },
  }, async (_gateway, address) => {
    const health = await call(`${address.url}/healthz`)
    assert.equal(health.status, 200)
    assert.equal(authCalls, 0)

    const models = await call(`${address.url}/v1/models`)
    assert.equal(models.status, 401)
    assert.equal(authCalls, 1)
  })
})

await test('server: 鉴权钩子抛非 ProtocolError → 500 且不回显堆栈', async () => {
  await withGateway({
    ctx: { llm: {} },
    config: {},
    authenticate: async () => {
      throw new Error('boom at /Users/jack/secret-key.json:12')
    },
  }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/models`)
    assert.equal(res.status, 500)
    assert.equal(res.json.error.code, 'internal_error')
    assert.deepEqual(res.json.error.message, '网关内部错误')
    assert.ok(!res.text.includes('secret-key'), res.text)
  })
})

await test('server: 未知路径 404 / 方法不对 405 / Host 头非回环 403', async () => {
  await withGateway({ ctx: { llm: {} }, config: {} }, async (_gateway, address) => {
    const unknown = await call(`${address.url}/v1/embeddings`, { method: 'POST', body: {} })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error.type, 'not_found_error')

    const wrongMethod = await call(`${address.url}/v1/chat/completions`)
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.json.error.code, 'method_not_allowed')

    const badHost = await call(`${address.url}/healthz`, { headers: { host: 'evil.example.com' } })
    assert.equal(badHost.status, 403)
    assert.equal(badHost.json.error.code, 'forbidden_host')
  })
})

await test('server: address/stop/start 幂等', async () => {
  const gateway = createGateway({
    ctx: { llm: {} },
    config: {},
    keysPath: join(TEST_STATE_DIR, 'gateway.json'),
    auditPath: join(TEST_STATE_DIR, 'gateway-audit.ndjson'),
  })
  assert.equal(gateway.address(), undefined)
  const first = await gateway.start()
  const second = await gateway.start()
  assert.equal(first.port, second.port)
  assert.ok(first.port > 0)
  assert.equal(gateway.address().url, first.url)
  await gateway.stop()
  assert.equal(gateway.address(), undefined)
  await gateway.stop() // 再停一次不炸
})


// ------------------------------------------------------ TK-0002 chat 流式/非流式

/** 通用脚本流：按 chunk 序列回放；可 observe 每次 next/return。 */
function scriptedStream(chunks, observe = {}) {
  return function stream() {
    let index = 0
    let done = false
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        observe.next?.(index)
        if (index >= chunks.length) {
          done = true
          return Promise.resolve({ value: undefined, done: true })
        }
        return Promise.resolve({ value: chunks[index++], done: false })
      },
      return() {
        observe.return?.()
        done = true
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

/** 会抛错的流：第 n 次 next 抛异常。 */
function throwingStream(chunks, throwAt, observe = {}) {
  return function stream() {
    let index = 0
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (index === throwAt) return Promise.reject(new Error('boom secret /Users/jack/key'))
        if (index >= chunks.length) return Promise.resolve({ value: undefined, done: true })
        return Promise.resolve({ value: chunks[index++], done: false })
      },
      return() { observe.return?.(); return Promise.resolve({ value: undefined, done: true }) },
    }
  }
}

const usageChunk = {
  type: 'usage',
  usage: { inputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 4 },
}

await test('TK-0002 非流式：chunk 聚合 + usage + finish_reason + reasoning 独立字段', async () => {
  const chunks = [
    { type: 'text-delta', index: 0, text: '你' },
    { type: 'text-delta', index: 0, text: '好' },
    { type: 'reasoning-delta', index: 1, text: '先想一下' },
    { type: 'reasoning-delta', index: 1, text: '再回答' },
    usageChunk,
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  let seen
  await withGateway({
    ctx: { llm: { stream: scriptedStream(chunks, { next: (i) => { seen = i } }) } },
    config: {},
  }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ stream: false }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.object, 'chat.completion')
    assert.match(res.json.id, /^chatcmpl-/)
    assert.equal(res.json.model, 'mg-auto')
    assert.equal(res.json.choices.length, 1)
    assert.equal(res.json.choices[0].index, 0)
    assert.equal(res.json.choices[0].message.role, 'assistant')
    assert.equal(res.json.choices[0].message.content, '你好')
    assert.equal(res.json.choices[0].message.reasoning_content, '先想一下再回答')
    assert.equal(res.json.choices[0].message.tool_calls, undefined)
    assert.equal(res.json.choices[0].finish_reason, 'stop')
    assert.deepEqual(res.json.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })
  })
  assert.equal(seen, chunks.length, '全部 chunk 被消费')
})

await test('TK-0002 非流式：工具调用 arguments 拼成合法 JSON，finish_reason=tool_calls', async () => {
  const chunks = [
    { type: 'text-delta', index: 0, text: '' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'get_weather', argumentsDelta: '{"city":' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', argumentsDelta: '"北京"}' },
    { type: 'tool-call-delta', index: 2, id: 'call_2', name: 'get_time', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  await withGateway({
    ctx: { llm: { stream: scriptedStream(chunks) } },
    config: {},
  }, async (_gateway, address) => {
    const res = await call(`${address.url}/chat/completions`, { method: 'POST', body: baseBody() })
    assert.equal(res.status, 200)
    const choice = res.json.choices[0]
    assert.equal(choice.finish_reason, 'tool_calls')
    assert.equal(choice.message.tool_calls.length, 2)
    assert.deepEqual(choice.message.tool_calls.map((tool) => tool.index), [0, 1])
    assert.equal(choice.message.tool_calls[0].id, 'call_1')
    assert.equal(choice.message.tool_calls[0].type, 'function')
    assert.equal(choice.message.tool_calls[0].function.name, 'get_weather')
    assert.deepEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { city: '北京' })
    assert.deepEqual(JSON.parse(choice.message.tool_calls[1].function.arguments), {})
    assert.equal(choice.message.reasoning_content, undefined)
  })
})

await test('TK-0002 非流式：max-tokens→length / aborted 不发结束 / error→502', async () => {
  for (const [reason, expected] of [[{ kind: 'max-tokens' }, 'length'], [{ kind: 'aborted', failure: {} }, 'stop']]) {
    await withGateway({
      ctx: { llm: { stream: scriptedStream([
        { type: 'text-delta', index: 0, text: 'abc' },
        { type: 'tool-call-delta', index: 1, id: 'c', name: 'f', argumentsDelta: '{}' },
        { type: 'finish', reason },
      ]) } },
      config: {},
    }, async (_gateway, address) => {
      const res = await call(`${address.url}/v1/chat/completions`, { method: 'POST', body: baseBody() })
      assert.equal(res.status, 200)
      assert.equal(res.json.choices[0].finish_reason, expected)
      if (reason.kind === 'max-tokens') {
        assert.equal(res.json.choices[0].message.tool_calls, undefined, 'max-tokens 丢掉不可靠工具调用')
      } else {
        assert.equal(res.json.choices[0].message.tool_calls.length, 1)
      }
    })
  }
  await withGateway({
    ctx: { llm: { stream: scriptedStream([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'quota exceeded' } } },
    ]) } },
    config: {},
  }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/chat/completions`, { method: 'POST', body: baseBody() })
    assert.equal(res.status, 502)
    assert.equal(res.json.error.code, 'rate_limit')
  })
})

/** 用 fetch 收完整 SSE 文本（含 [DONE] 行）。 */
async function fetchSse(url, body, init = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    signal: init.signal,
  })
  const text = await res.text()
  return { res, text }
}

/** SSE 文本 → 各帧 payload 与末行断言。 */
function parseSse(text) {
  const blocks = text.split('\n\n')
  const last = blocks.pop()
  assert.equal(text.endsWith('data: [DONE]\n\n'), true, '末行必须是严格 data: [DONE]')
  assert.equal(last, '', '最后一帧后只剩空串')
  return blocks
    .filter((block) => block !== 'data: [DONE]')
    // SSE 注释帧（心跳 `: ping`）按规范不是数据，解析时整体跳过
    .filter((block) => !block.startsWith(':'))
    .map((block) => {
      assert.ok(block.startsWith('data: '), `非法 SSE 帧：${block}`)
      return JSON.parse(block.slice(6))
    })
}

await test('流式收尾：上游没发 finish → 补 error 信封，绝不伪装成 finish_reason=stop', async () => {
  // 真实事故：推理模型思考+正文都流完了，上游直接关连接没给 finish。
  // 早期实现（4a0c58c）在这里补 finish_reason:'stop'，等于把半截回答伪装成
  // 完整回答：客户端不报错、不重试，用户拿到静默截断的答案。现在必须发
  // error 信封（宿主据此判 TRANSPORT，llm-retry 才能重试），且不得有 finish 帧。
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: '想好了' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想好了' } },
    { type: 'text-delta', index: 1, text: '答案' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '答案' } },
    // 注意：没有 finish chunk
  ]
  const warns = []
  await withGateway({
    ctx: { llm: { stream: scriptedStream(chunks) } },
    config: {},
    warn: (message) => warns.push(message),
  }, async (_gateway, address) => {
    const { res, text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
    assert.equal(res.status, 200, '已发 200 后不能改状态码')
    const frames = parseSse(text)
    assert.equal(
      frames.filter((f) => f.choices?.[0]?.finish_reason != null).length,
      0,
      '截断时不能出现 finish_reason 帧',
    )
    const errorFrame = frames.find((f) => f.error !== undefined)
    assert.ok(errorFrame, '截断必须补 error 信封')
    assert.equal(errorFrame.error.code, 'upstream_stream_truncated')
    assert.ok(text.trimEnd().endsWith('data: [DONE]'))
    assert.ok(warns.some((line) => line.includes('截断')), '截断要留日志')
  })
})

await test('截断文案必须能被宿主判成 TRANSPORT（否则 llm-retry 根本不会重试）', async () => {
  // 宿主 dsh-llm-pi-ai 的 classifyPiAiError **只看 message 文本**，不看 code：
  //   /stream ended (?:before|without)\b/i                    → TRANSPORT
  //   /\b(?:network|connection|socket|fetch)\b|…/             → TRANSPORT
  // 文案若退化成纯中文，就被归成 PI_AI_ERROR（不可重试），这轮修复等于没做。
  const HOST_STREAM_TRUNCATION = /stream ended (?:before|without)\b/i
  const HOST_CONNECTION = /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i
  const base = truncationMessage()
  const withDetail = truncationMessage('upstream said: terminated')

  for (const [label, message] of [['无 detail', base], ['带 detail', withDetail]]) {
    assert.ok(
      HOST_STREAM_TRUNCATION.test(message) || HOST_CONNECTION.test(message),
      `${label}：截断文案必须命中宿主的 TRANSPORT 正则，实际 ${JSON.stringify(message)}`,
    )
  }
  // 脱敏照旧：detail 里的凭据不能进响应体
  assert.ok(!truncationMessage('token=abcdef123456').includes('abcdef123456'))
  // 保留中文，方便用户看懂
  assert.match(base, /中断/)
})

await test('流式心跳：上游思考期不吐帧时，连接上必须持续出现 SSE 注释帧', async () => {
  // 网关绑局域网 IP，中间 NAT/反代会按 idle timeout 掐连接。上游思考期几十秒
  // 没字节时唯一能保活的就是注释帧（`: ping`），OpenAI SDK 解码器会跳过它。
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const chunks = [
    { type: 'text-delta', index: 0, text: '前半' },
    // 思考/生成中的长空档：远超心跳间隔
    { type: 'text-delta', index: 0, text: '后半' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const stalled = function stream() {
    let index = 0
    return {
      [Symbol.asyncIterator]() { return this },
      async next() {
        if (index === 1) await delay(120)
        if (index >= chunks.length) return { value: undefined, done: true }
        return { value: chunks[index++], done: false }
      },
      return() { return Promise.resolve({ value: undefined, done: true }) },
    }
  }
  await withGateway({
    ctx: { llm: { stream: stalled } },
    config: { sseHeartbeatMs: 20 },
  }, async (_gateway, address) => {
    const { text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
    const pings = text.split('\n\n').filter((block) => block === ': ping')
    assert.ok(pings.length >= 2, `思考期应有多次心跳，实际 ${pings.length}`)
    // 心跳不能污染内容：正文与收尾帧照旧
    const frames = parseSse(text)
    const content = frames.map((f) => f.choices?.[0]?.delta?.content ?? '').join('')
    assert.equal(content, '前半后半')
    assert.equal(frames.filter((f) => f.choices?.[0]?.finish_reason).length, 1)
  })
})

await test('流式心跳：流结束后不再发心跳（不往已收尾的响应写）', async () => {
  await withGateway({
    ctx: { llm: { stream: scriptedStream([
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) } },
    config: { sseHeartbeatMs: 10 },
  }, async (_gateway, address) => {
    const { text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.ok(text.trimEnd().endsWith('data: [DONE]'), '收尾必须是 [DONE]，心跳不能跑到它后面')
    assert.ok(!text.includes(': ping'), '快流不该产生心跳')
  })
})

await test('审计：截断的流记 outcome=truncated，正常流记 ok', async () => {
  const dir = await freshDir()
  const auditPath = join(dir, 'gateway-audit.ndjson')
  // 截断：只有正文没有 finish
  await withGateway({
    ctx: { llm: { stream: scriptedStream([{ type: 'text-delta', index: 0, text: '半截' }]) } },
    config: {},
    auditPath,
    warn: () => {},
  }, async (_gateway, address) => {
    await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
  })
  // 正常：带 finish
  await withGateway({
    ctx: { llm: { stream: scriptedStream([
      { type: 'text-delta', index: 0, text: '完整' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) } },
    config: {},
    auditPath,
    warn: () => {},
  }, async (_gateway, address) => {
    await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
  })

  // 审计在响应收尾之后的 finally 里写，和客户端拿到最后一个字节有微小竞态：轮询等落盘
  let lines = []
  for (let i = 0; i < 50; i += 1) {
    const raw = await readFile(auditPath, 'utf8').catch(() => '')
    lines = raw.trim() === '' ? [] : raw.trim().split('\n').map((line) => JSON.parse(line))
    if (lines.length >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(lines.length, 2, `应有两条审计，实际 ${lines.length}`)
  // 两条的 status 都是 200 —— 正是线上那条「200 + tokens=0」看不出问题的根因
  assert.deepEqual(lines.map((line) => line.status), [200, 200])
  assert.deepEqual(lines.map((line) => line.outcome), ['truncated', 'ok'])
})

await test('流式收尾：finish=aborted 但客户端还连着，也要补结束帧', async () => {
  const chunks = [
    { type: 'text-delta', index: 1, text: '半个回答' },
    { type: 'finish', reason: { kind: 'aborted' } },
  ]
  await withGateway({
    ctx: { llm: { stream: scriptedStream(chunks) } },
    config: {},
  }, async (_gateway, address) => {
    const { text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
    const frames = parseSse(text)
    const finishers = frames.filter((f) => f.choices?.[0]?.finish_reason != null)
    assert.equal(finishers.length, 1)
    assert.equal(finishers[0].choices[0].finish_reason, 'stop')
  })
})

await test('流式收尾：finish_reason 帧在 usage 帧与 [DONE] 之前', async () => {
  const chunks = [
    { type: 'text-delta', index: 1, text: 'hi' },
    usageChunk,
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await withGateway({
    ctx: { llm: { stream: scriptedStream(chunks) } },
    config: {},
  }, async (_gateway, address) => {
    const { text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({
      stream: true, stream_options: { include_usage: true },
    }))
    const frames = parseSse(text)
    const finishIdx = frames.findIndex((f) => f.choices?.[0]?.finish_reason != null)
    const usageIdx = frames.findIndex((f) => Array.isArray(f.choices) && f.choices.length === 0)
    assert.ok(finishIdx >= 0 && usageIdx >= 0)
    assert.ok(finishIdx < usageIdx, 'finish 帧必须在 usage 帧之前')
    assert.ok(text.trimEnd().endsWith('data: [DONE]'))
  })
})

await test('TK-0002 流式：头四项 + role 首帧 + 逐帧映射 + 严格 [DONE] + include_usage', async () => {
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: '思考' },
    { type: 'reasoning-delta', index: 0, text: '中' },
    { type: 'text-delta', index: 1, text: '你' },
    { type: 'text-delta', index: 1, text: '好' },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'call_x', name: 'search', argumentsDelta: '{"q":' },
    { type: 'tool-call-delta', index: 2, id: 'call_x', argumentsDelta: '"hi"}' },
    usageChunk,
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  await withGateway({
    ctx: { llm: { stream: scriptedStream(chunks) } },
    config: {},
  }, async (_gateway, address) => {
    const { res, text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({
      stream: true,
      stream_options: { include_usage: true },
    }))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(res.headers.get('cache-control'), 'no-cache')
    assert.equal(res.headers.get('connection'), 'keep-alive')
    assert.equal(res.headers.get('x-accel-buffering'), 'no')

    const frames = parseSse(text)
    assert.deepEqual(frames[0].choices[0].delta, { role: 'assistant' })
    assert.equal(frames[0].object, 'chat.completion.chunk')
    assert.match(frames[0].id, /^chatcmpl-/)

    const reasoning = frames.filter((f) => f.choices[0]?.delta?.reasoning_content).map((f) => f.choices[0].delta.reasoning_content).join('')
    const content = frames.filter((f) => f.choices[0]?.delta?.content).map((f) => f.choices[0].delta.content).join('')
    assert.equal(reasoning, '思考中')
    assert.equal(content, '你好')

    const toolFrames = frames.filter((f) => f.choices[0]?.delta?.tool_calls)
    assert.deepEqual(toolFrames.map((f) => f.choices[0].delta.tool_calls[0].index), [0, 0])
    assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].id, 'call_x')
    assert.equal(toolFrames[0].choices[0].delta.tool_calls[0].function.name, 'search')
    const args = toolFrames.map((f) => f.choices[0].delta.tool_calls[0].function.arguments).join('')
    assert.deepEqual(JSON.parse(args), { q: 'hi' })

    const finishFrame = frames.find((f) => f.choices[0]?.finish_reason)
    assert.equal(finishFrame.choices[0].finish_reason, 'tool_calls')
    assert.deepEqual(finishFrame.choices[0].delta, {})

    const usageFrame = frames.at(-1)
    assert.deepEqual(usageFrame.choices, [])
    assert.deepEqual(usageFrame.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })
  })
})

await test('TK-0002 流式：不请求 usage 时无 usage 帧；aborted 不发 finish_reason', async () => {
  for (const reason of [{ kind: 'stop' }, { kind: 'aborted', failure: {} }]) {
    await withGateway({
      ctx: { llm: { stream: scriptedStream([
        { type: 'text-delta', index: 0, text: 'hi' },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', reason },
      ]) } },
      config: {},
    }, async (_gateway, address) => {
      const { text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
      const frames = parseSse(text)
      assert.equal(frames.at(-1).usage, undefined, '未请求 include_usage 不应发 usage 帧')
      const finishes = frames.filter((f) => f.choices[0]?.finish_reason)
      // aborted 也补 stop：客户端还连着，缺结束帧会让界面卡在「思考中」
      assert.equal(finishes.length, 1)
      assert.equal(finishes.at(-1).choices[0].finish_reason, 'stop')
    })
  }
})

await test('TK-0002 流式：流中途抛错 → iterator.return() + error chunk + [DONE] + 不改 200', async () => {
  const returned = []
  await withGateway({
    ctx: { llm: { stream: throwingStream([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'text-delta', index: 0, text: ' partial2' },
    ], 2, { return: () => returned.push(1) }) } },
    config: {},
    warn: () => {},
  }, async (_gateway, address) => {
    const { res, text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
    assert.equal(res.status, 200, '已发 200 后不能改状态码')
    const frames = parseSse(text)
    const errorFrame = frames.at(-1)
    assert.equal(errorFrame.error.code, 'internal_error')
    assert.ok(!JSON.stringify(errorFrame).includes('secret'), '错误帧必须脱敏')
    assert.equal(returned.length, 1, 'iterator.return() 必须被调用')
  })
})

await test('TK-0002 非流式：流抛错 → iterator.return() + 标准错误信封（不回显 stack）', async () => {
  const returned = []
  await withGateway({
    ctx: { llm: { stream: throwingStream([], 0, { return: () => returned.push(1) }) } },
    config: {},
  }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/chat/completions`, { method: 'POST', body: baseBody() })
    assert.equal(res.status, 500)
    assert.equal(res.json.error.code, 'internal_error')
    assert.ok(!res.text.includes('secret'))
    assert.equal(returned.length, 1)
  })
})

await test('TK-0002 流式：客户端断连 → iterator.return() 被调用', async () => {
  const returned = []
  let released
  await withGateway({
    ctx: { llm: { stream() {
      return (async function* () {
        try {
          yield { type: 'text-delta', index: 0, text: 'x' }
          await new Promise((resolve) => { released = resolve; setTimeout(resolve, 5000) })
          yield { type: 'text-delta', index: 0, text: 'y' }
        } finally {
          returned.push(1)
        }
      })()
    } } },
    config: {},
  }, async (_gateway, address) => {
    const controller = new AbortController()
    const response = await fetch(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(baseBody({ stream: true })),
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    await reader.read()
    controller.abort()
    reader.cancel().catch(() => {})
    // 放开 iterator 里挂着的等待，让它走到 finally
    released?.()
    for (let i = 0; i < 50 && returned.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(returned.length, 1, '断连后 iterator.return() 应释放生成器')
  })
})

await test('TK-0002 背压：大块输出逐帧可读且顺序不乱（高水位后等 drain）', async () => {
  const parts = Array.from({ length: 300 }, (_, i) => `seg-${i}-`.repeat(20))
  await withGateway({
    ctx: { llm: { stream: scriptedStream([
      ...parts.map((text, i) => ({ type: 'text-delta', index: i, text })),
      { type: 'finish', reason: { kind: 'stop' } },
    ]) } },
    config: {},
  }, async (_gateway, address) => {
    const { res, text } = await fetchSse(`${address.url}/v1/chat/completions`, baseBody({ stream: true }))
    assert.equal(res.status, 200)
    const frames = parseSse(text)
    const content = frames.filter((f) => f.choices[0]?.delta?.content).map((f) => f.choices[0].delta.content).join('')
    assert.equal(content, parts.join(''))
    assert.equal(text.endsWith('data: [DONE]\n\n'), true)
  })
})


// ------------------------------------------- TK-0003 鉴权 / 多 Key / 限流 / 审计

/** 每条 TK-0003 用例用独立临时目录，互不干扰。 */
async function freshDir() {
  return mkdtemp(join(tmpdir(), 'mgw-tk3-'))
}

/** 临时目录里的一对路径。 */
function pathsOf(dir) {
  return { keysPath: join(dir, 'gateway.json'), auditPath: join(dir, 'gateway-audit.ndjson') }
}

await test('TK-0003 Key 存储：明文只返回一次，落盘只有 hash/prefix/suffix', async () => {
  const dir = await freshDir()
  const { keysPath, auditPath } = pathsOf(dir)
  const store = createKeyStore({ keysPath, auditPath })

  const created = await store.createKey('我的 Key')
  assert.match(created.key, /^mgw_live_[A-Za-z0-9_-]{32}$/)
  assert.equal(typeof created.id, 'string')
  assert.equal(created.name, '我的 Key')

  const text = await readFile(keysPath, 'utf8')
  assert.ok(!text.includes(created.key), 'gateway.json 绝不能出现明文')
  assert.ok(!text.includes('mgw_live_'), 'gateway.json 连前缀都不该有多余出现')
  assert.ok(text.includes(created.key.slice(-4)), 'suffix 应落盘用于界面识别')

  const raw = JSON.parse(text)
  assert.equal(raw.keys.length, 1)
  const [record] = raw.keys
  assert.equal(record.hash.length, 64, 'hash 是 sha256 hex')
  assert.equal(record.prefix, created.key.slice('mgw_live_'.length, 'mgw_live_'.length + 4))
  assert.equal(record.suffix, created.key.slice(-4))
  assert.equal(record.enabled, true)
  assert.equal(record.hash.includes(created.key), false)

  // 权限 0600
  const mode = (await stat(keysPath)).mode & 0o777
  assert.equal(mode, 0o600, `gateway.json 权限应为 0600，实际 ${mode.toString(8)}`)
  const dirMode = (await stat(dir)).mode & 0o777
  assert.equal(dirMode, 0o700, `状态目录权限应为 0700，实际 ${dirMode.toString(8)}`)
})

await test('TK-0003 verifyKey：命中返回记录（不含 hash），错 Key/禁用 Key 返回 undefined', async () => {
  const dir = await freshDir()
  const store = createKeyStore(pathsOf(dir))
  const created = await store.createKey('k1')

  const hit = await store.verifyKey(created.key)
  assert.equal(hit.id, created.id)
  assert.equal(hit.hash, undefined, '对外记录不能带 hash')
  assert.equal(hit.key, undefined, '对外记录不能带明文')
  assert.ok(typeof hit.lastUsedAt === 'string', 'lastUsedAt 应被更新')

  assert.equal(await store.verifyKey('mgw_live_00000000000000000000000000000000'), undefined)
  // 长度不等也必须走完比较、不抛错（timingSafeEqual 原生长度不等会抛）
  assert.equal(await store.verifyKey('x'), undefined)
  assert.equal(await store.verifyKey(''), undefined)
  assert.equal(await store.verifyKey(undefined), undefined)
  assert.equal(await store.verifyKey(12345), undefined)

  await store.setEnabled(created.id, false)
  assert.equal(await store.verifyKey(created.key), undefined, '禁用后必须验不过')

  const listed = await store.listKeys()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].enabled, false)
  assert.equal(listed[0].hash, undefined)
  assert.equal(listed[0].lastUsedAt !== undefined, true)

  assert.equal(await store.removeKey(created.id), true)
  assert.deepEqual(await store.listKeys(), [])
  assert.equal(await store.verifyKey(created.key), undefined)
})

await test('TK-0003 存储容错：文件不存在返回空结构；JSON 损坏 warn 后重建', async () => {
  const dir = await freshDir()
  const { keysPath } = pathsOf(dir)
  const store = createKeyStore({ keysPath, auditPath: join(dir, 'a.ndjson') })

  assert.deepEqual(await store.listKeys(), [], '文件不存在应返回空列表')

  await writeFile(keysPath, '{ 这不是 JSON', 'utf8')
  const warns = []
  const broken = createKeyStore({ keysPath, auditPath: join(dir, 'a.ndjson'), warn: (m) => warns.push(m) })
  assert.deepEqual(await broken.listKeys(), [], '损坏时按空存储处理，不能抛')
  assert.ok(warns.some((m) => m.includes('损坏')), `应 warn 损坏，实际：${warns.join('|')}`)

  // 重建：新建的 Key 能正常落盘并校验
  const created = await broken.createKey('重建后的 Key')
  assert.equal((await broken.verifyKey(created.key)).id, created.id)
  const raw = JSON.parse(await readFile(keysPath, 'utf8'))
  assert.equal(raw.keys.length, 1, '重建后文件应只含新 Key')
})

await test('TK-0003 appendAudit：只写白名单字段，多传的正文/Key/请求体全部丢弃', async () => {
  const dir = await freshDir()
  const { auditPath } = pathsOf(dir)
  const store = createKeyStore(pathsOf(dir))
  const created = await store.createKey('audit-key')

  await store.appendAudit({
    at: '2026-01-02T03:04:05.000Z',
    keyId: created.id,
    keySuffix: created.key.slice(-4),
    model: 'mg-auto',
    account: 'workbuddy',
    promptTokens: 11,
    completionTokens: 7,
    status: 200,
    // 下面这些绝不能被写进去
    messages: [{ role: 'user', content: '机密正文-不许落盘' }],
    key: created.key,
    body: { messages: [{ role: 'user', content: '机密正文-不许落盘' }] },
    stack: 'at foo (/secret/path.js:1)',
  })

  const text = await readFile(auditPath, 'utf8')
  const lines = text.trim().split('\n')
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(entry).sort(), [
    'account', 'at', 'completionTokens', 'keyId', 'keySuffix', 'model', 'outcome', 'promptTokens', 'status',
  ])
  // outcome 只收枚举值，乱传一律落 unknown（防止它变成自由文本通道）
  assert.equal(entry.outcome, 'unknown', '未给 outcome 时写 unknown')
  assert.equal(entry.keyId, created.id)
  assert.equal(entry.model, 'mg-auto')
  assert.equal(entry.promptTokens, 11)
  assert.equal(entry.completionTokens, 7)
  assert.equal(entry.status, 200)
  assert.ok(!text.includes('机密正文'), '审计不能含 messages 正文')
  assert.ok(!text.includes(created.key), '审计不能含完整 Key')
  assert.ok(!text.includes('secret/path'), '审计不能含堆栈')

  const mode = (await stat(auditPath)).mode & 0o777
  assert.equal(mode, 0o600, `审计文件权限应为 0600，实际 ${mode.toString(8)}`)
})

/** 记录 ctx.llm.stream 调用次数，供「401 不进 chat」断言。 */
function countingStream(chunks) {
  const counter = { calls: 0 }
  counter.stream = function stream() {
    counter.calls += 1
    return scriptedStream(chunks)()
  }
  return counter
}

await test('TK-0003 鉴权：无 Key / 错 Key / 已禁用 Key → 401 且不进入 chat 处理', async () => {
  const dir = await freshDir()
  const store = createKeyStore(pathsOf(dir))
  const good = await store.createKey('good')
  const disabled = await store.createKey('disabled')
  await store.setEnabled(disabled.id, false)

  const counter = countingStream([{ type: 'finish', reason: { kind: 'stop' } }])
  await withGateway({
    ctx: { llm: counter },
    config: {},
    keyStore: store,
  }, async (_gateway, address) => {
    const cases = [
      { name: '无 Authorization', options: { noAuth: true } },
      { name: '错 Key', options: { headers: { authorization: 'Bearer mgw_live_wrongwrongwrongwrongwrongwrong' } } },
      { name: '非 Bearer 格式', options: { headers: { authorization: 'Basic abc' } } },
      { name: '空 Bearer', options: { headers: { authorization: 'Bearer ' } } },
      { name: '已禁用 Key', options: { headers: { authorization: `Bearer ${disabled.key}` } } },
    ]
    for (const item of cases) {
      const res = await call(`${address.url}/v1/chat/completions`, {
        method: 'POST',
        body: baseBody(),
        ...item.options,
      })
      assert.equal(res.status, 401, `${item.name} 应 401`)
      assert.equal(res.json.error.type, 'authentication_error')
      assert.equal(res.json.error.code, 'invalid_api_key')
      assert.ok(!res.text.includes(good.key), '错误体绝不能回显完整 Key')
      assert.ok(!res.text.includes('mgw_live_'), '错误体连 Key 片段都不该有')
      assert.ok(!res.text.includes('at '), '错误体不能有堆栈')
    }
    assert.equal(counter.calls, 0, '鉴权失败绝不能调 ctx.llm.stream')

    // /v1/models 也必须鉴权（OpenAI 标准）
    const models = await call(`${address.url}/v1/models`, { noAuth: true })
    assert.equal(models.status, 401)
    const modelsOk = await call(`${address.url}/v1/models`, { headers: { authorization: `Bearer ${good.key}` } })
    assert.equal(modelsOk.status, 200)

    // healthz 仍在鉴权之前
    const health = await call(`${address.url}/healthz`, { noAuth: true })
    assert.equal(health.status, 200)

    // 合法 Key 能进 chat
    const ok = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody(),
      headers: { authorization: `Bearer ${good.key}` },
    })
    assert.equal(ok.status, 200)
    assert.equal(counter.calls, 1)
  })
})

await test('TK-0003 限流：并发超限 429 + Retry-After，请求结束后闸门释放可恢复', async () => {
  const dir = await freshDir()
  const store = createKeyStore(pathsOf(dir))
  const created = await store.createKey('rl')

  let entered
  const enteredPromise = new Promise((resolve) => { entered = resolve })
  let release
  const hold = new Promise((resolve) => { release = resolve })

  await withGateway({
    ctx: { llm: { stream() {
      return (async function* () {
        entered()
        await hold
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    } } },
    config: {},
    keyStore: store,
    limits: { concurrency: 1, perMinute: 100 },
  }, async (_gateway, address) => {
    const headers = { authorization: `Bearer ${created.key}` }
    const first = fetch(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(baseBody({ stream: false })),
    })
    await enteredPromise

    const blocked = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody(),
      headers,
    })
    assert.equal(blocked.status, 429, '并发超限应 429')
    assert.equal(blocked.json.error.type, 'rate_limit_error')
    assert.equal(blocked.json.error.code, 'rate_limited')
    assert.ok(Number(blocked.headers['retry-after']) >= 1, `应带 Retry-After，实际 ${blocked.headers['retry-after']}`)

    release()
    const firstRes = await first
    assert.equal(firstRes.status, 200)
    await firstRes.text()

    // 闸门已释放：再来一次应恢复 200
    for (let i = 0; i < 20; i += 1) {
      const again = await call(`${address.url}/v1/chat/completions`, {
        method: 'POST',
        body: baseBody(),
        headers,
      })
      if (again.status === 200) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail('并发闸没有释放，后续请求一直是 429')
  })
})

await test('TK-0003 限流：每分钟请求数超限 429（含 Retry-After 秒数）', async () => {
  const dir = await freshDir()
  const store = createKeyStore(pathsOf(dir))
  const created = await store.createKey('per-minute')
  await withGateway({
    ctx: { llm: { stream: scriptedStream([
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) } },
    config: {},
    keyStore: store,
    limits: { concurrency: 8, perMinute: 2 },
  }, async (_gateway, address) => {
    const headers = { authorization: `Bearer ${created.key}` }
    for (let i = 0; i < 2; i += 1) {
      const ok = await call(`${address.url}/v1/chat/completions`, { method: 'POST', body: baseBody(), headers })
      assert.equal(ok.status, 200, `第 ${i + 1} 次应放行`)
    }
    const blocked = await call(`${address.url}/v1/chat/completions`, { method: 'POST', body: baseBody(), headers })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.json.error.code, 'rate_limited')
    assert.ok(Number(blocked.headers['retry-after']) >= 1)
    assert.ok(Number(blocked.headers['retry-after']) <= 60)
  })
})

await test('TK-0003 审计：成功与失败各写一条，字段齐全且不含正文/完整 Key', async () => {
  const dir = await freshDir()
  const { keysPath, auditPath } = pathsOf(dir)
  const store = createKeyStore({ keysPath, auditPath })
  const created = await store.createKey('审计 Key')
  const secretText = '审计绝不落盘的正文-abc123'

  await withGateway({
    ctx: { llm: { stream: scriptedStream([
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'usage', usage: { inputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) } },
    config: {},
    keyStore: store,
  }, async (_gateway, address) => {
    const ok = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'mg-auto', messages: [{ role: 'user', content: secretText }] }),
      headers: { authorization: `Bearer ${created.key}` },
    })
    assert.equal(ok.status, 200)
  })

  await withGateway({
    ctx: { llm: {} },
    config: {},
    keyStore: store,
  }, async (_gateway, address) => {
    // 失败也写审计：模型非法（400），此时还没到 chat 处理
    const fail = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'gpt-4o', messages: [{ role: 'user', content: secretText }] }),
      headers: { authorization: `Bearer ${created.key}` },
    })
    assert.equal(fail.status, 400)
  })

  const text = await readFile(auditPath, 'utf8')
  const entries = text.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(entries.length, 2, '成功与失败各一条')

  const success = entries.find((entry) => entry.status === 200)
  assert.ok(success !== undefined, `应有 200 的记录：${text}`)
  assert.equal(success.keyId, created.id)
  assert.equal(success.keySuffix, created.key.slice(-4))
  assert.equal(success.model, 'mg-auto')
  assert.equal(success.promptTokens, 8, 'prompt = input + cacheRead + cacheWrite')
  assert.equal(success.completionTokens, 3)
  assert.ok(typeof success.at === 'string' && success.at.includes('T'))

  assert.ok(entries.some((entry) => entry.status === 400), '失败的请求也要留痕')
  assert.ok(!text.includes(secretText), '审计绝不能含 messages 正文')
  assert.ok(!text.includes(created.key), '审计绝不能含完整 Key')
  assert.ok(!text.includes('mgw_live_'), '审计连 Key 前缀都不该有')
})

await test('TK-0003 审计写失败不影响主流程（只 warn）', async () => {
  const dir = await freshDir()
  const { keysPath } = pathsOf(dir)
  // 把父路径做成「文件」，让 ensureDir 必然失败
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'x', 'utf8')
  const auditPath = join(blocker, 'nested', 'audit.ndjson')
  const warns = []
  const store = createKeyStore({ keysPath, auditPath, warn: (message) => warns.push(message) })
  const created = await store.createKey('audit-broken')

  await withGateway({
    ctx: { llm: { stream: scriptedStream([
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) } },
    config: {},
    keyStore: store,
    warn: (message) => warns.push(message),
  }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody(),
      headers: { authorization: `Bearer ${created.key}` },
    })
    assert.equal(res.status, 200, '审计失败不能影响主流程')
    assert.equal(res.json.choices[0].message.content, 'ok')
    // 审计在响应结束后才写（旁路），轮询等它落
    for (let i = 0; i < 50 && warns.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })
  assert.ok(warns.some((message) => message.includes('审计')), `应 warn 审计失败，实际：${warns.join('|')}`)
})

await test('TK-0003 多 Key 隔离：限流按 Key 分桶，互不影响', async () => {
  const dir = await freshDir()
  const store = createKeyStore(pathsOf(dir))
  const keyA = await store.createKey('A')
  const keyB = await store.createKey('B')

  let entered
  const enteredPromise = new Promise((resolve) => { entered = resolve })
  let release
  const hold = new Promise((resolve) => { release = resolve })

  await withGateway({
    ctx: { llm: { stream() {
      return (async function* () {
        entered()
        await hold
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    } } },
    config: {},
    keyStore: store,
    limits: { concurrency: 1, perMinute: 100 },
  }, async (_gateway, address) => {
    const first = fetch(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA.key}` },
      body: JSON.stringify(baseBody()),
    })
    await enteredPromise

    // A 已占满自己的桶 → A 429
    const blockedA = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST', body: baseBody(), headers: { authorization: `Bearer ${keyA.key}` },
    })
    assert.equal(blockedA.status, 429)

    release()
    const firstRes = await first
    await firstRes.text()
    assert.equal(firstRes.status, 200)

    // B 的桶是空的 → 200
    const okB = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody(),
      headers: { authorization: `Bearer ${keyB.key}` },
    })
    assert.equal(okB.status, 200, 'B 不该被 A 的并发占用影响')
  })
})

// ------------------------------------------------------------------ 汇总

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败，${passed} 项通过\n`)
  for (const { name, error } of failures) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n  ') : String(error)}\n`)
  }
  process.exitCode = 1
} else {
  console.log(`✓ openai-gateway: ${passed} 项全部通过`)
}
