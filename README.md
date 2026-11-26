# 魔桥 · dsh-connect-model-gateway

把 WorkBuddy、华为云 CodeArts、Meoo 秒悟、SCNet、WPS 灵犀、商汤小浣熊接进 DeepSeek Harness（DSH），在 DSH 里直接调用这些平台的模型。

包名 `dsh-connect-model-gateway`，设置页入口名为「魔桥」。

## 功能

- **统一登录与账号池**：每个平台单独登录，支持多个账号，手动切换当前账号。切换后余额与推理立即走新账号。
- **积分余额**：当前账号 30 秒刷新一次，其他账号 5 分钟一次。只显示剩余值，不显示分母；取不到余额的模型显示「未知」。
- **定时探活**：每 5 分钟对当前账号做一次真网络检查（CodeArts 打签名 GET `current/user`，SCNet 打 `current-user-info`）；掉登录自动续期或从磁盘重读 keeper 已更新的凭证，不用等推理失败才发现「未登录」。
- **模型目录与开关**：启动和每小时各拉一次上游模型目录。模型默认不勾选，勾选过的才进 DSH 选择器；可逐模型设置上下文窗口、图片输入、思考档位。
- **自动签到**：每小时检查一次，每个账号每天签一次；支持单个补签和一键全部签到，失败按退避重试。
- **会话区账号胶囊**：当前会话选中魔桥的模型时，输入框旁显示「账号名 · 剩余积分」。渠道有多个账号时尾部带「切换」，点开列出该渠道全部账号与各自积分，点击即切换（对所有会话生效）。选中其他 provider 的模型时不显示。
- **多平台并存**：六个 provider 各自注册，同一对话里可以分别选不同平台的模型，互不干扰。
- **不占用其他插件的槽位**：模型行显示由 DSH 原生组件负责，本插件不注册 `conversation.input.model.label`。

## 安装

```sh
# npm 上架后
dsh plugin add dsh-connect-model-gateway

# 从仓库安装
dsh plugin add github:JackLeo/dsh-connect-model-gateway

# 本地目录
dsh plugin --profile desktop add /绝对路径/dsh-connect-model-gateway
```

包内需要 `package.json`、`lib/`、`cordis.patch.yml`。浏览器半边由 `package.json` 的 `dsh.client` 声明，经 `exports["./client"]` 提供。

## 使用

1. 打开 DSH 设置 → 魔桥。
2. 在对应平台页签里点登录，按各平台要求完成授权（扫码、OAuth、短信验证码或独立浏览器窗口）。
3. 在「模型」里勾选要用的模型。默认一个都不勾。
4. 新建对话，provider 选相应平台，再选模型。

账号与模型开关保存在 `~/.dsh/model-pool/<provider>.json`，原子写，权限 `0600`。卸载插件不会删除这些文件。

## 支持的平台

| 平台 | provider 键 | 登录方式 | 积分 | 签到 |
|---|---|---|---|---|
| WorkBuddy（腾讯 CodeBuddy） | `workbuddy` | 读桌面客户端凭证，或浏览器登录一次 | 剩余 / 总额 / 套餐 / 周期 | 每日签到，连续天数 |
| CodeArts（华为云） | `codearts` | 华为云 OAuth2 PKCE + DPoP | 剩余额度 | 每日领取 |
| Meoo 秒悟 | `meoo` | 浏览器 OAuth(PKCE)，或粘 `meoo_ak_…` API Key | 剩余积分 | 登录即送 2000/天，只检测不代领 |
| SCNet | `scnet` | 手机号 + 短信验证码 | 无余额接口、不扣积分，显示 ♾️ 不限量 | 无 |
| WPS 灵犀 | `lingxi` | 独立临时浏览器窗口登录，插件只读 `wps_sid` | 智点，15 天内过期提示 | 任务领取 |
| 商汤小浣熊 | `raccoon` | 独立临时浏览器窗口，微信扫码登录 | 可用积分 | 无 |

provider 键沿用旧插件的值，改名时未改动，已有会话的模型引用继续有效。

## 架构

六个平台的登录、余额、目录、签到、设置页各实现一次，平台差异收敛在适配器层。适配器无状态：凭证由 manager 传入，数据返回；账号池、切换、持久化在 `lib/core/manager.js`。

