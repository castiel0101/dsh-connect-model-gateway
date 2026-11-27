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

import {
  ProtocolError,
  errorEnvelope,
  errorTypeForStatus,
  extractImageParts,
  finishReasonOf,
  modelObject,
  modelsList,
  parseImageUrl,
  parseModel,
  sanitizeErrorMessage,
  streamOptionsOf,
  toGenerateOptions,
} from '../lib/core/openai-protocol.js'
import { createGateway } from '../lib/core/openai-gateway.js'

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
    model: 'mg:auto',
    messages: [{ role: 'user', content: '你好' }],
    ...overrides,
  }
}

// ---------------------------------------------------------------- parseModel

await test('parseModel: mg:auto', () => {
  assert.deepEqual(parseModel('mg:auto'), { provider: 'auto', actualModel: 'auto' })
})

await test('parseModel: mg:<provider>:<model>（model 里允许再带冒号）', () => {
  assert.deepEqual(parseModel('mg:workbuddy:claude-sonnet-4'), {
    provider: 'workbuddy',
    actualModel: 'claude-sonnet-4',
  })
  assert.deepEqual(parseModel('mg:scnet:org/model:v2'), {
    provider: 'scnet',
    actualModel: 'org/model:v2',
  })
})

await test('parseModel: 别名精确匹配（字符串 / 对象两种别名值）', () => {
  const aliases = {
    'gpt-4o': 'mg:workbuddy:claude-sonnet-4',
    'fast': { provider: 'scnet', model: 'SCNet-Max' },
  }
  assert.deepEqual(parseModel('gpt-4o', aliases), {
    provider: 'workbuddy',
    actualModel: 'claude-sonnet-4',
  })
  assert.deepEqual(parseModel('fast', aliases), { provider: 'scnet', actualModel: 'SCNet-Max' })
})

await test('parseModel: mg:auto:xxx 非法（auto 只有 auto 一个模型）', () => {
  assert.deepEqual(parseModel('mg:auto:auto'), { provider: 'auto', actualModel: 'auto' })
  assertProtocolError(() => parseModel('mg:auto:gpt-4o'), { status: 400, code: 'model_not_found' })
})

await test('parseModel: 别名链式展开 + Map 别名表', () => {
  const aliases = new Map([
    ['a', 'b'],
    ['b', 'mg:auto'],
  ])
  assert.deepEqual(parseModel('a', aliases), { provider: 'auto', actualModel: 'auto' })
})

await test('parseModel: 其它一律 400 model_not_found（禁止模糊匹配/静默回退）', () => {
  assertProtocolError(() => parseModel('gpt-4o'), { status: 400, code: 'model_not_found' })
  // 大小写不同不算命中
  assertProtocolError(() => parseModel('MG:AUTO'), { status: 400, code: 'model_not_found' })
  // 前缀不完整
  assertProtocolError(() => parseModel('mg:workbuddy'), { status: 400, code: 'model_not_found' })
  assertProtocolError(() => parseModel('mg::x'), { status: 400, code: 'model_not_found' })
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
  assert.deepEqual(parseModel('mg:workbuddy:claude-sonnet-4', {}, known), {
    provider: 'workbuddy',
    actualModel: 'claude-sonnet-4',
  })
  assert.deepEqual(parseModel('mg:auto', {}, new Set(known)), { provider: 'auto', actualModel: 'auto' })

  const unknown = assertProtocolError(
    () => parseModel('mg:nope:gpt-4o', {}, known),
    { status: 400, param: 'model', code: 'model_not_found' },
  )
  assert.ok(unknown.message.includes('nope'))
  assert.ok(!unknown.message.includes('workbuddy'), '错误文案不能列出内部平台清单')

  // 别名解析出来的 provider 也要过校验
  assertProtocolError(
    () => parseModel('fast', { fast: 'mg:nope:SCNet-Max' }, known),
    { status: 400, code: 'model_not_found' },
  )

  // 不传白名单 = 旧行为：格式合法就放行（纯函数可测性）
  assert.deepEqual(parseModel('mg:nope:gpt-4o'), { provider: 'nope', actualModel: 'gpt-4o' })
  assert.deepEqual(parseModel('mg:nope:gpt-4o', {}, undefined), { provider: 'nope', actualModel: 'gpt-4o' })
})

// -------------------------------------------------------- messages 各 role

