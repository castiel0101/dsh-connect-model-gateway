/**
 * 豆包接入自测（不联网、不依赖 DSH 宿主）。
 *
 * 跑法：node test/doubao.test.mjs
 *
 * 覆盖的全是「写成注释很容易、写错就静默坏」的点：
 * 三行帧解析、块遍历取文本、生图 URL 优先级、生图 prompt 瘦身、
 * 思考档位词汇与逐模型档位、额度窗口折算、错误分类、URL 转义。
 */

import assert from 'node:assert/strict'

import {
  CLIENT_PARAMS, DOUBAO_VERSION, IMAGE_MODEL_ID, REASONING_LEVELS, SKILL_CARRIER_MODEL_ID,
  STATIC_MODELS, THINKING_BLOCK_TYPE, CREATION_BLOCK_TYPE, inputSkillOf, withImagePrefix,
  isImageModelId, findReasoningLevel,
} from '../lib/core/doubao-catalog.js'
import {
  assembleReplyText, buildChatBody, buildQueryUrl, classifyDoubaoFailure, collectBlocks,
  createBlockCollectState, extractConversationId, extractModel, extractThinking,
  isContentModerationNotice, isRetryableFailure, parseFrames, summarizeQuota, toDoubaoImage,
  DoubaoUpstreamError, CODE_RATE_LIMITED, CODE_SESSION_DEAD,
} from '../lib/core/doubao-upstream.js'
import {
  discoverModels, imageModelPoolModel, levelIdOfLevel, levelOfId, nearestOrdinal, parseBriefListResponse,
  staticModels, toPoolModel,
} from '../lib/core/doubao-discovery.js'
import { buildImagePrompt, buildPrompt, markdownSafeUrl, requestOptions } from '../lib/core/doubao-shim.js'
import { sanitizeFingerprintQuery, fingerprintFromRequest, applyFingerprintHeaders } from '../lib/core/doubao-fingerprint.js'

let passed = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }

/* ------------------------------------------------------------------ 目录 */

test('静态目录不含「工作任务」模型', () => {
  const ids = STATIC_MODELS.map((model) => model.id)
  // 这三个走 Agent-GeneralTask，运行时只在客户端进程里，接上就是每次失败
  for (const id of ['seed-lite-7b', '5', '9']) {
    assert.ok(!staticModels().some((model) => model.id === id), `不应出现 ${id}`)
  }
  assert.ok(ids.includes(IMAGE_MODEL_ID))
})

test('生图别名不声明 vision', () => {
  const image = imageModelPoolModel()
  // 声明 vision 会让 DSH 在带附件时优先选它，然后附件被静默丢掉
  assert.equal(image.vision, false)
  assert.equal(image.id, IMAGE_MODEL_ID)
  assert.equal(image.imageGen, true)
})

test('生图判定容忍前缀与大小写', () => {
  assert.equal(isImageModelId('image-gen'), true)
  assert.equal(isImageModelId('doubao/image-gen'), true)
  assert.equal(isImageModelId('IMAGE-GEN'), true)
  assert.equal(isImageModelId('  image-gen  '), true)
  assert.equal(isImageModelId('image-gen-2'), false)
  assert.equal(isImageModelId(undefined), false)
})

test('生图前缀只加一次', () => {
  assert.equal(withImagePrefix('小猫吃鱼', true), '生成图片：小猫吃鱼')
  assert.equal(withImagePrefix('生成图片：小猫吃鱼', true), '生成图片：小猫吃鱼')
  assert.equal(withImagePrefix('画一张猫', true), '画一张猫')
  assert.equal(withImagePrefix('小猫吃鱼', false), '小猫吃鱼')
})

test('技能是 JSON 字符串且 skill_id 与 skill_type 同值', () => {
  const raw = inputSkillOf('imageGen')
  assert.equal(typeof raw, 'string')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.skill_type, 3)
  assert.equal(parsed.skill_id, '3')
  // 普通对话不带技能位，否则每条消息都被当成生图
  assert.equal(inputSkillOf('freeChat'), undefined)
  assert.equal(inputSkillOf(undefined), undefined)
})

test('思考档位覆盖五档，默认高', () => {
  assert.equal(REASONING_LEVELS.length, 5)
  assert.equal(findReasoningLevel('mid').level, 4)
  assert.equal(findReasoningLevel('不存在').id, 'high')
})

/* ------------------------------------------------------------------ 档位词汇 */