```
DSH 对话窗口
   │  OpenAI /chat/completions 格式, Bearer=<本进程随机密钥>
   ▼
魔桥本地 shim（127.0.0.1:随机端口，仅 CodeArts / WorkBuddy / 灵犀）
   │  补签名 / 改信封 / SSE 翻译
   ▼
各平台推理端点
```

shim 只监听回环地址，校验 Host 与进程随机密钥，进程退出即关闭。

```
lib/
  index.js                  Host：provider 注册、模型清单重建、刷新与签到调度、HTTP 路由
  client.js                 浏览器：设置页「魔桥」与会话区积分胶囊
  core/adapter.js           适配器契约
  core/manager.js           账号池、当前账号、模型开关、刷新与签到
  core/state.js             每平台状态落盘（原子写，0600）
  core/host-peers.js        宿主包运行期解析（app.asar 回退）
  core/huawei-signer.js     华为云 SDK-HMAC-SHA256 签名
  core/shim.js              CodeArts 本地转发端点（补 AK/SK 签名）
  core/workbuddy-shim.js    WorkBuddy 本地转发端点（信封归一化 + 重试阶梯）
  core/lingxi-shim.js       灵犀三步握手 + SSE 翻译
  core/retry-fetch.js       SCNet 四类抖动归一化 + context 净化
  adapters/raccoon.js       小浣熊适配器（直连网关，浏览器扫码登录）
  adapters/*.js             每平台一个无状态适配器
```

### 加一个新平台

实现 `lib/core/adapter.js` 的接口，最少 `key`、`displayName`、`discoverNative()`、`probe(credential)`、`listModels(credential)`、`chatBase(credential)`；`quota`、`checkIn`、`refresh` 按平台能力选实现。然后在 `lib/index.js` 的 `specs` 数组里加一行。没实现 `checkIn` 的平台会被签到调度器跳过。

## 接入细节

以下端点记录来自客户端实际请求。

### WorkBuddy

| 用途 | 端点 |
|---|---|
| 登录态 | 读桌面客户端写的凭证文件，不做独立 OAuth |
| 推理 | `POST https://copilot.tencent.com/v2/chat/completions`（OpenAI 兼容，直连） |
| 模型目录 | `GET https://www.codebuddy.cn/v2/enterprises/personal/models` |
| 积分 | `POST /v2/billing/meter/get-user-resource` |
| 签到 | `POST /v2/billing/meter/daily-checkin` |
| 续期 | `POST {chatBase}/v2/plugin/auth/token/refresh` |

macOS 凭证路径：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`。续期结果不回写客户端文件，另存 `~/.dsh/model-pool/workbuddy-state.json`。倍率取目录里的 `credits`。上下文取 `contextWindow.defaultLength`（300K）；`maxInputTokens` 是上游可支持上限（1M），用它会让上下文计量条失真。

### CodeArts

| 用途 | 端点 |
|---|---|
| 登录 | 华为云 OAuth2 PKCE + DPoP |
| 推理 | `POST https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions` |
| 模型目录 | `GET /v1/model/builtin`，必须带 `Agent-Type: PromptCenter` |
| 积分 | `GET /snap-manager/v1/statistics/plugin` → `usageTotalPackageCredit` |
| 签到 | `POST https://opengw.developer.huaweicloud.com/api/v1/benefit/claim` |

推理必须带华为云 AK/SK 签名（`SDK-HMAC-SHA256`），只给 `x-auth-token` 会被 APIG 拒；pi-ai 只发 Bearer，因此走本地 shim 补签。`refresh_token` 与 DPoP 私钥绑定，续期必须用同一把私钥。保活子进程盯本插件的账号文件，不是旧插件那份。

### Meoo 秒悟

| 用途 | 端点 |
|---|---|
| 登录 | 浏览器 OAuth(PKCE)，或粘 `meoo_ak_…` API Key |
| 推理 | `POST https://api.meoo.host/meoo-ai/compatible-mode/v1/chat/completions`（直连） |
| 模型目录 | `GET https://meoo.com/api/v1/agent/models` 优先，`GET {gateway}/models` 兜底 |
| 积分 | `GET /open/v1/cli-compat/account/points` → `account.availableBalance` |
| 网关凭证 | `GET .../projects/{id}/cloud/environment` → `meooProjectApiKey`，空则自动开通一次 |