await test('messages: system/user 字符串 content', () => {
  const options = toGenerateOptions({
    model: 'mg:auto',
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
  assertProtocolError(() => toGenerateOptions({ model: 'mg:auto', messages: [] }, parsed),
    { status: 400, code: 'messages_required' })
  assertProtocolError(() => toGenerateOptions({ model: 'mg:auto' }, parsed),
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
  assert.equal(options.mgw.requestedModel, 'mg:auto')

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
      'mg:auto',
      { id: 'mg:workbuddy:claude-sonnet-4', owned_by: 'workbuddy', created: 1700000000 },
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
    id: 'mg:auto',
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
  assert.deepEqual(modelsList([{ id: '' }, 'mg:auto']).data.map((item) => item.id), ['mg:auto'])
  assert.throws(() => modelsList('nope'), TypeError)
  assert.equal(modelObject({ id: 'mg:auto' }).id, 'mg:auto')
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

/** 发一次 HTTP 请求，回 { status, headers, json, text }。 */
function call(url, { method = 'GET', body, headers = {} } = {}) {
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

/** 起一个网关，用完关掉。 */
async function withGateway(options, fn) {
  const gateway = createGateway(options)
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
    config: { models: ['mg:auto', { id: 'mg:workbuddy:claude-sonnet-4', owned_by: 'workbuddy' }] },
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
    config: { models: ['mg:auto'] },
  }, async (_gateway, address) => {
    const hit = await call(`${address.url}/v1/models/mg:auto`)
    assert.equal(hit.status, 200)
    assert.equal(hit.json.id, 'mg:auto')
    assert.equal(hit.json.object, 'model')

    const encoded = await call(`${address.url}/v1/models/${encodeURIComponent('mg:auto')}`)
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
    config: { models: ['mg:scnet:org/model:v2'] },
  }, async (_gateway, address) => {
    const hit = await call(`${address.url}/v1/models/mg:scnet:org/model:v2`)
    assert.equal(hit.status, 200)
    assert.equal(hit.json.id, 'mg:scnet:org/model:v2')

    const badEscape = await call(`${address.url}/v1/models/%E0%A4%A`)
    assert.equal(badEscape.status, 400)
    assert.equal(badEscape.json.error.code, 'invalid_model_path')
  })
})

await test('server: 默认 modelsProvider 只给 mg:auto', async () => {
  await withGateway({ ctx: { llm: {} }, config: {} }, async (_gateway, address) => {
    const res = await call(`${address.url}/v1/models`)
    assert.deepEqual(res.json.data.map((item) => item.id), ['mg:auto'])
  })
})

await test('server: chat/completions 默认 501 + 错误信封（TK-0002 占位）', async () => {
  await withGateway({ ctx: { llm: {} }, config: {} }, async (_gateway, address) => {
    for (const path of ['/v1/chat/completions', '/chat/completions']) {
      const res = await call(`${address.url}${path}`, {
        method: 'POST',
        body: baseBody(),
      })
      assert.equal(res.status, 501, path)
      assert.equal(res.json.error.type, 'server_error')
      assert.equal(res.json.error.code, 'not_implemented')
      assert.ok(!res.text.includes('mg:auto'), '错误体不该回显请求正文')
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
    config: { aliases: { fast: 'mg:scnet:SCNet-Max' } },
    modelsProvider: () => ['mg:auto', { id: 'mg:workbuddy:claude-sonnet-4' }],
  }, async (_gateway, address) => {
    // workbuddy 在目录里、scnet 在别名目标里，两个都算已接入
    for (const model of ['mg:workbuddy:claude-sonnet-4', 'fast']) {
      const res = await call(`${address.url}/v1/chat/completions`, {
        method: 'POST',
        body: baseBody({ model }),
      })
      assert.equal(res.status, 501, `${model} 应通过 parseModel`)
      assert.equal(res.headers['x-mgw-provider'], decodeURIComponent(model === 'fast' ? 'scnet' : 'workbuddy'))
    }

    const unknown = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'mg:nope:gpt-4o' }),
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
    config: { models: ['mg:auto'] },
    providers: () => allow,
  }, async (gateway, address) => {
    assert.deepEqual([...gateway.protocol.knownProviders()].sort(), ['auto', 'workbuddy'])

    const before = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'mg:scnet:SCNet-Max' }),
    })
    assert.equal(before.status, 400)

    allow = ['auto', 'workbuddy', 'scnet']
    const after = await call(`${address.url}/v1/chat/completions`, {
      method: 'POST',
      body: baseBody({ model: 'mg:scnet:SCNet-Max' }),
    })
    assert.equal(after.status, 501)
    assert.equal(after.headers['x-mgw-provider'], 'scnet')
  })
})

await test('server: models 列表 created 是网关启动时间戳（非 0）', async () => {
  const before = Math.floor(Date.now() / 1000)
  await withGateway({ ctx: { llm: {} }, config: { models: ['mg:auto'] } }, async (_gateway, address) => {
    const after = Math.floor(Date.now() / 1000)
    const res = await call(`${address.url}/v1/models`)
    const created = res.json.data[0].created
    assert.equal(typeof created, 'number')
    assert.ok(created >= before && created <= after, `created=${created} 不在 [${before}, ${after}]`)
    assert.ok(created !== 0)

    // 单个模型详情也要带同一个时间戳
    const one = await call(`${address.url}/v1/models/mg:auto`)
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
        headers: { 'content-type': 'application/json' },
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
      body: { model: 'mg:auto', messages: [] },
    })
    assert.equal(emptyMessages.status, 400)
    assert.equal(emptyMessages.json.error.code, 'messages_required')
  })
})

await test('server: chatHandler 注入点收到解析好的 GenerateOptions', async () => {
  const seen = []
  await withGateway({
    ctx: { llm: {} },
    config: { aliases: { fast: 'mg:scnet:SCNet-Max' } },
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
  const gateway = createGateway({ ctx: { llm: {} }, config: {} })
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