test('档位 id 用 pi-ai 的词汇，不用豆包自己的名字', () => {
  // 之前把 ordinal 4 写成 'mid'，pi-ai 的合法集合里没有它，选「中」会静默发默认档
  const valid = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  for (const level of REASONING_LEVELS) {
    const id = levelIdOfLevel(level.level)
    assert.ok(valid.has(id), `${level.level} → ${id} 不在合法集合里`)
  }
  assert.equal(levelIdOfLevel(3), 'low')
  assert.equal(levelIdOfLevel(7), 'max')
  assert.equal(levelOfId('medium'), 4)
  assert.equal(levelOfId('minimal'), 3)
  assert.equal(levelOfId('max'), 7)
})

test('逐模型档位：菜单给什么就是什么', () => {
  // GLM 只发低/高/最高；补全成五档会让用户选到静默降级的档
  const glm = toPoolModel({
    key: 'glm-x', name: 'GLM', reasoningOptions: [{ level: 3, name: '低' }, { level: 5, name: '高' }, { level: 7, name: '最高' }],
  })
  assert.deepEqual(glm.thinkingOptions.map((option) => option.id), ['low', 'high', 'max'])
  // 菜单给什么 default_level 就用什么，别强行改「高」
  assert.equal(glm.thinkingDefault, 'high')
  const declaredLow = toPoolModel({
    key: '5101', name: 'DeepSeek V4.1 Flash',
    reasoningOptions: [{ level: 3, name: '低' }, { level: 5, name: '高' }],
    defaultLevel: 3,
  })
  assert.equal(declaredLow.thinkingDefault, 'low')
})

test('「豆包 快速」不提供思考旋钮', () => {
  const fast = toPoolModel({ key: '0', name: '豆包 快速' })
  assert.equal(fast.reasoning, false)
  assert.deepEqual(fast.thinkingOptions, [])
})

test('菜单发现：剔掉工作任务、剔掉即将下线、保序去重', () => {
  const payload = {
    data: {
      entry_list: [{
        action_bar_key: 'coco_deep_thinking',
        active_switch_conf: {
          menu_conf_v2: {
            model_list: {
              item_list: [
                { model_item_key: '0', name: '豆包 快速' },
                { model_item_key: '3', name: '豆包 2.1 Turbo', default_mode: '3', reasoning_effort_config: { option_list: [{ level: 4, name: '中' }], default_level: 4 } },
                { model_item_key: '4', name: '豆包 2.1 Turbo（即将下线）' },
                // 实测 default_mode 全是 3，不能拿它判工作任务，否则整目录被剔空
                { model_item_key: '5', name: '工作任务 Pro', default_mode: '3' },
                { model_item_key: '3', name: '重复条目' },
                { model_item_key: 'brand-new', name: '未收录模型' },
              ],
            },
          },
        },
      }],
    },
  }
  const entries = parseBriefListResponse(payload)
  const ids = entries.map((entry) => entry.key)
  // 解析层只做去重与保序；「即将下线 / 工作任务」在 toPoolModel 才剔
  assert.deepEqual(ids, ['0', '3', '4', '5', 'brand-new'])
  assert.equal(entries.find((entry) => entry.key === '5').taskOnly, true)
  // 普通模型即便 default_mode=3 也不算工作任务
  assert.equal(entries.find((entry) => entry.key === '3').taskOnly, false)
  const models = entries.map((entry) => toPoolModel(entry)).filter(Boolean)
  assert.ok(!models.some((model) => model.id === '4'), '即将下线的不进选择器')
  assert.ok(!models.some((model) => model.id === '5'), '工作任务不进选择器')
  // 客户端发现的新模型要原样转发，不能回落成默认
  assert.ok(models.some((model) => model.id === 'brand-new'))
})

test('档位折到模型真实声明过的档', () => {
  // Qwen 4 Max 只发 3/5/6：选「中」(4) 要折到最近的 5，不能发 4
  assert.equal(nearestOrdinal('medium', [3, 5, 6]), 5)
  assert.equal(nearestOrdinal('high', [3, 5, 6]), 5)
  assert.equal(nearestOrdinal('max', [3, 5, 6]), 6)
  assert.equal(nearestOrdinal('low', [3, 5, 6]), 3)
  // 没声明的用一个默认
  assert.equal(nearestOrdinal('high', undefined), 5)
})

test('生图别名永远排在真模型之后', () => {
  const models = discoverModels()
  if (models.length > 1) assert.equal(models[models.length - 1].id, IMAGE_MODEL_ID)
})