网关 Bearer 只认项目服务 AK，控制面 API Key 打网关回 `401 SERVICE_AK_FORMAT_INVALID`，插件自动转换。富目录的 id 取 `modelsValue[key]`（网关 id），用 `key` 会 404。业务错误可能包在 HTTP 200 里（`success:false`），不能只看 `res.ok`。手填项目服务 AK 读不到积分，胶囊显示「未知」。无签到接口。

### SCNet

| 用途 | 端点 |
|---|---|
| 登录 | 手机号 + 短信验证码（图形验证码可留空，前端有带盐签名兜底） |
| 推理 | `POST https://api.scnet.cn/api/llm/v1/chat/completions`（直连） |
| 模型目录 | `GET {base}/models` + `~/.sclaw/agent/models.json`（元数据） |
| 积分 | 无余额接口，显示「未知」 |
| 签到 | 无 |

上下文实测 1,048,576（973k tokens 能过，1.07M 回 400/10013）。`core/retry-fetch.js` 归一了四类抖动：5xx + invalid_request、400 + 10013 一次性自愈、SSE 中断、`system.sections` undefined。模型没有倍率字段，只有 `priceLabel: 'free'`，界面写「限时免费」。

### WPS 灵犀

| 用途 | 端点 |
|---|---|
| 登录 | 独立临时 profile 浏览器，用户自己登录，插件只读 `wps_sid` cookie |
| 推理 | 本地 shim：建会话 → 领 run → `chat/completions` SSE 翻译 |
| 模型目录 | `GET /api/aioffice/v1/sessions/plans`（倍率、上下文、多模态、思考档） |
| 积分 | `GET /api/public/v1/credits/balance`（智点） |
| 签到 | `GET /api/public/v1/tasks` + `POST /tasks/{key}/claim`，领过不算失败 |

SSE 正文在 `choices[].text`，不是 `delta.content`，也没有 `[DONE]`，tool_calls 按 index 聚合。请求体需归一：分段 content 展平成字符串，对象形式的 `tool_choice` 转成字符串，否则 400 InvalidArgument。

### 商汤小浣熊

| 用途 | 端点 |
|---|---|
| 登录 | 微信扫码。插件起一个临时 profile 浏览器打开 `https://xiaohuanxiong.com/login?product_code=work&redirect_url=…`，扫码后跳回工作台，二维码由小浣熊页面自己渲染，登录完成后插件读回 `access_token` |
| 推理 | `POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions`（OpenAI 兼容，直连） |
| 模型目录 | `GET /api/web/llm/v2/model_catalog` → `data.categories[type=chat].models[]` |
| 积分 | `GET /api/web/points/v1/balance` → `data.available_points` |
| 签到 | 无 |

请求头要带 `X-Org-Code: ''`（个人版正常值）、`X-Raccoon-Language: zh`、`X-Client-Platform: web`，认证是 `Authorization: Bearer <access_token>`；只带 cookie 不带 Bearer 会回 `200001 authorization_empty_error`。

登录接口 `POST /api/iam/v1/auth/mp/qrcode` 返回的 `scan_path` 是 `/login/mp`，是微信小程序页面路径，不是图片地址也不是 H5 落地页 —— 用它拼 URL 的三种写法都 404，抓包里也没有图片响应。小程序码只能由微信服务端生成，插件画不出来，所以走浏览器方案，二维码交给小浣熊自己的页面。

网页版登录只返回 `access_token`，**没有 refresh_token**，实测有效期 30 天（`exp - iat = 720h`），旧插件文档写的 3 小时是桌面端口径。因此不做静默续期，过期后重新扫码即可。

token 还跟登录会话绑定：同一个账号在别处重新登录（或网页端刷新了会话）之后，旧 token 会立刻变成 `401 200003 authorization_verify_error`，不是等到 `exp` 才失效。所以「未到期」不等于「还能用」，`probe` 以真实请求结果为准。

