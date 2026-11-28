/**
 * 豆包目录与协议常量。
 *
 * 这份文件是「豆包到底有哪些模型、每个模型能想多深、生图叫什么」的唯一出处。
 * 事实来源两处，都已实测核对：
 * 1. 桌面客户端的 `menuConfV2.model_list.item_list`（走 brief_list 接口取回）；
 * 2. 本机真实请求（`input_skill: {skill_type:3}` → `rc_gen_image/*.jpeg`）。
 *
 * 三层结构（照搬旧插件 dsh-connect-doubao 的结论，别重新发明）：
 * - 「模型」是 `model_item_key`，字符串原样转发，绝不能 parse 成数字（值是
 *   slug 和数字枚举混着的）；
 * - 「思考档位」是 `reasoning_effort`，豆包只有低/中/高/极高/最高（3/4/5/6/7），
 *   且**每个模型自己的菜单才是权威**——GLM 只发低/高/最高，共用一套必错一个；
 * - 「技能」是正交轴：`input_skill` 带 `skill_type: 3` 就是生图，仍然走 chat 端点。
 *
 * @module dsh-connect-model-gateway/core/doubao-catalog
 */

/** provider 路由键。沿用旧插件的值，Auto 候选与已有会话引用继续有效。 */
export const KEY = 'doubao'
export const DISPLAY_NAME = '豆包'

export const CHAT_ENDPOINT = 'https://www.doubao.com/chat/completion'
export const QUOTA_ENDPOINT = 'https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/'
export const ACCOUNT_ENDPOINT = 'https://www.doubao.com/passport/account/info/v2/'
export const ACTION_BAR_BRIEF_LIST_ENDPOINT = 'https://www.doubao.com/alice/slot/action_bar_v3/brief_list'

/**
 * 客户端版本串。这是最后一次核对时的桌面版构建号，会随豆包每次发版变化。
 * 风控层会拿它跟会话对齐；豆包自动更新后要重新核对这里。
 */
export const DOUBAO_VERSION = '2.31.4'
export const RUNTIME_VERSION = '3.39.0'

/**
 * 冻结的、非机密的客户端身份。
 *
 * 这些值跨会话恒定，**不是凭据**。固定它们，才让外部请求看起来是同一个安装。
 */
export const CLIENT_PARAMS = {
  aid: '582478',
  real_aid: '582478',
  version_code: '20800',
  pc_version: DOUBAO_VERSION,
  device_id: '2697515174213273',
  tea_uuid: '2697515174213273',
  web_id: '7677868049198630415',
  fp: 'verify_2697515174213273',
  chromium_version: '147.0.7727.149',
  runtime_version: RUNTIME_VERSION,
  channel: 'win',
  language: 'zh',
  region: 'CN',
  sys_region: 'CN',
  tz_name: 'Asia/Shanghai',
  pkg_type: 'release_version',
  client_platform: 'pc_client',
  device_platform: 'web',
  doubao_device_platform: 'desktop',
  web_platform: 'desktop',
  samantha_web: '1',
  'use-olympus-account': '1',
}

/** 默认助手；内容路由由服务端决定，所以这是一个固定 bot。 */
export const DEFAULT_BOT_ID = '7338286299411103781'

/** `option.agent_mode`：2 = 普通对话，1 = 「工作任务」。 */
export const CHAT_AGENT_MODE = 2

export const CONTEXT_WINDOW = 128_000
export const MAX_TOKENS = 8_192

/**
 * 生图是**DSH 侧的能力别名**，不是豆包的 `model_item_key`。
 *
 * 豆包没有叫这个名字的模型。选中它的真实动作是：发一条普通 chat，但带
 * `input_skill: {skill_id:"3", skill_type:3}`，豆包回 `creation_block`（2074）
 * 里的真图（Seedream）。把它放进目录，只是让「生图」出现在模型选择器里，
 * 而不必另造一套 UI。
 */
export const IMAGE_MODEL_ID = 'image-gen'
export const IMAGE_MODEL_NAME = '豆包 生图（Seedream）'
/** 生图轮骑的载体模型：app 自己的默认档。 */
export const SKILL_CARRIER_MODEL_ID = '0'

/** 生图块（`content.creation_block`）的 block_type。 */
export const CREATION_BLOCK_TYPE = 2074
/** 深度思考容器块的 block_type。 */
export const THINKING_BLOCK_TYPE = 10040