/* ------------------------------------------------------------------ 帧解析 */

test('三行帧：event 名要保住', () => {
  const text = [
    'id: 1',
    'event: CHUNK_DELTA',
    'data: {"text":"你"}',
    '',
    'id: 2',
    'event: SSE_REPLY_END',
    'data: {"conversation_id":"c1"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const frames = [...parseFrames(text)]
  assert.equal(frames.length, 3)
  assert.equal(frames[0].event, 'CHUNK_DELTA')
  assert.equal(frames[0].data.text, '你')
  assert.equal(frames[1].data.conversation_id, 'c1')
  assert.equal(frames[2].done, true)
})

test('坏帧不炸：非 JSON 直接跳过', () => {
  const frames = [...parseFrames('data: 不是json\n\ndata: {"a":1}\n\n')]
  assert.equal(frames.length, 1)
})

/* ------------------------------------------------------------------ 块遍历 */

test('文本块与增量块都能收', () => {
  const into = { answer: [], thinking: [], images: [] }
  const state = createBlockCollectState()
  // 真实帧：文本挂在带 block_type 的容器里
  collectBlocks({ block_type: 2001, block_id: 'b1', content: { text_block: { text: '第一段' } } }, into, state)
  collectBlocks({ text: '第二段', id: 'b1' }, into, state)
  assert.equal(into.answer.join(''), '第一段第二段')
})

test('思考块进 thinking，不进 answer', () => {
  const into = { answer: [], thinking: [], images: [] }
  const state = createBlockCollectState()
  collectBlocks({ block_type: THINKING_BLOCK_TYPE, block_id: 't1', content: { text_block: { text: '想一下' } } }, into, state)
  // 同父的增量属于思考
  collectBlocks({ block_type: 2001, block_id: 'b2', parent_id: 't1', content: { text_block: { text: '继续想' } } }, into, state)
  assert.equal(into.thinking.join(''), '想一下继续想')
  assert.equal(into.answer.length, 0)
})

test('生图块收进 images，占位块被跳过', () => {
  const into = { answer: [], thinking: [], images: [] }
  const state = createBlockCollectState()
  collectBlocks({
    block_type: CREATION_BLOCK_TYPE,
    content: {
      creation_block: {
        creations: [
          { image_ori_raw: { url: 'https://x/raw.jpeg', width: 1024, height: 1024 } },
          { image_ori: { url: 'https://x/ori.jpeg' } },
          { placeholder: true },
          { image_thumb: { url: 'https://x/thumb.jpeg' }, image_ori_raw: { url: 'https://x/raw2.jpeg' } },
        ],
      },
    },
  }, into, state)
  assert.deepEqual(into.images.map((image) => image.url), ['https://x/raw.jpeg', 'https://x/ori.jpeg', 'https://x/raw2.jpeg'])
  assert.equal(into.images[0].width, 1024)
})

test('图片嵌在 creation.image 下（真实帧结构）', () => {
  // 实测：creations[].image.{image_thumb, image_ori, image_ori_raw}
  const image = toDoubaoImage({
    type: 1, id: 'x', can_publish: true,
    image: {
      image_thumb: { url: 'https://x/thumb.png' },
      image_ori: { url: 'https://x/ori.png', width: 1024, height: 1024 },
      image_ori_raw: { url: 'https://x/raw.png', width: 2048, height: 2048 },
    },
  })
  assert.equal(image.url, 'https://x/raw.png')
  assert.equal(image.width, 2048)
  // 占位帧没有 URL，必须被跳过
  assert.equal(toDoubaoImage({ type: 1, image: { status: 1, placeholder: { width: 2048, height: 2048 } } }), undefined)
})

test('图片 URL 优先级：无水印原图优先于缩略图', () => {
  const image = toDoubaoImage({
    image_thumb: { url: 'https://x/thumb.jpeg' },
    image_preview: { url: 'https://x/preview.jpeg' },
    image_ori: { url: 'https://x/ori.jpeg' },
    image_ori_raw: { url: 'https://x/raw.jpeg' },
  })
  assert.equal(image.url, 'https://x/raw.jpeg')
  // 没有 raw 就退到 ori，绝不能给缩略图
  assert.equal(toDoubaoImage({ image_thumb: { url: 'https://x/t.jpeg' }, image_ori: { url: 'https://x/o.jpeg' } }).url, 'https://x/o.jpeg')
  assert.equal(toDoubaoImage({ nothing: 1 }), undefined)
})

test('model / thinking / conversation_id 提取', () => {
  assert.equal(extractModel({ message: { model: 'Agent-Chat' } }), 'Agent-Chat')
  assert.equal(extractThinking({ message: { ext: { use_deep_think: '1' } } }), true)
  assert.equal(extractThinking({ message: { ext: { use_deep_think: '0' } } }), false)
  assert.equal(extractConversationId({ data: { conversation_id: 'c9' } }), 'c9')
})

test('通知文本与增量文本不重复', () => {
  assert.equal(assembleReplyText('', '答案'), '答案')
  assert.equal(assembleReplyText('答案', ''), '答案')
  assert.equal(assembleReplyText('答案', '答案后半'), '答案后半')
  assert.equal(assembleReplyText('开头', '后半'), '开头后半')
})

/* ------------------------------------------------------------------ 请求体 */

test('普通对话请求体：messages 是客户端的 content_block 结构', () => {
  const body = buildChatBody('你好', { modelKey: '3', deepThink: true, reasoningLevel: 5, conversationId: 'c1', continueConversation: true })
  // OpenAI 的 {role, content} 服务端不认，必须是 content_block
  assert.deepEqual(Object.keys(body.messages[0]).sort(), ['content_block', 'local_message_id', 'message_status'])
  const block = body.messages[0].content_block[0]
  assert.equal(block.block_type, 10000)
  assert.equal(block.content.text_block.text, '你好')
  assert.equal(body.option.agent_mode, 2)
  // need_deep_think = 10000 + 档位，与 reasoning_effort 同一刻度的两个写法
  assert.equal(body.option.need_deep_think, 10005)
  // 模型/档位要声明三处，只写一处服务端会取默认
  assert.equal(body.option.conversation_init_ext.model_item_key, '3')
  assert.equal(body.option.model_config.model_item_key, '3')
  assert.equal(body.option.aggregate_params.model_item_key, '3')
  assert.equal(body.option.model_config.reasoning_effort, 5)
  assert.equal(body.option.aggregate_params.reasoning_effort, '5')
  // 没有这个开关就没有增量块
  assert.equal(body.option.sse_recv_event_options.support_chunk_delta, true)
  // 深度思考靠 conversation_mode
  assert.equal(body.option.aggregate_params.conversation_mode, '1')
  // 续聊：need_create_conversation 取反 + client_meta 里的 id
  assert.equal(body.option.need_create_conversation, false)
  assert.equal(body.client_meta.conversation_id, 'c1')
  assert.equal(body.ext.use_deep_think, '10005')
})

test('新会话：need_create_conversation 为 true', () => {
  const body = buildChatBody('你好', { modelKey: '3' })
  assert.equal(body.option.need_create_conversation, true)
  assert.equal(body.client_meta.conversation_id, '')
  // 不思考时 conversation_mode 是空串
  assert.equal(body.option.aggregate_params.conversation_mode, '')
  assert.equal(body.option.need_deep_think, 0)
})

test('生图请求体：技能位 + 不复用会话 + 前缀', () => {
  const body = buildChatBody('小猫吃鱼', { modelKey: IMAGE_MODEL_ID, skill: 'imageGen', conversationId: 'c1', continueConversation: true, deepThink: true, reasoningLevel: 5 })
  assert.equal(typeof body.ext.input_skill, 'string')
  assert.equal(JSON.parse(body.ext.input_skill).skill_type, 3)
  // 生图轮强制开新会话：同一 conversation 里第二次生图会拿到上一轮图的占位
  assert.equal(body.option.need_create_conversation, true)
  assert.equal(body.client_meta.conversation_id, '')
  const text = body.messages[0].content_block[0].content.text_block.text
  assert.equal(text, '生成图片：小猫吃鱼')
})

test('客户端身份参数拼全', () => {
  const url = new URL(buildQueryUrl('https://www.doubao.com/chat/completion'))
  assert.equal(url.searchParams.get('aid'), CLIENT_PARAMS.aid)
  assert.equal(url.searchParams.get('pc_version'), DOUBAO_VERSION)
  assert.equal(url.searchParams.get('device_id'), CLIENT_PARAMS.device_id)
})

test('不需要思考时 need_deep_think 为 0', () => {
  const body = buildChatBody('你好', { modelKey: '0' })
  assert.equal(body.option.need_deep_think, 0)
  assert.equal(body.ext.use_deep_think, '0')
  // 档位仍要发（服务端读它），只是开关是关的
  assert.equal(body.option.model_config.reasoning_effort, 5)
})

/* ------------------------------------------------------------------ 请求选项 */

test('生图请求解析：载体模型与关思考', () => {
  const options = requestOptions({ model: IMAGE_MODEL_ID, reasoning_effort: 'high' })
  assert.equal(options.isImageTurn, true)
  assert.equal(options.skill, 'imageGen')
  // 生图轮走 app 默认载体档
  assert.equal(options.modelKey, SKILL_CARRIER_MODEL_ID)
  assert.equal(options.deepThink, false)
})

test('「豆包 快速」请求不请求深度思考', () => {
  const options = requestOptions({ model: '0', reasoning_effort: 'max' })
  assert.equal(options.deepThink, false)
  assert.equal(options.reasoningLevel, 7)
})

test('reasoning_effort 的 pi 拼写折到豆包 ordinal', () => {
  assert.equal(requestOptions({ model: '3', reasoning_effort: 'minimal' }).reasoningLevel, 3)
  assert.equal(requestOptions({ model: '3', reasoning_effort: 'medium' }).reasoningLevel, 4)
  assert.equal(requestOptions({ model: '3', reasoning_effort: 'xhigh' }).reasoningLevel, 6)
  // 没给就默认高
  assert.equal(requestOptions({ model: '3' }).reasoningLevel, 5)
})

/* ------------------------------------------------------------------ prompt */

test('生图 prompt 只取最后一条干净用户消息', () => {
  const messages = [
    { role: 'system', content: 'Current runtime context\nCurrent working directory: /x' },
    { role: 'user', content: '画一只猫' },
    {
      role: 'user',
      content: 'Current runtime context\nTime sampled while preparing turn: 2026-11-28\n画一只吃鱼的猫',
    },
  ]
  // 框架文字会被画进图里，也会让请求卡住
  assert.equal(buildImagePrompt(messages), '画一只猫')
})

test('生图 prompt：框架块（<…> / […]）被跳过', () => {
  const messages = [
    { role: 'user', content: '一只柴犬' },
    { role: 'user', content: '<system-reminder>别画这个</system-reminder>' },
  ]
  assert.equal(buildImagePrompt([{ role: 'user', content: '一只柴犬' }, { role: 'user', content: '<x>' }]), '一只柴犬')
  assert.equal(buildImagePrompt(messages), '一只柴犬')
})

test('生图 prompt：全是框架时兜底最后一条', () => {
  const messages = [{ role: 'user', content: 'Current working directory: /x' }]
  assert.equal(buildImagePrompt(messages), 'Current working directory: /x')
  assert.equal(buildImagePrompt([]), '')
})

test('普通 prompt 保留 transcript 与角色标记', () => {
  const prompt = buildPrompt([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ])
  assert.equal(prompt, '[system] 你是助手\n\n你好')
})

test('分段 content 展平', () => {
  assert.equal(buildPrompt([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]), 'a\nb')
})

/* ------------------------------------------------------------------ URL 转义 */

test('Markdown 图片 URL 里的括号与波浪号要编码', () => {
  // 裸括号会截断 ![](...) 语法，图片直接不显示
  assert.equal(markdownSafeUrl('https://x/a(1).jpeg'), 'https://x/a%281%29.jpeg')
  assert.equal(markdownSafeUrl('https://x/~tplv.jpeg'), 'https://x/%7Etplv.jpeg')
  assert.equal(markdownSafeUrl('a b.jpeg'), 'a%20b.jpeg')
})

/* ------------------------------------------------------------------ 额度 */

test('额度：套餐窗口折成 remaining/total', () => {
  const quota = summarizeQuota({
    product_line: 'membership',
    window_limit_section: {
      usage_exhausted: false,
      window_limit_groups: [{
        window_limits: [{
          window_type: 4, window_limit: 1000, remaining_percent: 62, window_end: 1_800_000_000,
        }],
      }],
    },
    incentive_quota_section: {
      usage_exhausted: true,
      window_limit_groups: [{ window_limits: [{ window_type: 3, window_limit: 100, remaining_percent: 0 }] }],
    },
  })
  assert.equal(quota.total, 1000)
  assert.equal(quota.remaining, 620)
  assert.equal(quota.remainingPercent, 62)
  // 套餐还有额度，不能因为有 section 用尽就整体标红
  assert.equal(quota.exhausted, false)
  assert.equal(quota.resetAtMs, 1_800_000_000_000)
  assert.equal(quota.windows.length, 2)
})

test('额度：所有 section 都用尽才算用尽', () => {
  const quota = summarizeQuota({
    window_limit_section: { usage_exhausted: true, window_limit_groups: [{ window_limits: [{ window_type: 4, window_limit: 10, remaining_percent: 0 }] }] },
    incentive_quota_section: { usage_exhausted: true, window_limit_groups: [] },
  })
  assert.equal(quota.exhausted, true)
  assert.equal(quota.remaining, 0)
})

test('额度：没有 section 不算用尽', () => {
  const quota = summarizeQuota({})
  assert.equal(quota.exhausted, false)
  assert.equal(quota.remaining, null)
})

/* ------------------------------------------------------------------ 失败 */

test('710022004 是风控，不可重试', () => {
  const error = new DoubaoUpstreamError('风控', CODE_RATE_LIMITED, true)
  assert.equal(classifyDoubaoFailure(error), 'rate_limited')
  // 重试只会加重风控并白烧额度
  assert.equal(isRetryableFailure(error), false)
})

test('登录态失效分类', () => {
  assert.equal(classifyDoubaoFailure(new DoubaoUpstreamError('x', CODE_SESSION_DEAD)), 'session_dead')
  assert.equal(classifyDoubaoFailure(new DoubaoUpstreamError('x', '', false, { status: 401 })), 'session_dead')
  assert.equal(classifyDoubaoFailure(new DoubaoUpstreamError('x', '', false, { transport: true })), 'network')
  assert.equal(classifyDoubaoFailure(new DoubaoUpstreamError('x', '', false, { status: 500 })), 'upstream')
})

test('只有传输层/5xx 可重试', () => {
  assert.equal(isRetryableFailure(new DoubaoUpstreamError('x', '', false, { transport: true })), true)
  assert.equal(isRetryableFailure(new DoubaoUpstreamError('x', '', false, { status: 503 })), true)
  // 截断的流重试等于丢掉半个答案开新会话
  assert.equal(isRetryableFailure(new DoubaoUpstreamError('x', '', false, { status: 429 })), false)
  assert.equal(isRetryableFailure(new Error('普通错误')), false)
})

test('审核通知识别', () => {
  const notice = '该内容涉嫌违反平台使用规范，长按本条消息 →「反馈与举报」。'
  assert.equal(isContentModerationNotice(notice), true)
  // 模型解释审核是在回答，不是通知
  assert.equal(isContentModerationNotice('豆包的内容审核比较严格，建议换个说法。'), false)
  assert.equal(isContentModerationNotice(''), false)
})

/* ------------------------------------------------------------------ 指纹 */

test('指纹：剔掉易变参数', () => {
  const query = sanitizeFingerprintQuery('aid=582478&device_id=1&ms_token=abc&a_bogus=x&timestamp=9')
  assert.equal(query.aid, '582478')
  assert.equal(query.device_id, '1')
  assert.equal(query.ms_token, undefined)
  assert.equal(query.a_bogus, undefined)
})

test('指纹：非豆包域 / 缺 aid / 缺 UA 都不采信', () => {
  assert.equal(fingerprintFromRequest('https://evil.com/x?aid=1', { 'user-agent': 'x' }), undefined)
  assert.equal(fingerprintFromRequest('https://www.doubao.com/x?device_id=1', { 'user-agent': 'x' }), undefined)
  assert.equal(fingerprintFromRequest('https://www.doubao.com/x?aid=1', {}), undefined)
  const ok = fingerprintFromRequest('https://www.doubao.com/x?aid=582478&device_id=7', {
    'user-agent': 'UA/147', referer: 'https://www.doubao.com/chat/', 'sec-ch-ua': '"Chromium";v="147"',
  })
  assert.equal(ok.userAgent, 'UA/147')
  assert.equal(ok.query.device_id, '7')
})

test('指纹套到出站头：platform 提示与 UA 一致', () => {
  const headers = applyFingerprintHeaders({}, { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/147', referer: 'r' })
  assert.equal(headers['sec-ch-ua-platform'], '"macOS"')
  const win = applyFingerprintHeaders({}, { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', referer: 'r' })
  assert.equal(win['sec-ch-ua-platform'], '"Windows"')
})

/* ------------------------------------------------------------------ 跑 */

for (const [name, fn] of cases) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error.message}`)
    process.exitCode = 1
  }
}
if (process.exitCode !== 1) console.log(`✓ doubao: ${passed} 项全部通过`)
else console.log(`doubao: ${passed}/${cases.length} 通过`)