目录里 `visible: false` 的 `raccoon-xxxxxx` 是 App 内建路由位，不是能对话的模型，过滤掉。倍率取 `billing_effective_multiplier`（促销时用折后价），`billing_status: limited_free` 且倍率为 0 的显示「限时免费」。模型识图能力按实测结论写死：GLM-5.3 目录标着 vision 却看不了图，GLM-5.3-Flash 与 DeepSeek-V4.1-Flash 没标却能看。

业务错误码按 HTTP 语义归一：会话失效 `200001/200003/200822` → 401，额度耗尽 `200402/200429/100402` → 402，限流文案 → 429。上游多数失败是 400 加业务码，先读 code 再看 status。

## 已知限制

- 六个平台都没有公开 API，本插件调用的是客户端和网页在用的私有接口。上游改动会导致对应平台失效；修复取决于社区跟进。
- 自动签到、token 续期、多账号切换、复用浏览器 cookie 可能被平台识别为非官方客户端，后果从重新登录到停号、清积分不等。企业版 / 教育版席位的权益规则另算。
- 账号与凭证明文存放在 `~/.dsh/model-pool/*.json`（`0600`）。不要同步到网盘，不要在公用机器上使用。插件没有后端，不上传凭证。
- 推理按各平台倍率扣使用者账号的积分，签到奖励不可撤销。不自动换号，不跨模型 failover。
- 各平台积分单位不同，界面按各自原值显示，不做换算。
- CodeArts、WorkBuddy、灵犀在 `127.0.0.1` 起临时转发端点，随机 bearer + Host 校验，进程退出即关闭；同机同用户的其他进程理论上可访问。
- 适配器互相独立，一家失效不会拖垮其他平台；上游改接口需按平台逐个跟进。
- 小浣熊网页登录态有效期 30 天且没有 refresh_token，只能重新扫码；登录用的临时浏览器窗口在插件设置页点「扫码登录」时拉起，卸载插件会把残留窗口和临时 profile 一起收掉。

## 免责声明

- 本项目仅供个人学习和研究使用，只驱动使用者自己的账号在本机调用，请勿用于商业用途。
- 使用者需遵守各平台的服务条款；因使用本项目产生的账号限制、服务中断等后果由使用者自行承担。
- 本项目与 WorkBuddy / 腾讯、华为云 CodeArts、Meoo 秒悟、SCNet、WPS 灵犀、商汤小浣熊 / 商汤均无关联，未获授权或认可；文中出现的名称仅用于描述兼容关系，商标权利归各自所有。
- 项目按 MIT 许可证发布，不提供保修。

## 致谢

各平台的协议、踩坑记录和关键算法来自以下开源项目，多处以注释标明出处：

| 平台 | 项目 | 采用的内容 |
|---|---|---|
| WorkBuddy | [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | 渠道校验正文改写与重试阶梯（`workbuddy-gate.js` / `workbuddy-wire.js` 逐字移植）、失败分类到 HTTP 码、官方请求头、促销徽标解析 |
| CodeArts | [elegant01/dsh-codearts](https://github.com/elegant01/dsh-codearts) | OAuth2 PKCE + DPoP、AK/SK 签名、签到端点纠偏、DPoP 私钥复用续期、账号文件格式兼容 |
| Meoo 秒悟 | [xinstart-1/dsh-connect-meoo](https://github.com/xinstart-1/dsh-connect-meoo) | 浏览器 OAuth(PKCE) 登录、API Key 转项目服务 AK、富目录 id 取值规则 |
| SCNet | [Phoeky/dsh-scnet-connect](https://github.com/Phoeky/dsh-scnet-connect) | 手机号+验证码登录、SCNet-Max 基座实测结论、四类请求抖动归一化 |
| WPS 灵犀 | [xinstart-1/dsh-connect-lingxi](https://github.com/xinstart-1/dsh-connect-lingxi) | 独立浏览器 profile 登录、三步握手与 SSE 翻译、请求体归一 |
| 商汤小浣熊 | [zhlcba/dsh-raccoon-connect](https://github.com/zhlcba/dsh-raccoon-connect) | 上游协议实测记录（`docs/upstream-protocol.md`）、错误码分类、模型识图实测结论、目录 `billing_*` 字段解析 |

以上项目均为 MIT 开源。相关算法和实测结论的著作权归各自原作者。

## 许可证

MIT。见 [LICENSE](./LICENSE)。