/** 技能枚举。`skill_id` 是 `skill_type` 的十进制字符串，两者永远同值。 */
export const DOUBAO_SKILLS = {
  freeChat: 0,
  write: 2,
  imageGen: 3,
}

/** 技能 → `ext.input_skill` 的 JSON 字符串；undefined 表示普通对话。 */
export function inputSkillOf(skill) {
  if (skill === undefined || skill === 'freeChat') return undefined
  const type = DOUBAO_SKILLS[skill]
  if (typeof type !== 'number') return undefined
  return JSON.stringify({ skill_id: String(type), skill_type: type, variables: {} })
}

/**
 * 思考档位。`level` 就是豆包的 `reasoning_effort`，也是
 * `need_deep_think - 10000`，不是两套刻度。
 */
export const REASONING_LEVELS = [
  { id: 'low', name: '低', level: 3 },
  { id: 'mid', name: '中', level: 4 },
  { id: 'high', name: '高', level: 5 },
  { id: 'xhigh', name: '极高', level: 6 },
  { id: 'max', name: '最高', level: 7 },
]

/** 没指定时用「高」，与客户端自己启动时的档位一致。 */
export const DEFAULT_REASONING_LEVEL = 'high'

/**
 * 实测永远不会思考的模型。
 *
 * 「豆包 快速」由无 CoT 的 agent 服务：深度思考开关打开、档位拉到高，
 * 回复里依然 `thinking: false` 且没有任何 10040 容器。所以必须在**发现之后**
 * 再套这一层，否则选择器会一直摆一个不起作用的旋钮。
 */
export const NO_THINKING_MODEL_IDS = new Set(['0'])

/** 客户端已用「即将下线」标注，不引导用户选择。 */
export const UNAVAILABLE_MODEL_IDS = new Set(['4'])

/**
 * 静态目录：接口拿不到时用它，保证首次可用不为空。
 *
 * 「豆包 快速」排第一，因为它是 app 自己的对话默认档；未配置的安装因此复现
 * 的是客户端行为，而不是「恰好能用」的某个模型。
 */
export const STATIC_MODELS = [
  { id: '0', name: '豆包 快速', reasoning: false },
  { id: '3', name: '豆包 2.1 Turbo', badge: '专家', reasoning: true },
  { id: 'seed-lite-7b', name: '豆包 2.1 Lite', badge: '工作任务', reasoning: true, taskMode: true },
  { id: '5', name: '豆包 2.1 Pro', badge: '工作任务', reasoning: true, taskMode: true },
  { id: '9', name: '自动', badge: '工作任务', reasoning: true, taskMode: true },
  { id: IMAGE_MODEL_ID, name: IMAGE_MODEL_NAME, reasoning: true },
]

/** 默认模型：豆包 快速。显式写死，避免重排列表就悄悄改了默认。 */
export const DEFAULT_MODEL_ID = '0'

export function findReasoningLevel(id) {
  return REASONING_LEVELS.find((level) => level.id === id)
    ?? REASONING_LEVELS.find((level) => level.id === DEFAULT_REASONING_LEVEL)
}

/**
 * 目录条目，查不到就回落默认模型。
 *
 * 未收录的 id 也原样返回：客户端菜单在插件发布之后加了新模型，那个 key 是
 * 真的，转发它是唯一诚实的做法——回落成默认会把用户选的模型换掉。
 */
export function findModel(id) {
  if (id === undefined || id === '') return STATIC_MODELS.find((model) => model.id === DEFAULT_MODEL_ID)
  const known = STATIC_MODELS.find((model) => model.id === id)
  if (known !== undefined) return known
  return { id, name: id, reasoning: true }
}

export function isKnownModelId(id) {
  return STATIC_MODELS.some((model) => model.id === id)
}

/** 一旦带上生图技能，`prompt` 需要「生成图片：」前缀，否则上游回散文不画图。 */
export function withImagePrefix(prompt, isImageTurn) {
  if (!isImageTurn) return prompt
  if (/^\s*(生成图片|生成一张|画一张|画个|绘制)/.test(prompt)) return prompt
  return `生成图片：${prompt}`
}

/** 生图能力判定的宽度：容忍 `doubao/image-gen` 这类带前缀写法与大小写。 */
export function isImageModelId(model) {
  if (typeof model !== 'string' || model === '') return false
  const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return tail.trim().toLowerCase() === IMAGE_MODEL_ID
}
