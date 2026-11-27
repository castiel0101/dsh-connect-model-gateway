/**
 * dsh-connect-model-gateway —— 浏览器半边。
 *
 * 布局：平台页签 → 平台面板（余额 / 账号 / 模型 / 签到）。
 * 配色刻意朴素：黑白灰为主，只有状态点用语义色，避免和宿主主题抢眼。
 *
 * @module dsh-connect-model-gateway/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-model-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    /**
     * SCNet-Max 基座说明 —— 内容照录 dsh-scnet-connect README 的「基座认定」章节
     * （作者实测记录，MIT）。这里只做展示，结论与残留不确定性都原样保留。
     */
    const SCNET_BASIS = {
      title: 'SCNet-Max 的基座是什么',
      summary:
        '平台目录里 SCNet-Max 的说明只有四个字，没有基座标注。旧插件（dsh-scnet-connect）做过一组可复现的实测，对比对象是 DeepSeek-V4.1-Flash-1017。',
      conclusion:
        '可以确定：tokenizer、chat template、知识边界、确定性输出全部一致，属同一模型。\n不能确定：究竟是 1017，还是更早的 0910 子版本 —— DeepSeek 历代模型共用同一 tokenizer。',
      evidence: [
        {
          head: '证据一 · 分词器与对话模板一致',
          body: '22 个探针的 prompt_tokens 逐项相同：基准串 "Hi" 两侧都是 31 token，中文 36、阿拉伯语 40、印地语 47、泰语 43、韩语 41、家庭 emoji 52、旗帜 emoji 46、4 字节 CJK 43、零宽字符+组合音标 39、代码块 44、base64 66、JSON 41、400 个 ASCII 80、200 个「中」230。',
        },
        {
          head: '证据二 · temperature=0 下逐字输出',
          body: '8 道确定性短题里 7 道字节级完全相同（JSON、1到5、大小写、斐波那契、3的5次方、字符串反转、闰年判断）。唯一不同的自由论述题，在 temperature=0.7 复测时两侧各采样出完全相同的一整句 —— 跨两个网关撞出整句相同的汉语，基本排除「不同模型」。',
        },
        {
          head: '证据三 · 知识边界重合',
          body: 'Gemini 3 发布（2025-11-18）、GPT-5 发布（2025-08-07）、Claude 4 发布（2025-05-22）、2026 春节（2026-02-17）、2025 诺贝尔文学奖（拉斯洛·克拉斯纳霍尔凯）两侧答案一致；两侧都不认识 DeepSeek-V4.1-Flash-1017 这个发布名。',
        },
        {
          head: '证据四 · 网关实现不同（两个独立部署）',
          body: 'SCNet-Max 没有 prompt_cache_hit_tokens / prompt_cache_miss_tokens 而对比侧有（DeepSeek 原生 schema）；SCNet-Max 有 service_tier 而对比侧没有；system_fingerprint 两侧分别是字段缺失与空串。',
        },
      ],
      source: 'https://github.com/Phoeky/dsh-scnet-connect#readme',
      sourceLabel: '原始实测记录（dsh-scnet-connect README）',
    }

    const SECTION_ID = 'dsh-connect-model-gateway'
    const API = '/model-pool'
    /** Auto 不是平台，用一个哨兵值占住「正在管理谁」的位置。 */
    const AUTO_KEY = '__auto__'
    /** 网关同理：概览里点「管理」进网关面板，也用它占位。 */
    const GATEWAY_KEY = '__gateway__'

    const T = {
      name: '魔桥',
      refresh: '刷新',
      refreshing: '刷新中',
      checkInAll: '全部账号签到',
      checkingIn: '签到中',
      addAccount: '新增账号',
      refreshAllQuota: '全部刷新',
      remaining: '剩余',
      total: '总额度',
      cycle: '周期',
      plan: '套餐',
      accounts: '账号',
      models: '模型',
      enabled: '已启用',
      noAccount: '还没有账号，点右侧「新增账号」在浏览器里登录。',
      noModels: '还没读到模型清单。',
      signedIn: '正常',
      expiring: '即将过期',
      expired: '已过期',
      signedOut: '未登录',
      remove: '删除',
      switchTo: '切换',
      switchUser: '切换',
      switchClose: '收起',
      switchGlobal: '切换对所有会话生效',
      switchBusy: '切换中…',
      refreshQuota: '刷新积分',
      signed: '已签到',
      active: '当前',
      alreadyCheckedIn: '今日已签',
      pending: '今日未签',
      streak: '连续',
      days: '天',
      credit: '获得',
      error: '错误',
      updated: '更新于',
      never: '未刷新',
      use: '启用',
      modelName: '模型',
      badge: '倍率',
      free: '免费',
      thinking: '思考',
      settings: '设置',
      selectAll: '全选',
      selectNone: '全不选',
      context: '上下文',
      vision: '图片',
      yes: '支持',
      no: '不支持',
      accountHint: '请求走「当前」账号',
      modelHint: '勾选才会出现在对话的选择器里；上下文与图片可逐个覆盖',
      loginWaiting: '等待浏览器授权…',
      loginOpen: '打开授权页',
      loginCancel: '取消',
      loginDone: '登录成功',
      loginFail: '登录失败',
      apiKeyLabel: 'API Key',
      apiKeyHint: '粘贴 meoo_ak_…',
      apiKeyAdd: '添加',
      apiKeyAdding: '添加中',
      addTitle: '新增账号',
      addOAuth: '浏览器授权登录',
      addOAuthDesc: '打开 meoo.com 授权页，确认后自动登录（token 1 小时自动续期）。',
      addApiKey: '输入 API Key',
      addApiKeyDesc: '粘贴 meoo_ak_…，插件自动读出账号并换出网关凭证。',
      apiKeyHelp: 'API Key（推荐）\n在 meoo.com → 设置 → API 密钥 里生成一串 meoo_ak_… 粘贴到这里。插件会用它读出账号、项目与积分，并自动换出项目服务 AK —— 不用点浏览器，也不会过期。',
      scPhone: '手机号',
      scCaptcha: '图形验证码（可留空）',
      scSms: '短信验证码',
      scSend: '获取验证码',
      scSubmit: '登录',
      scRefreshCaptcha: '换一张',
      scHint: '手机号 + 短信验证码登录，不接触密码。未注册手机号会自动注册。',
      lxLogin: '登录灵犀',
      lxHint: '会打开一个独立浏览器窗口，直接到 WPS 登录页（微信扫码或手机号）；登录完成后自动读回登录态，不接触密码、不读你日常浏览器的 cookie。',
      rcLogin: '扫码登录小浣熊',
      rcHint: '会打开一个独立浏览器窗口到小浣熊登录页，用微信扫码完成登录；二维码由小浣熊页面自己渲染（小程序码只能微信服务端出，插件画不出来）。登录完成后自动读回登录态，不接触密码、不读你日常浏览器的 cookie。',
      lxWaiting: '请在刚打开的浏览器窗口里完成登录（微信扫码或手机号），登录后这里会自动继续…',
      scSmsLogin: '手机号 + 短信验证码',
      scSmsSent: '短信已发送，请填写验证码',
      scSmsBad: '验证码不正确或已失效',
      reauth: '重新认证',
      reauthTitle: '重新认证',
      reauthHint: '会话已过期。重新登录只会替换这个账号的登录凭证，模型勾选、签到记录都会保留，不用删除账号。',
      scNotRegistered: '这个手机号还没注册过 SCNet。填验证码登录时会自动为你注册账号；想先注册可点下面的链接。',
      scGoRegister: '去注册 SCNet',
      scSmsSentTo: '短信已发送到',
      scBackResend: '返回重发',
      freeOnly: '只显示免费模型',
      freeOnlyHint: '关掉后列出账号可用的全部模型（按平台实际计费）',
      concurrency: '并发',
      concurrencyHint: '同一账号同时进行的推理请求数上限（超出排队），默认 2。注意：上游免费档只允许 3 个并发会话、企业档 5 个，设得更高不会更快 —— 撞上限后插件会自动收缩到这个数并退避重试。',
      basisLink: 'SCNet-Max 是什么基座？',
      overview: '概览',
      manage: '管理',
      backToOverview: '← 返回概览',
      heroTitle: '魔桥',
      heroDesc: '魔桥：把各家「用积分换模型」的平台收进一个插件——登录、余额、模型开关与签到只做一次。勾选过的模型直接进对话选择器，按各自平台计费。',
      heroTip: '只有勾选过的模型才会出现在选择器里。点「管理」调整账号 / 模型 / 签到；当前账号积分 30 秒自动刷新。',
      statPlatforms: '平台',
      statSignedIn: '已登录',
      statAccounts: '账号',
      statEnabled: '已启用',
      avgRemaining: '剩余积分',
      uniCredits: '剩余智点',
      noCheckIn: '无签到活动',
      expired: '过期',
      acctCount: '共',
      noAccountShort: '未登录',
      needReauth: '需重新认证',
      basisClose: '知道了',
      scNoSmsHint: '60 秒内没收到？确认手机号没错，再换一张图形验证码重发（平台对未注册号也会发码，登录即注册）。',
      scCaptchaBad: '图形验证码不正确，请换一张重填',
      checkInHint: '每天自动为所有账号签到',
      meooCheckInButton: '检查到账',
      // ---- Auto 模式 ----
      autoName: 'Auto 模式',
      autoManage: '管理',
      autoCandidates: '候选',
      autoFirst: '首选',
      autoSwitch24h: '近 24h 切换',
      autoCooling: '冷却中',
      autoOn: '已启用',
      autoOff: '已停用',
      autoShowInPicker: '在选择器里显示',
      autoLead: '首包前出错才切换；已经输出内容的这一轮不重放，直接报错。',
      autoCandTitle: '候选与优先级',
      autoCandHint: '从上到下依次尝试',
      autoAdd: '+ 添加候选',
      autoReady: '就绪',
      autoCoolingTag: '冷却',
      autoSignedOut: '未登录',
      autoDisabled: '已停用',
      autoNoAccount: '账号已移除',
      autoNoModel: '模型不在目录里',
      autoNoPlatform: '平台未接入',
      autoEmpty: '还没有候选。点右上角「+ 添加候选」，选平台、账号和模型。',
      autoCandFoot: '同一模型挂在另一个账号下算另一条候选，各自计费、各自冷却。冷却中的候选直接跳过，这一轮不等待。',
      autoPolicyTitle: '什么时候切换',
      autoCoolLabel: '失败后冷却',
      autoCoolUnit: '秒',
      autoMaxLabel: '最多试',
      autoMaxUnit: '个',
      autoPolicyTail: '冷却中直接跳过，不排队等',
      autoPolicyNote: '已输出内容后出错不切换：内容已经发到界面，重放会出现两段回答。',
      autoLogTitle: '最近路由',
      autoLogHint: '最近 50 条 · 不落盘',
      autoLogClear: '清空',
      autoLogEmpty: '还没有请求走过 Auto。',
      autoLogFailAll: '全部失败',
      autoAddTitle: '添加候选',
      autoAddSub: '同一个「平台 + 账号 + 模型」不能重复添加',
      autoAddPlatform: '平台',
      autoAddAccount: '账号',
      autoAddModel: '模型（勾选后可一次加多条）',
      autoAddExisting: '已在第',
      autoAddSubmit: '添加',
      autoAddCancel: '取消',
      autoAddEmptyPlatform: '这个平台没有可用账号或模型。',
      autoAddNoneLeft: '这个账号下的模型都已经加过了。',
      autoPillRoute: 'Auto · 本轮路由',
      autoPillManage: '管理候选',
      autoPillSwitch: '切过',
    }


    /**
     * OpenAI 网关文案（TK-0004）。
     *
     * 这份字典与 locale/zh.json、locale/en.json 的 gateway 段逐键一致 ——
     * 保留 json 是给其它面板/工具读，客户端这里内联是为了不依赖异步 fetch。
     * 宿主 locale 服务不可用时，GATEWAY_T.zh 兼作离线回退。
     */
    const GATEWAY_NS = 'dsh-connect-model-gateway'
    const GATEWAY_T = {
      zh: {
        'gateway.name': "OpenAI 网关",
        'gateway.open': "已开放",
        'gateway.closed': "未开放",
        'gateway.running': "运行中",
        'gateway.stopped': "已停止",
        'gateway.notRunning': "未运行",
        'gateway.toggleLabel': "开放 OpenAI 协议",
        'gateway.listen': "监听",
        'gateway.keys': "Key",
        'gateway.todayRequests': "今日请求",
        'gateway.manage': "管理",
        'gateway.layoutList': "列表式",
        'gateway.layoutCard': "卡片式",
        'gateway.switchLayout': "切换概览布局",
        'gateway.back': "← 返回概览",
        'gateway.accessInfo': "接入信息",
        'gateway.accessHint': "填进外部 Agent 的 OpenAI 客户端配置即可调用魔桥里的模型。",
        'gateway.baseUrl': "Base URL",
        'gateway.model': "model",
        'gateway.copy': "复制",
        'gateway.copyCurl': "复制 curl",
        'gateway.copied': "已复制",
        'gateway.listenSecurity': "监听与安全",
        'gateway.listenHint': "默认只监听回环；内网使用请改成本机内网地址，改完自动重启监听。",
        'gateway.bind': "绑定地址",
        'gateway.bindLocal': "仅本机 127.0.0.1",
        'gateway.port': "端口",
        'gateway.concurrency': "并发",
        'gateway.perMinute': "频率/分",
        'gateway.tls': "TLS",
        'gateway.tlsHint': "未实现——当前仅支持内网明文，Key 可被同网段嗅探",
        'gateway.audit': "审计日志",
        'gateway.auditHint': "记时间/Key 后缀/model/账号/tokens，不记正文",
        'gateway.accessKeys': "访问 Key",
        'gateway.accessKeysHint': "建议每个 Agent 一把；Key 全文只在创建时显示一次，之后只存哈希。",
        'gateway.keyName': "名称",
        'gateway.keyValue': "Key",
        'gateway.status': "状态",
        'gateway.action': "操作",
        'gateway.enable': "启用",
        'gateway.disable': "禁用",
        'gateway.delete': "删除",
        'gateway.addKey': "+ 新增 Key",
        'gateway.addKeyTitle': "新增访问 Key",
        'gateway.addKeyName': "给哪个 Agent 用",
        'gateway.create': "创建",
        'gateway.creating': "创建中",
        'gateway.cancel': "取消",
        'gateway.secretOnce': "生成成功——请立刻复制，关闭后无法再查看全文",
        'gateway.copyKey': "复制 Key",
        'gateway.done': "完成",
        'gateway.hashOnly': "只存 SHA-256 哈希",
        'gateway.aliases': "模型别名",
        'gateway.aliasesHint': "前缀式 mg-平台:模型 直接可用；别名给外部 Agent 稳定短名。",
        'gateway.alias': "别名",
        'gateway.target': "目标",
        'gateway.addAlias': "+ 新增别名",
        'gateway.addAliasTitle': "新增别名",
        'gateway.aliasPlaceholder': "如 gpt-4o",
        'gateway.targetPlaceholder': "mg-auto 或 mg-workbuddy:模型名",
        'gateway.warning': "⚠ 六家平台均为私有接口、按你自己的账号扣积分；仅供个人研究，请勿商用。",
        'gateway.errorPrefix': "网关错误：",
      },
      en: {
        'gateway.name': "OpenAI Gateway",
        'gateway.open': "Open",
        'gateway.closed': "Closed",
        'gateway.running': "Running",
        'gateway.stopped': "Stopped",
        'gateway.notRunning': "Not running",
        'gateway.toggleLabel': "Expose OpenAI protocol",
        'gateway.listen': "Listening",
        'gateway.keys': "Keys",
        'gateway.todayRequests': "Requests today",
        'gateway.manage': "Manage",
        'gateway.layoutList': "List view",
        'gateway.layoutCard': "Card view",
        'gateway.switchLayout': "Switch overview layout",
        'gateway.back': "← Back to overview",
        'gateway.accessInfo': "Access info",
        'gateway.accessHint': "Copy these into any OpenAI-compatible client to call models in 魔桥.",
        'gateway.baseUrl': "Base URL",
        'gateway.model': "model",
        'gateway.copy': "Copy",
        'gateway.copyCurl': "Copy curl",
        'gateway.copied': "Copied",
        'gateway.listenSecurity': "Listening & security",
        'gateway.listenHint': "Loopback only by default; switch to a LAN IP for internal use. Changes restart the listener.",
        'gateway.bind': "Bind address",
        'gateway.bindLocal': "Localhost 127.0.0.1",
        'gateway.port': "Port",
        'gateway.concurrency': "Concurrency",
        'gateway.perMinute': "Req/min",
        'gateway.tls': "TLS",
        'gateway.tlsHint': "Not implemented — LAN plaintext only; keys could be sniffed on the same subnet",
        'gateway.audit': "Audit log",
        'gateway.auditHint': "Records time/key suffix/model/account/tokens, never message bodies",
        'gateway.accessKeys': "Access keys",
        'gateway.accessKeysHint': "One key per agent recommended. Full key is shown only once at creation; only hashes are stored.",
        'gateway.keyName': "Name",
        'gateway.keyValue': "Key",
        'gateway.status': "Status",
        'gateway.action': "Actions",
        'gateway.enable': "Enable",
        'gateway.disable': "Disable",
        'gateway.delete': "Delete",
        'gateway.addKey': "+ Add key",
        'gateway.addKeyTitle': "New access key",
        'gateway.addKeyName': "Which agent is this for",
        'gateway.create': "Create",
        'gateway.creating': "Creating",
        'gateway.cancel': "Cancel",
        'gateway.secretOnce': "Created — copy it now; the full value cannot be viewed again after closing",
        'gateway.copyKey': "Copy key",
        'gateway.done': "Done",
        'gateway.hashOnly': "SHA-256 hash only",
        'gateway.aliases': "Model aliases",
        'gateway.aliasesHint': "mg-provider:model works directly; aliases give agents a stable short name.",
        'gateway.alias': "Alias",
        'gateway.target': "Target",
        'gateway.addAlias': "+ Add alias",
        'gateway.addAliasTitle': "New alias",
        'gateway.aliasPlaceholder': "e.g. gpt-4o",
        'gateway.targetPlaceholder': "mg-auto or mg-workbuddy:model",
        'gateway.warning': "⚠ These six platforms are private APIs billed to your own accounts; for personal research only, no commercial use.",
        'gateway.errorPrefix': "Gateway error: ",
    },
    }
    /**
     * t() 的离线兜底：字典键就是 `gateway.xxx` 全名，与 locale/*.json 的
     * gateway 段一一对应（注册时拍平成带前缀的键，宿主 t 也按全名查）。
     */
    const gatewayFallbackT = (key) => {
      const name = String(key)
      return GATEWAY_T.zh[name] ?? GATEWAY_T.zh[name.replace(/^gateway\./, '')] ?? name
    }

    // 朴素配色：黑白灰 + 语义状态点
    const C = {
      text: '#16181d',
      sub: '#6b7280',
      faint: '#9ca3af',
      line: '#e5e7eb',
      lineSoft: '#f0f1f3',
      surface: '#ffffff',
      raised: '#fafafa',
      selected: '#f4f4f5',
      strong: '#111827',
      ok: '#15803d',
      warn: '#a16207',
      bad: '#b91c1c',
    }

    const S = {
      wrap: { maxWidth: 940, padding: '2px 0 28px', color: C.text },
      tabs: {
        display: 'inline-flex', gap: 2, padding: 3, marginBottom: 16,
        background: C.raised, border: `1px solid ${C.line}`, borderRadius: 9,
      },
      tab: {
        display: 'inline-flex', alignItems: 'center', gap: 7, height: 30, padding: '0 13px',
        border: '1px solid transparent', borderRadius: 7, background: 'none',
        color: C.sub, fontSize: 12.5, cursor: 'pointer',
      },
      tabOn: {
        color: C.text, fontWeight: 600, background: C.surface,
        borderColor: C.line, boxShadow: '0 1px 2px rgba(16,24,40,.06)',
      },
      dot: { width: 6, height: 6, borderRadius: '50%' },
      card: { border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface, marginBottom: 12 },
      cardHead: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        borderBottom: `1px solid ${C.lineSoft}`,
      },
      cardTitle: { fontSize: 13, fontWeight: 600 },
      cardDesc: { fontSize: 11.5, color: C.sub, lineHeight: 1.6, marginTop: 4, maxWidth: 620 },
      switchOn: {
        width: 34, height: 20, borderRadius: 10, border: 0, padding: 2, flex: '0 0 34px',
        background: 'var(--dsw-alias-brand-primary, #4d6bfe)', cursor: 'pointer', display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
      },
      switchOff: {
        width: 34, height: 20, borderRadius: 10, border: 0, padding: 2, flex: '0 0 34px',
        background: 'var(--dsw-alias-border-l3, #d5d9e0)', cursor: 'pointer', display: 'flex', justifyContent: 'flex-start', alignItems: 'center',
      },
      switchKnobOn: {
        width: 16, height: 16, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,.2)', display: 'block',
      },
      switchKnobOff: {
        width: 16, height: 16, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,.2)', display: 'block',
      },
      hint: { fontSize: 11, color: C.faint },
      body: { padding: '14px' },
      btn: {
        height: 28, padding: '0 11px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
        border: `1px solid ${C.line}`, background: C.surface, color: C.text,
      },
      btnStrong: {
        height: 28, padding: '0 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
        cursor: 'pointer', border: `1px solid ${C.strong}`, background: C.strong, color: '#fff',
      },
      btnGhost: {
        height: 26, padding: '0 8px', borderRadius: 6, fontSize: 11.5, cursor: 'pointer',
        border: '1px solid transparent', background: 'none', color: C.sub,
      },
      quotaRow: { display: 'flex', gap: 36, flexWrap: 'wrap' },
      qLabel: { fontSize: 11, color: C.faint, marginBottom: 5 },
      qValue: { fontSize: 22, fontWeight: 600, letterSpacing: '-.3px', lineHeight: 1.1 },
      qUnit: { fontSize: 11, fontWeight: 400, color: C.faint, marginLeft: 5 },
      kv: { fontSize: 12, color: C.sub, lineHeight: 1.9 },
      bar: { height: 4, borderRadius: 2, background: C.lineSoft, overflow: 'hidden', marginTop: 9, width: 180 },
      barFill: { height: '100%', borderRadius: 2, background: C.strong },
      barLow: { height: '100%', borderRadius: 2, background: C.warn },
      creditPill: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 24, padding: '0 9px', borderRadius: 6,
        border: `1px solid ${C.line}`, background: C.surface,
        color: C.sub, fontSize: 11, whiteSpace: 'nowrap', cursor: 'default',
      },
      creditName: { color: C.text, fontWeight: 500, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' },
      switchBtn: {
        height: 18, padding: '0 5px', marginLeft: 2, borderRadius: 4,
        border: `1px solid ${C.line}`, background: C.surface,
        color: C.sub, fontSize: 10.5, cursor: 'pointer',
      },
      switchPanel: {
        position: 'fixed', zIndex: 1000, width: 250, padding: 8,
        borderRadius: 10, border: `1px solid ${C.line}`, background: C.surface,
        boxShadow: '0 8px 24px rgba(16,24,40,.14)', overflowY: 'auto',
      },
      switchHint: { fontSize: 10.5, color: C.faint, padding: '2px 6px 7px' },
      switchRow: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 8px', border: '1px solid transparent', borderRadius: 7,
        background: 'none', cursor: 'pointer', textAlign: 'left', color: C.text,
      },
      switchRowOn: { background: C.selected, borderColor: C.line },
      switchName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500 },
      switchQuota: { fontSize: 11.5, color: C.sub, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      switchTime: { fontSize: 10, color: C.faint, whiteSpace: 'nowrap' },
      acctRow: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px',
        border: `1px solid ${C.line}`, borderRadius: 8, marginBottom: 7,
      },
      acctRowOn: { borderColor: C.strong, background: C.selected },
      radio: { width: 13, height: 13, borderRadius: '50%', border: `1.5px solid #cbd5e1`, flex: '0 0 13px' },
      radioOn: { borderColor: C.strong, background: C.strong, boxShadow: 'inset 0 0 0 3px #fff' },
      acctName: { fontSize: 12.5, fontWeight: 500 },
      tag: {
        fontSize: 10, padding: '1px 6px', borderRadius: 4,
        background: C.strong, color: '#fff', fontWeight: 500,
      },
      tagFree: { fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#dcfce7', color: C.ok },
      tagPromo: { fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#f1f5f9', color: C.sub, border: `1px solid ${C.line}` },
      settingItem: { display: 'inline-flex', alignItems: 'center', gap: 8 },
      settingLabel: { fontSize: 11, color: C.faint },
      settingInput: { width: 64, height: 24, padding: '0 6px', fontSize: 11.5, border: `1px solid ${C.line}`, borderRadius: 6 },
      settingSelect: { height: 24, fontSize: 11.5, border: `1px solid ${C.line}`, borderRadius: 6, background: C.surface, color: C.text },
      tagSigned: {
        fontSize: 10, padding: '1px 6px', borderRadius: 4,
        background: '#dcfce7', color: C.ok, fontWeight: 500,
      },
      // ---- 签到卡：单行，状态用胶囊，动作贴右；不写描述文字（和其他卡片一致） ----
      ciRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', minWidth: 0 },
      ciPill: {
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 8px',
        borderRadius: 999, fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap', flex: '0 0 auto',
      },
      ciCredit: { fontSize: 11.5, fontWeight: 600, color: C.ok, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' },
      ciStreak: { fontSize: 11, color: C.faint, whiteSpace: 'nowrap', flex: '0 0 auto' },
      ciBtn: {
        marginLeft: 'auto', flex: '0 0 auto', height: 26, padding: '0 11px', borderRadius: 7,
        fontSize: 11.5, cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${C.line}`, background: C.surface, color: C.text,
      },
      ciBtnOff: { opacity: 0.5, cursor: 'default' },
      ciList: {
        borderTop: `1px solid ${C.lineSoft}`, padding: '8px 14px 9px',
        display: 'flex', flexDirection: 'column', gap: 5,
      },
      ciListItem: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, minWidth: 0 },
      ciListName: {
        color: C.sub, flex: '0 0 auto', maxWidth: 180,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      ciListTime: { color: C.faint, marginLeft: 'auto', flex: '0 0 auto' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5, tableLayout: 'fixed' },
      th: {
        textAlign: 'left', fontWeight: 500, fontSize: 11, color: C.faint, whiteSpace: 'nowrap',
        padding: '7px 10px', borderBottom: `1px solid ${C.line}`, background: C.raised,
      },
      td: { padding: '6px 10px', borderBottom: `1px solid ${C.lineSoft}`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      scroll: { maxHeight: 300, overflowY: 'auto', overflowX: 'hidden', border: `1px solid ${C.lineSoft}`, borderRadius: 8 },
      // 选中状态必须一眼可辨：实心深色方块 + 白勾；未选是浅灰空框
      // 未勾选也要看得见：深一点的边框 + 白底；勾选是实心深色 + 白勾
      // 用原生 checkbox：未勾选是系统画的空框，任何主题下都不会「看不见」
      checkbox: {
        width: 15, height: 15, margin: 0, cursor: 'pointer',
        accentColor: C.strong, verticalAlign: 'middle',
      },
      rowOff: { color: C.faint },
      err: { marginTop: 10, padding: '8px 10px', borderRadius: 7, background: '#fef2f2', color: C.bad, fontSize: 11.5 },
      loginBox: {
        marginTop: 10, padding: '12px 13px', borderRadius: 9,
        border: `1px solid ${C.line}`, background: C.raised, fontSize: 12,
      },
      loginBtn: {
        display: 'inline-flex', alignItems: 'center', height: 26, padding: '0 11px',
        borderRadius: 6, border: `1px solid ${C.strong}`, background: C.strong,
        color: '#fff', fontSize: 12, fontWeight: 600, textDecoration: 'none',
      },
      loginUrl: {
        fontSize: 10.5, color: C.faint, wordBreak: 'break-all', lineHeight: 1.6,
      },
      link: { color: C.strong, textDecoration: 'underline', cursor: 'pointer' },
      // ---- 概览页 ----
      hero: { marginBottom: 16, maxWidth: 620 },
      heroTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 5px' },
      heroDesc: { margin: 0, fontSize: 11.5, color: C.sub, lineHeight: 1.7 },
      heroStats: { display: 'flex', gap: 18, marginTop: 11 },
      statN: { fontSize: 14, fontWeight: 600, lineHeight: 1.3 },
      statL: { fontSize: 10, color: C.faint },
      prefBox: { marginTop: 11 },
      prefRow: {
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '6px 10px', borderRadius: 7,
        background: C.raised, border: `1px solid ${C.lineSoft}`,
      },
      prefLabel: { fontSize: 11.5, color: C.text, whiteSpace: 'nowrap' },
      prefGrow: { flex: 1 },
      footNote: { marginTop: 14, fontSize: 10.5, color: C.faint, lineHeight: 1.6, maxWidth: 620 },
      loadingBox: {
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        minHeight: 160, color: C.sub, fontSize: 12,
      },
      spinner: {
        width: 14, height: 14, borderRadius: '50%',
        border: `2px solid ${C.line}`, borderTopColor: C.strong,
        animation: 'mgspin .7s linear infinite',
      },
      heroTips: {
        marginTop: 11, padding: '7px 10px', borderRadius: 7, background: C.raised,
        fontSize: 10.5, color: C.sub, lineHeight: 1.6, border: `1px solid ${C.lineSoft}`,
      },
      // ---- 卡片网格：2 列，符合设置面板 560px 实际宽度 ----
      cardGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14, maxWidth: 620 },
      pcard: {
        background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10,
        padding: '11px 12px 9px', display: 'flex', flexDirection: 'column', minWidth: 0,
      },
      pcardBad: { borderColor: '#fca5a5', background: '#fffbfb' },
      /**
       * 网关卡片：卡片式下置顶独占一行（grid 跨两列），左边一条品牌色竖条。
       * 之前卡片分支只渲染 AutoCard + PlatformCard，网关在卡片式下**没有入口**，
       * 用户切过去就再也打不开网关面板了——这里是补漏，别再删。
       */
      gwCard: {
        background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10,
        borderLeft: `2px solid var(--dsw-alias-brand-primary, #4d6bfe)`,
        padding: '11px 12px 9px', display: 'flex', flexDirection: 'column',
        minWidth: 0, marginTop: 14, maxWidth: 620,
      },
      pcHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9, minWidth: 0 },
      pcName: {
        fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', minWidth: 0, flex: 1,
      },
      pcState: { fontSize: 10.5, whiteSpace: 'nowrap', flex: '0 0 auto' },
      pcMng: {
        flex: '0 0 auto', height: 22, padding: '0 8px', borderRadius: 6, fontSize: 10.5,
        fontWeight: 600, cursor: 'pointer', border: `1px solid ${C.strong}`,
        background: C.strong, color: '#fff',
      },
      pcMetrics: { display: 'flex', borderTop: `1px solid ${C.line}`, paddingTop: 9 },
      metric: { flex: 1, minWidth: 0 },
      metricGap: { borderLeft: `1px solid ${C.lineSoft}`, paddingLeft: 10 },
      metricK: { fontSize: 9.5, color: C.faint, marginBottom: 1, whiteSpace: 'nowrap' },
      metricV: {
        fontSize: 16, fontWeight: 600, letterSpacing: '-.3px', lineHeight: 1.2,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      metricUnit: { fontSize: 10, fontWeight: 400, color: C.faint, marginLeft: 1 },
      metricS: {
        fontSize: 9.5, color: C.faint, marginTop: 1, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      },
      pcAcct: {
        display: 'flex', alignItems: 'center', gap: 5, marginTop: 9, paddingTop: 8,
        borderTop: `1px solid ${C.line}`, fontSize: 10.5, color: C.sub, minWidth: 0,
      },
      pcAcctName: {
        fontWeight: 500, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', minWidth: 0,
      },
      pcAcctCount: { color: C.faint, whiteSpace: 'nowrap', flex: '0 0 auto' },
      pcFoot: {
        display: 'flex', alignItems: 'center', gap: 5, marginTop: 7, fontSize: 10,
        color: C.faint, minHeight: 16, minWidth: 0,
      },
      tagSmall: {
        fontSize: 9.5, padding: '0 5px', borderRadius: 3, background: C.lineSoft,
        color: C.sub, whiteSpace: 'nowrap', flex: '0 0 auto', lineHeight: '16px',
      },
      footText: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
      miniBtn: {
        marginLeft: 'auto', height: 20, padding: '0 6px', borderRadius: 5, fontSize: 10,
        cursor: 'pointer', border: `1px solid ${C.line}`, background: C.surface,
        color: C.text, whiteSpace: 'nowrap', flex: '0 0 auto',
      },
      backBtn: {
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 9px',
        borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface,
        fontSize: 11.5, color: C.sub, cursor: 'pointer', marginBottom: 11,
      },
      overlay: {
        position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      },
      modal: {
        width: 430, maxWidth: '92vw', padding: 18, borderRadius: 12,
        border: `1px solid ${C.line}`, background: C.surface,
        boxShadow: '0 12px 40px rgba(16,24,40,.18)',
      },
      modalHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
      modalTitle: { fontSize: 14, fontWeight: 600 },
      option: {
        display: 'block', width: '100%', textAlign: 'left', padding: '12px 13px',
        border: `1px solid ${C.line}`, borderRadius: 9, background: C.surface,
        color: C.text, cursor: 'pointer', marginBottom: 10,
      },
      optionTitle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, marginBottom: 4 },
      optionDesc: { fontSize: 11, color: C.faint, lineHeight: 1.6 },
      help: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 15, height: 15, borderRadius: '50%', border: `1px solid ${C.line}`,
        color: C.sub, fontSize: 10, cursor: 'help', flex: '0 0 15px',
      },
      helpText: {
        marginTop: 8, padding: '9px 11px', borderRadius: 7, fontSize: 11.5,
        lineHeight: 1.7, color: C.sub, background: C.raised, border: `1px solid ${C.lineSoft}`,
      },
      // ---- Auto 模式 ----
      autoCard: { borderColor: '#d5dae1', marginTop: 10, maxWidth: 620 },
      autoTop: { display: 'flex', alignItems: 'center', gap: 6, padding: '11px 12px 0', minWidth: 0 },
      autoName: { fontSize: 12.5, fontWeight: 600, flex: '0 0 auto' },
      autoMetrics: { display: 'flex', padding: '10px 12px 9px', flexWrap: 'wrap', gap: 0 },
      autoMetric: { minWidth: 0, paddingRight: 16 },
      autoChain: { padding: '0 12px 10px', fontSize: 10, color: C.sub, lineHeight: 1.95 },
      autoNode: {
        display: 'inline-block', padding: '1px 5px', border: `1px solid ${C.line}`, borderRadius: 4,
        background: C.raised, color: C.text, fontSize: 9.5, margin: '0 1px',
      },
      autoArrow: { color: '#c9ced6', fontSize: 9, margin: '0 1px' },
      autoFoot: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px',
        borderTop: `1px solid ${C.lineSoft}`, background: C.raised, fontSize: 10, color: C.sub, minWidth: 0,
      },
      cand: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px',
        borderBottom: `1px solid ${C.lineSoft}`, minWidth: 0,
      },
      candIdx: {
        display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto',
        color: C.faint, fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
      },
      dragHandle: {
        cursor: 'grab', color: '#c9ced6', fontSize: 12, letterSpacing: '-1px',
        padding: '0 2px', marginLeft: '-2px', userSelect: 'none',
      },
      candDragOver: { boxShadow: `inset 0 2px 0 ${C.strong}`, background: C.selected },
      candMain: { minWidth: 0, flex: 1 },
      candName: { fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      candSub: {
        fontSize: 9.5, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', marginTop: 1,
      },
      candAcct: { color: C.sub, fontWeight: 500 },
      candRight: { display: 'flex', alignItems: 'center', gap: 5, flex: '0 0 auto' },
      candBtns: { display: 'flex', gap: 2 },
      iconBtn: {
        width: 19, height: 19, border: `1px solid ${C.line}`, borderRadius: 5, background: C.surface,
        color: C.sub, fontSize: 9, lineHeight: 1, cursor: 'pointer', padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      },
      iconBtnOff: { opacity: 0.32, cursor: 'default' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 7px',
        borderRadius: 5, fontSize: 10, border: `1px solid ${C.line}`, background: C.surface,
        color: C.sub, whiteSpace: 'nowrap', cursor: 'pointer',
      },
      chipOn: { borderColor: '#c7d2fe', background: '#eef2ff', color: '#3730a3' },
      policyRow: { padding: '0 12px 10px', fontSize: 10, color: C.sub, lineHeight: 2 },
      autoInput: {
        display: 'inline-block', verticalAlign: 'middle', width: 34, height: 19,
        border: `1px solid ${C.line}`, borderRadius: 5, fontSize: 10, textAlign: 'center',
        fontVariantNumeric: 'tabular-nums', margin: '0 2px',
      },
      logScroll: {
        maxHeight: 280, overflowY: 'auto', overflowX: 'hidden',
        overscrollBehavior: 'contain',
      },
      logRow: {
        display: 'flex', gap: 7, alignItems: 'baseline', padding: '6px 11px',
        borderBottom: `1px solid ${C.lineSoft}`, fontSize: 10, minWidth: 0,
      },
      logTime: { color: C.faint, fontVariantNumeric: 'tabular-nums', flex: '0 0 40px' },
      logBody: {
        color: C.sub, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', flex: 1,
      },
      logCode: {
        fontSize: 9, padding: '0 4px', borderRadius: 3, background: '#fef2f2',
        color: C.bad, margin: '0 2px', fontWeight: 500,
      },
      logResult: { flex: '0 0 auto', fontSize: 9.5, whiteSpace: 'nowrap' },
      ptab: {
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px',
        borderRadius: 5, border: `1px solid ${C.line}`, background: C.surface,
        fontSize: 10, color: C.sub, cursor: 'pointer',
      },
      ptabOn: { borderColor: C.strong, background: C.selected, color: C.text, fontWeight: 600 },
      pickRow: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
        border: `1px solid ${C.line}`, borderRadius: 6, background: C.surface,
        marginBottom: 4, fontSize: 10.5, minWidth: 0, cursor: 'pointer',
      },
      pickRowOn: { borderColor: C.strong, background: '#f7f7f8' },
      pickRowOff: { opacity: 0.55, cursor: 'default' },
      pickRowDone: { background: C.raised, borderStyle: 'dashed', cursor: 'default' },
      pickName: {
        fontWeight: 500, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', minWidth: 0, flex: 1,
      },
      pickMeta: {
        fontSize: 9.5, color: C.faint, whiteSpace: 'nowrap', flex: '0 0 auto',
        fontVariantNumeric: 'tabular-nums',
      },
      radioDot: { width: 11, height: 11, borderRadius: '50%', border: '1.4px solid #cbd5e1', flex: '0 0 11px' },
      radioDotOn: { borderColor: C.strong, background: C.strong, boxShadow: 'inset 0 0 0 2.5px #fff' },
      mCheck: {
        width: 11, height: 11, borderRadius: 3, border: '1.4px solid #cbd5e1',
        background: C.surface, flex: '0 0 11px', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
      },
      mCheckOn: { background: C.strong, borderColor: C.strong, color: '#fff' },
      // ---- 概览列表式（TK-0004）：一行一条，网关置顶 ----
      heroHead: { display: 'flex', alignItems: 'flex-start', gap: 10 },
      heroGrow: { flex: 1, minWidth: 0 },
      layoutToggle: {
        display: 'inline-flex', flex: '0 0 auto', gap: 2, padding: 2,
        border: `1px solid ${C.line}`, borderRadius: 7, background: C.raised,
      },
      layoutBtn: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 22, padding: '0 7px', border: '1px solid transparent', borderRadius: 5,
        background: 'none', color: C.sub, fontSize: 10.5, cursor: 'pointer', whiteSpace: 'nowrap',
      },
      layoutBtnOn: {
        background: C.surface, borderColor: C.line, color: C.text, fontWeight: 600,
        boxShadow: '0 1px 2px rgba(16,24,40,.06)',
      },
      list: {
        border: `1px solid ${C.line}`, borderRadius: 9, background: C.surface,
        overflow: 'hidden', marginTop: 14, maxWidth: 620,
      },
      row: {
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px',
        borderBottom: `1px solid ${C.lineSoft}`, minHeight: 44, minWidth: 0,
      },
      rowLast: { borderBottom: 'none' },
      rowGw: {
        background: '#fafaff', borderLeft: `2px solid var(--dsw-alias-brand-primary, #4d6bfe)`,
        paddingLeft: 9,
      },
      rowName: {
        fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', flex: '0 0 auto',
      },
      rowNameGw: { color: '#3730a3' },
      rowState: { fontSize: 10, color: C.sub, whiteSpace: 'nowrap', flex: '0 0 auto' },
      rowMeta: {
        display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: C.sub,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1,
      },
      rowMetaB: { fontWeight: 600, color: C.text, fontVariantNumeric: 'tabular-nums' },
      rowMetaSep: { color: '#d1d5db' },
      rowRoute: {
        display: 'flex', alignItems: 'center', gap: 3, fontSize: 9.5, color: C.faint,
        overflow: 'hidden', minWidth: 0,
      },
      routeNode: {
        padding: '1px 4px', border: `1px solid ${C.line}`, borderRadius: 3,
        background: C.surface, color: C.sub, whiteSpace: 'nowrap', fontSize: 9.5,
      },
      rowBtn: {
        flex: '0 0 auto', height: 22, padding: '0 8px', borderRadius: 6, fontSize: 10,
        cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${C.line}`,
        background: C.surface, color: C.text,
      },
      rowBtnStrong: { borderColor: C.strong, background: C.strong, color: '#fff', fontWeight: 600 },
      rowSwLabel: { fontSize: 10, color: C.sub, whiteSpace: 'nowrap', flex: '0 0 auto' },
      rowSwitch: {
        width: 32, height: 18, borderRadius: 10, border: 0, padding: 2, flex: '0 0 32px',
        cursor: 'pointer', display: 'flex', alignItems: 'center',
        background: 'var(--dsw-alias-border-l3, #d5d9e0)',
      },
      rowSwitchOn: {
        background: 'var(--dsw-alias-brand-primary, #4d6bfe)', justifyContent: 'flex-end',
      },
      rowSwitchOff: { justifyContent: 'flex-start' },
      rowSwitchKnob: {
        width: 14, height: 14, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,.2)', display: 'block',
      },
      // ---- 网关管理面板 ----
      panelTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, minWidth: 0 },
      panelTitle: { fontSize: 15, fontWeight: 600 },
      panelTagOn: {
        fontSize: 9.5, padding: '1px 5px', borderRadius: 4, fontWeight: 500,
        background: '#dcfce7', color: C.ok, whiteSpace: 'nowrap',
      },
      panelTagOff: {
        fontSize: 9.5, padding: '1px 5px', borderRadius: 4, fontWeight: 500,
        background: C.lineSoft, color: C.faint, whiteSpace: 'nowrap',
      },
      sec: { marginBottom: 14, maxWidth: 620 },
      secTitle: { fontSize: 11.5, fontWeight: 600, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 },
      secSub: { fontSize: 10, color: C.faint, lineHeight: 1.6, marginBottom: 7 },
      secCard: { border: `1px solid ${C.line}`, borderRadius: 9, background: C.surface, overflow: 'hidden' },
      gwKv: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
        borderBottom: `1px solid ${C.lineSoft}`, fontSize: 10.5, minWidth: 0,
      },
      gwKvLast: { borderBottom: 'none' },
      gwKvLabel: { width: 62, flex: '0 0 62px', color: C.sub },
      gwKvGrow: { flex: 1, minWidth: 0 },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5,
        color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
      },
      monoInput: {
        flex: 1, minWidth: 0, height: 24, padding: '0 7px', fontSize: 10.5,
        border: `1px solid ${C.line}`, borderRadius: 5, background: C.surface, color: C.text,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      gwKvSelect: {
        height: 24, minWidth: 0, flex: 1, fontSize: 10.5, border: `1px solid ${C.line}`,
        borderRadius: 5, background: C.surface, color: C.text,
      },
      gwKvInput: {
        width: 62, height: 24, padding: '0 6px', fontSize: 10.5, border: `1px solid ${C.line}`,
        borderRadius: 5, background: C.surface, color: C.text, fontVariantNumeric: 'tabular-nums',
      },
      gwKvHint: { fontSize: 9.5, color: C.faint, whiteSpace: 'nowrap', flex: '0 0 auto' },
      smallBtn: {
        flex: '0 0 auto', height: 20, padding: '0 7px', borderRadius: 5, fontSize: 9.5,
        cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${C.line}`,
        background: C.surface, color: C.text,
      },
      smallBtnDanger: { color: C.bad, borderColor: '#fecaca' },
      smallBtnAccent: {
        borderColor: '#3730a3', background: '#3730a3', color: '#fff', fontWeight: 600,
      },
      smallBtnOff: { opacity: 0.45, cursor: 'default' },
      footBar: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
        borderTop: `1px solid ${C.lineSoft}`, background: C.raised, minWidth: 0,
      },
      footBarHint: { fontSize: 9.5, color: C.faint, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      warnbar: {
        marginTop: 8, padding: '7px 10px', borderRadius: 7, background: '#fffbeb',
        border: '1px solid #fde68a', color: '#92400e', fontSize: 10, lineHeight: 1.6,
      },
      tableWrap: { overflowX: 'auto' },
      gwTable: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, tableLayout: 'auto' },
      gwTh: {
        textAlign: 'left', fontWeight: 500, fontSize: 9.5, color: C.faint, whiteSpace: 'nowrap',
        padding: '6px 9px', borderBottom: `1px solid ${C.line}`, background: C.raised,
      },
      gwThRight: {
        textAlign: 'right', fontWeight: 500, fontSize: 9.5, color: C.faint, whiteSpace: 'nowrap',
        padding: '6px 9px', borderBottom: `1px solid ${C.line}`, background: C.raised,
      },
      gwTd: {
        padding: '6px 9px', borderBottom: `1px solid ${C.lineSoft}`, whiteSpace: 'nowrap',
        color: C.text, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis',
      },
      gwTdRight: { padding: '6px 9px', borderBottom: `1px solid ${C.lineSoft}`, textAlign: 'right' },
      rowAct: { display: 'inline-flex', gap: 4, justifyContent: 'flex-end' },
      tagOn: {
        fontSize: 9.5, padding: '0 5px', borderRadius: 4, background: '#dcfce7',
        color: C.ok, whiteSpace: 'nowrap', lineHeight: '16px', display: 'inline-block',
      },
      tagOff: {
        fontSize: 9.5, padding: '0 5px', borderRadius: 4, background: C.lineSoft,
        color: C.faint, whiteSpace: 'nowrap', lineHeight: '16px', display: 'inline-block',
      },
      secretBox: {
        marginTop: 10, padding: '9px 11px', borderRadius: 7,
        background: '#fffbeb', border: '1px solid #fde68a',
      },
      secretKey: { fontSize: 9.5, color: '#92400e', fontWeight: 600, marginBottom: 5 },
      secretVal: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5,
        color: C.text, wordBreak: 'break-all', lineHeight: 1.6,
      },
      modalFoot: {
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, minWidth: 0,
      },
      modalHint: { fontSize: 9.5, color: C.faint, marginLeft: 'auto', minWidth: 0 },
      field: { marginBottom: 10 },
      fieldLabel: { display: 'block', fontSize: 10.5, color: C.sub, marginBottom: 4 },
      fieldInput: {
        width: '100%', height: 26, padding: '0 8px', fontSize: 11.5,
        border: `1px solid ${C.line}`, borderRadius: 6, background: C.surface, color: C.text,
        boxSizing: 'border-box',
      },
    }

    /**
     * 界面偏好（不是服务端状态）：跟着浏览器本地走，不写 ~/.dsh/model-pool。
     * 现在只有一项 —— 用不用魔桥的模型选择器。关掉即回退 DSH 原生选择器。
     */
    const PREF_KEY = 'dsh-connect-model-gateway:prefs'
    const PREF_DEFAULT = { useGatewayPicker: true, overviewLayout: 'list' }
    const prefListeners = new Set()
    let prefCache = null
    function readPrefs() {
      if (prefCache !== null) return prefCache
      let stored = {}
      try {
        const raw = globalThis.localStorage?.getItem(PREF_KEY)
        if (raw) stored = JSON.parse(raw) ?? {}
      } catch { stored = {} }
      prefCache = { ...PREF_DEFAULT, ...stored }
      // 老用户存储里没有 overviewLayout：自动落 'list'，不是 undefined
      if (prefCache.overviewLayout !== 'card') prefCache.overviewLayout = 'list'
      return prefCache
    }
    function writePrefs(patch) {
      prefCache = { ...readPrefs(), ...patch }
      try { globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(prefCache)) } catch { /* 隐私模式写不进去，本次会话内仍生效 */ }
      for (const listener of [...prefListeners]) {
        try { listener(prefCache) } catch { /* 单个订阅者抛错不影响其他 */ }
      }
      return prefCache
    }
    function subscribePrefs(listener) {
      prefListeners.add(listener)
      return () => prefListeners.delete(listener)
    }
    /** useGatewayPicker 的订阅式读取；选择器与设置页共用同一次广播。 */
    function usePrefs() {
      return React.useSyncExternalStore(
        (listener) => { prefListeners.add(listener); return () => prefListeners.delete(listener) },
        () => readPrefs(),
        () => readPrefs(),
      )
    }

    async function api(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${path} → ${response.status}`)
      return response.json()
    }

    /** 思考档位的中文名。 */
    function levelTone(level) {
      const map = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
      return map[String(level).toLowerCase()] ?? String(level)
    }

    function stateOf(state) {
      if (state === 'signed-in') return { text: T.signedIn, color: C.ok }
      if (state === 'expiring') return { text: T.expiring, color: C.warn }
      if (state === 'expired') return { text: T.expired, color: C.bad }
      return { text: T.signedOut, color: C.bad }
    }

    function num(v) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
      return Number.isInteger(v) ? String(v) : v.toFixed(2)
    }

    /**
     * 积分展示口径：`unlimited`（SCNet：无余额接口、也不扣积分）显示 ♾️；
     * 有数字就显示数字；其余（读不到、令牌过期）才是「未知」。
     */
    function quotaText(quota) {
      if (quota?.unlimited === true) return '♾️'
      return typeof quota?.remaining === 'number' ? num(quota.remaining) : '未知'
    }

    function clock(ms) {
      if (typeof ms !== 'number' || ms <= 0) return T.never
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}`
    }

    /** 新增账号：发起登录 → 打开授权页 → 轮询。 */
    /**
     * 统一的「新增账号 / 重新认证」：点按钮 → 弹窗 → 各平台自己的认证方式。
     * reauthId 不为空时，登录结果只替换该账号的凭证，保留勾选状态与签到记录。
     */
    function AddAccountModal({ platform, onDone, reauthId, buttonLabel }) {
      const provider = platform.provider
      const [open, setOpen] = useState(false)
      const [mode, setMode] = useState(null)
      const [session, setSession] = useState(null)
      const [status, setStatus] = useState('')
      const [statusBad, setStatusBad] = useState(false)
      const [busy, setBusy] = useState(false)
      const [key, setKey] = useState('')
      const [showHelp, setShowHelp] = useState(false)
      const [phone, setPhone] = useState('')
      const [captcha, setCaptcha] = useState('')
      const [sms, setSms] = useState('')
      const [image, setImage] = useState(null)
      const [smsSent, setSmsSent] = useState(false)
      const [registered, setRegistered] = useState(null)
      const [registerUrl, setRegisterUrl] = useState('')

      const note = (text, bad = false) => { setStatus(text); setStatusBad(bad) }
      const finish = (outcome) => {
        setOpen(false); setMode(null); setSession(null); note('')
        onDone(outcome)
      }
      const authBody = (extra) => ({ provider, ...(reauthId !== undefined && reauthId !== '' ? { reauthId } : {}), ...extra })

      // OAuth / 浏览器登录：发起后自动轮询。短信登录走手动提交，不在这里轮询。
      useEffect(() => {
        if (session === null || mode === 'sms') return undefined
        let alive = true
        const timer = setInterval(async () => {
          try {
            const outcome = await api('/login/poll', authBody({ loginId: session.loginId }))
            if (!alive) return
            if (outcome.done === true) {
              clearInterval(timer)
              setSession(null)
              if (outcome.account !== undefined || outcome.platforms !== undefined) finish(outcome)
              else note(`${T.loginFail}：${outcome.error ?? ''}`, true)
            }
          } catch (error) {
            if (alive) note(`${T.loginFail}：${error.message}`, true)
          }
        }, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [session, mode, provider, reauthId, onDone])

      const close = () => {
        setOpen(false); setMode(null); setSession(null); note('')
        setKey(''); setPhone(''); setCaptcha(''); setSms(''); setImage(null); setShowHelp(false)
        setRegistered(null); setRegisterUrl(''); setSmsSent(false)
      }

      const startLogin = async (extra) => {
        setBusy(true); setStatus('')
        try {
          const started = await api('/login/start', authBody(extra))
          setSession(started)
          if (started.browser !== true && started.verificationUri) window.open(started.verificationUri, '_blank', 'noopener')
        } catch (error) {
          note(`${T.loginFail}：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }

      const addApiKey = async () => {
        setBusy(true); setStatus('')
        try {
          const next = await api('/meoo/apikey', authBody({ apiKey: key.trim() }))
          setKey(''); finish(next)
        } catch (error) {
          note(`${T.loginFail}：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }

      // 进短信模式先抓一张图形验证码：用户填手机号时就能看到图，
      // 而不是点了"获取验证码"才第一次见到它。
      const openSms = async () => {
        setMode('sms')
        setSession(null)
        setSmsSent(false)
        setStatus('')
        try {
          const started = await api('/login/scnet/captcha', {})
          setSession(started)
          setImage(started.captchaImage ?? null)
        } catch (error) {
          note(`获取图形验证码失败：${error.message}`, true)
        }
      }

      const sendSms = async () => {
        setBusy(true); setStatus('')
        try {
          const started = await api('/login/start', authBody({ loginId: session?.loginId, phone: phone.trim(), captcha: captcha.trim() }))
          setSession(started)
          // 发码响应通常不再带图（短信已按上一张图签名）；只有真的给了新图才替换
          if (typeof started.captchaImage === 'string') setImage(started.captchaImage)
          setRegistered(typeof started.registered === 'boolean' ? started.registered : null)
          setRegisterUrl(started.registerUrl ?? '')
          setSmsSent(true)
          note(T.scSmsSent)
        } catch (error) {
          note(`${T.loginFail}：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }

      const submitSms = async () => {
        setBusy(true); setStatus('')
        try {
          const outcome = await api('/login/poll', authBody({ loginId: session?.loginId, smsCode: sms.trim() }))
          if (outcome.done === true) {
            if (outcome.account !== undefined || outcome.platforms !== undefined) finish(outcome)
            else note(`${T.loginFail}：${outcome.error ?? ''}`, true)
          } else note(`${T.loginFail}：${outcome.error ?? T.scSmsBad}`, true)
        } catch (error) {
          note(`${T.loginFail}：${error.message}`, true)
        } finally {
          setBusy(false)
        }
      }

      const refreshCaptcha = async () => {
        try {
          const result = await api('/login/captcha', { loginId: session?.loginId })
          setImage(result.captchaImage ?? null)
        } catch (error) { note(`${T.loginFail}：${error.message}`, true) }
      }

      // 每个平台自己的认证方式
      const options = (() => {
        if (provider === 'meoo') return [
          { mode: 'oauth', title: T.addOAuth, desc: T.addOAuthDesc, run: () => startLogin({}) },
          { mode: 'apikey', title: T.addApiKey, desc: T.addApiKeyDesc, run: () => setMode('apikey') },
        ]
        if (provider === 'scnet') return [
          { mode: 'sms', title: T.scSmsLogin, desc: T.scHint, run: () => openSms() },
        ]
        if (provider === 'lingxi') return [
          { mode: 'oauth', title: T.lxLogin, desc: T.lxHint, run: () => startLogin({}) },
        ]
        if (provider === 'raccoon') return [
          { mode: 'oauth', title: T.rcLogin, desc: T.rcHint, run: () => startLogin({}) },
        ]
        return [
          { mode: 'oauth', title: T.addOAuth, desc: T.addOAuthDesc, run: () => startLogin({}) },
        ]
      })()

      return h('div', null,
        h('button', {
          // 概览卡片底部空间只有 16px，重新认证按钮要按迷你尺寸渲染
          style: buttonLabel === T.reauth ? S.miniBtn : S.btnStrong,
          onClick: () => setOpen(true),
        }, buttonLabel ?? T.addAccount),
        open === false ? null : h('div', { style: S.overlay, onClick: close },
          h('div', { style: S.modal, onClick: (e) => e.stopPropagation() },
            h('div', { style: S.modalHead },
              h('span', { style: S.modalTitle }, reauthId !== undefined && reauthId !== '' ? T.reauthTitle : T.addTitle),
              h('button', { style: { ...S.btnGhost, marginLeft: 'auto' }, onClick: close }, '✕'),
            ),
            reauthId !== undefined && reauthId !== '' ? h('div', { style: S.helpText }, T.reauthHint) : null,
            session !== null && mode !== 'sms'
              ? h('div', { style: S.loginBox },
                h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 10 } }, T.loginWaiting),
                h('a', { style: S.loginBtn, href: session.verificationUri, target: '_blank', rel: 'noreferrer noopener' }, T.loginOpen),
                h('div', { style: S.loginUrl }, session.verificationUri),
              )
              : mode === null
                ? h('div', null, options.map((option) =>
                  h('button', { key: option.mode, style: S.option, onClick: option.run },
                    h('div', { style: S.optionTitle }, option.title),
                    h('div', { style: S.optionDesc }, option.desc),
                  ),
                ))
                : mode === 'apikey'
                  ? h('div', null,
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                      h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, T.addApiKey),
                      h('span', { style: S.help, title: T.apiKeyHelp, onMouseEnter: () => setShowHelp(true), onMouseLeave: () => setShowHelp(false) }, '?'),
                    ),
                    h('input', { type: 'password', value: key, placeholder: T.apiKeyHint, onChange: (e) => setKey(e.target.value),
                      style: { ...S.settingInput, width: '100%', height: 30, padding: '0 10px', fontSize: 12, boxSizing: 'border-box' } }),
                    showHelp === true ? h('div', { style: S.helpText }, T.apiKeyHelp) : null,
                    h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
                      h('button', { style: S.btn, onClick: () => setMode(null) }, '返回'),
                      h('button', { style: S.btnStrong, disabled: busy || key.trim() === '', onClick: addApiKey }, busy ? T.apiKeyAdding : T.apiKeyAdd),
                    ),
                  )
                  : mode === 'sms'
                    ? h('div', null,
                      smsSent !== true
                        ? h('div', null,
                          h('input', { placeholder: T.scPhone, value: phone, onChange: (e) => setPhone(e.target.value), style: { ...S.settingInput, width: '100%', height: 30, marginBottom: 10, boxSizing: 'border-box' } }),
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                            image !== null
                              ? h('img', { src: image, alt: '图形验证码', style: { height: 34, border: `1px solid ${C.line}`, borderRadius: 4, cursor: 'pointer' }, onClick: refreshCaptcha, title: '看不清？点一下换一张' })
                              : h('span', { style: S.hint }, '验证码加载中…'),
                            h('button', { style: S.btnGhost, onClick: refreshCaptcha }, T.scRefreshCaptcha),
                          ),
                          h('input', { placeholder: T.scCaptcha, value: captcha, onChange: (e) => setCaptcha(e.target.value), style: { ...S.settingInput, width: '100%', height: 30, marginTop: 8, boxSizing: 'border-box' } }),
                          h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
                            h('button', { style: S.btn, onClick: () => setMode(null) }, '返回'),
                            h('button', { style: S.btnStrong, disabled: busy || phone.trim() === '', onClick: sendSms }, busy ? '发送中' : T.scSend),
                          ),
                        )
                        : h('div', null,
                          h('div', { style: { fontSize: 12, color: C.sub, marginBottom: 10 } }, `${T.scSmsSentTo} ${phone.trim() || ''}`),
                          registered === false
                            ? h('div', { style: { ...S.helpText, marginBottom: 10 } },
                              h('div', null, T.scNotRegistered),
                              registerUrl !== ''
                                ? h('a', { href: registerUrl, target: '_blank', rel: 'noreferrer noopener', style: { ...S.link, display: 'inline-block', marginTop: 6 } }, T.scGoRegister)
                                : null,
                            )
                            : null,
                          image !== null ? h('img', { src: image, alt: '图形验证码', style: { height: 36, marginRight: 8, verticalAlign: 'middle', border: `1px solid ${C.line}`, borderRadius: 4 } }) : null,
                          h('button', { style: S.btnGhost, onClick: refreshCaptcha }, T.scRefreshCaptcha),
                          h('input', { placeholder: T.scSms, value: sms, onChange: (e) => setSms(e.target.value), style: { ...S.settingInput, width: '100%', height: 30, marginTop: 10, boxSizing: 'border-box' } }),
                          h('div', { style: { ...S.hint, marginTop: 6 } }, T.scNoSmsHint),
                          h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
                            h('button', { style: S.btn, onClick: () => setSmsSent(false) }, T.scBackResend),
                            h('button', { style: S.btnStrong, disabled: busy || sms.trim() === '', onClick: submitSms }, T.scSubmit),
                          ),
                        ),
                    )
                    : null,
            status === ''
              ? null
              : statusBad === true
                ? h('div', { style: { ...S.err, marginTop: 10 } }, status)
                : h('div', { style: { ...S.helpText, marginTop: 10 } }, status),
          ),
        ),
      )
    }

    /** SCNet-Max 基座说明弹窗（内容来自旧插件实测记录）。 */
    function ScnetBasis({ inline }) {
      const [open, setOpen] = useState(false)
      const basis = SCNET_BASIS
      return h('span', null,
        h('button', { style: inline === true ? S.btnGhost : S.link, onClick: () => setOpen(true) }, T.basisLink),
        open === false ? null : h('div', { style: S.overlay, onClick: () => setOpen(false) },
          h('div', { style: { ...S.modal, width: 560 }, onClick: (event) => event.stopPropagation() },
            h('div', { style: S.modalHead },
              h('span', { style: S.modalTitle }, basis.title),
              h('button', { style: { ...S.btnGhost, marginLeft: 'auto' }, onClick: () => setOpen(false) }, '✕'),
            ),
            h('div', { style: { fontSize: 12, color: C.sub, lineHeight: 1.7, marginBottom: 12 } }, basis.summary),
            h('div', { style: { ...S.helpText, marginBottom: 12 } },
              basis.conclusion.split('\n').map((line, index) => h('div', { key: index, style: index === 0 ? { fontWeight: 600, marginBottom: 4, color: C.text } : null }, line)),
            ),
            h('div', { style: { maxHeight: 240, overflowY: 'auto' } },
              basis.evidence.map((item) => h('div', { key: item.head, style: { marginBottom: 10 } },
                h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 3 } }, item.head),
                h('div', { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.7 } }, item.body),
              )),
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 } },
              h('a', { href: basis.source, target: '_blank', rel: 'noreferrer noopener', style: S.link, title: basis.source }, basis.sourceLabel),
              h('button', { style: { ...S.btn, marginLeft: 'auto' }, onClick: () => setOpen(false) }, T.basisClose),
            ),
          ),
        ),
      )
    }

    // ================= Auto 模式 =================

    /** 冷却剩余秒数。 */
    function coolingText(ms) {
      return `${Math.max(1, Math.ceil(ms / 1000))}s`
    }

    /** 候选的状态标签：就绪 / 冷却 / 未登录 / 已停用 / 账号没了。 */
    function autoStateOf(candidate) {
      if (candidate.coolingMs > 0) {
        return { text: `${T.autoCoolingTag} ${coolingText(candidate.coolingMs)}`, fg: C.warn, bg: '#fef3c7' }
      }
      if (candidate.ready) return { text: T.autoReady, fg: C.ok, bg: '#dcfce7' }
      const reason = candidate.reason ?? T.autoSignedOut
      if (reason === '未登录') return { text: T.autoSignedOut, fg: C.bad, bg: '#fee2e2' }
      if (reason === '模型已停用') return { text: T.autoDisabled, fg: C.sub, bg: C.lineSoft }
      if (reason === '账号已移除') return { text: T.autoNoAccount, fg: C.bad, bg: '#fee2e2' }
      if (reason === '模型不在目录里') return { text: T.autoNoModel, fg: C.warn, bg: '#fef3c7' }
      if (reason === '平台未接入') return { text: T.autoNoPlatform, fg: C.bad, bg: '#fee2e2' }
      return { text: reason, fg: C.sub, bg: C.lineSoft }
    }

    /** 一条候选行。 */
    function AutoCandidateRow({ candidate, index, first, last, busy, onAction }) {
      const state = autoStateOf(candidate)
      const [over, setOver] = React.useState(false)
      const sub = [
        candidate.providerName,
        candidate.contextWindow > 0 ? `${Math.round(candidate.contextWindow / 1000)}K` : null,
        candidate.badge,
      ].filter((part) => part !== null && part !== undefined && part !== '').join(' · ')
      const btn = (label, onClick, disabled, title) => h('button', {
        style: { ...S.iconBtn, ...(disabled ? S.iconBtnOff : {}) },
        disabled: disabled === true,
        title,
        onClick: disabled === true ? undefined : onClick,
      }, label)
      return h('div', {
        style: {
          ...S.cand, ...(candidate.ready ? {} : { opacity: 0.62 }),
          ...(over ? S.candDragOver : {}),
        },
        onDragOver: (event) => { event.preventDefault(); setOver(true) },
        onDragLeave: () => setOver(false),
        onDrop: (event) => {
          event.preventDefault()
          setOver(false)
          const key = event.dataTransfer.getData('text/plain')
          if (key) onAction('/auto/candidates/move', { key, index })
        },
      },
        h('div', { style: S.candIdx },
          h('span', {
            draggable: true,
            title: '拖动排序',
            style: { ...S.dragHandle },
            onDragStart: (event) => {
              event.dataTransfer.setData('text/plain', candidate.key)
              event.dataTransfer.effectAllowed = 'move'
            },
          }, '⠿'),
          String(index + 1)),
        h('div', { style: S.candMain },
          h('div', { style: S.candName, title: candidate.modelName ?? candidate.model }, candidate.modelName ?? candidate.model),
          h('div', { style: S.candSub, title: sub },
            h('span', { style: S.candAcct }, candidate.external === true ? '外部 provider' : (candidate.accountLabel ?? '—')),
            ` · ${sub}`),
        ),
        h('div', { style: S.candRight },
          h('span', {
            style: {
              fontSize: 9.5, padding: '1px 5px', borderRadius: 4, whiteSpace: 'nowrap',
              fontWeight: 500, background: state.bg, color: state.fg,
            },
          }, state.text),
          h('div', { style: S.candBtns },
            btn('↑', () => onAction('/auto/candidates/move', { key: candidate.key, delta: -1 }), first === true, '上移'),
            btn('↓', () => onAction('/auto/candidates/move', { key: candidate.key, delta: 1 }), last === true, '下移'),
            btn('✕', () => onAction('/auto/candidates/remove', { key: candidate.key }), false, '移除'),
          ),
        ),
      )
    }

    /**
     * 添加候选弹窗：平台 → 账号 → 模型（可多选）。
     *
     * 去重判断用「平台 + 账号 + 模型」三元组：前端把已存在的模型行置灰不可选，
     * 服务端收到后再判一次（弹窗可能开着很久，别处可能已加过）。
     */
    function AddCandidateModal({ auto, onClose, onDone }) {
      const catalog = Array.isArray(auto?.catalog) ? auto.catalog : []
      const existing = useMemo(
        () => new Set((auto?.candidates ?? []).map((candidate) => `${candidate.provider}|${candidate.accountId}|${candidate.model}`)),
        [auto],
      )
      const ordered = useMemo(() => {
        // 有账号有模型的平台排前面，其余留在后面但不选
        const usable = catalog.filter((entry) => (entry.accounts ?? []).length > 0 && (entry.models ?? []).length > 0)
        const rest = catalog.filter((entry) => !usable.includes(entry))
        return [...usable, ...rest]
      }, [catalog])

      const [provider, setProvider] = useState(() => ordered[0]?.provider ?? '')
      // 当前选中的平台条目：账号行与提交时都要用（判断是不是外部 provider）
      const current = ordered.find((entry) => entry.provider === provider)
      const accountList = current?.accounts ?? []
      const modelList = current?.models ?? []
      const isExternal = current?.external === true
      const [accountId, setAccountId] = useState(() => accountList[0]?.id ?? '')
      const [picked, setPicked] = useState([])

      // 换平台就换到这个平台第一个有账号的条目
      const pickProvider = (next) => {
        const entry = ordered.find((item) => item.provider === next)
        setProvider(next)
        setAccountId(entry?.accounts?.[0]?.id ?? '')
        setPicked([])
      }
      const pickAccount = (next) => {
        setAccountId(next)
        setPicked([])
      }
      const keyOf = (model) => `${provider}|${accountId}|${model}`
      const toggleModel = (model) => {
        if (existing.has(keyOf(model))) return
        setPicked((current) => (current.includes(model) ? current.filter((item) => item !== model) : [...current, model]))
      }

      const noLeft = modelList.length > 0 && modelList.every((model) => existing.has(keyOf(model.id)))
      const canSubmit = picked.length > 0

      return h('div', {
        style: S.overlay,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
        h('div', { style: { ...S.modal, width: 456, padding: 0, overflow: 'hidden' } },
          h('div', {
            style: {
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 13px 9px',
              borderBottom: `1px solid ${C.lineSoft}`,
            },
          },
            h('div', null,
              h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, T.autoAddTitle),
              h('div', { style: { fontSize: 9.5, color: C.faint, marginTop: 2 } }, T.autoAddSub),
            ),
            h('button', {
              style: {
                marginLeft: 'auto', width: 20, height: 20, border: 'none', background: 'none',
                color: C.faint, fontSize: 12, cursor: 'pointer',
              },
              onClick: onClose,
            }, '✕'),
          ),

          h('div', { style: { padding: '9px 13px 4px' } },
            h('div', { style: { fontSize: 9.5, color: C.faint, margin: '0 0 4px' } }, T.autoAddPlatform),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 9 } },
              ordered.map((entry) => h('button', {
                key: entry.provider,
                style: { ...S.ptab, ...(entry.provider === provider ? S.ptabOn : {}), ...((entry.accounts ?? []).length === 0 ? { opacity: 0.5 } : {}) },
                onClick: () => pickProvider(entry.provider),
              }, entry.displayName)),
            ),

            h('div', { style: { fontSize: 9.5, color: C.faint, margin: '0 0 4px' } },
              accountList.length > 1 ? `${T.autoAddAccount}（这个平台有 ${accountList.length} 个）` : T.autoAddAccount),
            accountList.length === 0
              ? h('div', { style: { ...S.kv, marginBottom: 8 } }, T.autoAddEmptyPlatform)
              : accountList.map((account) => {
                  const on = account.id === accountId
                  return h('div', {
                    key: account.id,
                    style: { ...S.pickRow, ...(on ? S.pickRowOn : {}), ...(account.authError === true ? S.pickRowOff : {}) },
                    onClick: () => pickAccount(account.id),
                  },
                    h('span', { style: { ...S.radioDot, ...(on ? S.radioDotOn : {}) } }),
                    h('span', { style: S.pickName },
                      isExternal ? '无需账号 · 用 provider 自己的配置' : account.label),
                    account.active ? h('span', { style: { ...S.tagSmall } }, '当前') : null,
                    account.authError === true ? h('span', { style: { ...S.tagSmall, background: '#fee2e2', color: C.bad } }, T.autoSignedOut) : null,
                  )
                }),

            h('div', { style: { fontSize: 9.5, color: C.faint, margin: '8px 0 4px' } }, T.autoAddModel),
            modelList.length === 0
              ? h('div', { style: S.kv }, T.autoAddEmptyPlatform)
              : modelList.map((model) => {
                  const done = existing.has(keyOf(model.id))
                  const on = picked.includes(model.id)
                  return h('div', {
                    key: model.id,
                    style: { ...S.pickRow, ...(on ? S.pickRowOn : {}), ...(done ? S.pickRowDone : {}) },
                    onClick: () => toggleModel(model.id),
                  },
                    // 对勾只在「已勾选」或「已加过」时可见：未选是一个空框
                    h('span', {
                      style: {
                        ...S.mCheck,
                        ...(on ? S.mCheckOn : { color: 'transparent' }),
                        ...(done ? { background: '#e5e7eb', borderColor: '#d1d5db', color: C.faint } : {}),
                      },
                    }, '✓'),
                    h('span', { style: { ...S.pickName, ...(done ? { color: C.faint } : {}) } }, model.name),
                    h('span', { style: S.pickMeta },
                      done
                        ? `${T.autoAddExisting} ${(auto.candidates ?? []).findIndex((c) => c.provider === provider && c.accountId === accountId && c.model === model.id) + 1} 位`
                        : `${model.contextWindow > 0 ? Math.round(model.contextWindow / 1000) + 'K' : '—'}${model.badge ? ' · ' + model.badge : ''}`),
                  )
                }),
            noLeft ? h('div', { style: { ...S.kv, marginTop: 4 } }, T.autoAddNoneLeft) : null,
          ),

          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 7, padding: '9px 13px',
              borderTop: `1px solid ${C.lineSoft}`, background: C.raised,
            },
          },
            h('span', { style: { flex: 1, fontSize: 9.5, color: C.faint, lineHeight: 1.6 } },
              '同一模型换账号属于新候选，可以一起加'),
            h('button', { style: S.btn, onClick: onClose }, T.autoAddCancel),
            h('button', {
              style: { ...S.btnStrong, opacity: canSubmit ? 1 : 0.42, cursor: canSubmit ? 'pointer' : 'default' },
              onClick: canSubmit
                ? () => onDone(picked.map((model) => ({ provider, accountId: isExternal ? '' : accountId, model })))
                : undefined,
            }, `${T.autoAddSubmit} ${picked.length}`),
          ),
        ),
      )
    }

    /** 概览页的 Auto 卡。 */
    function AutoCard({ auto, onManage }) {
      if (auto === undefined || auto === null) return null
      const enabled = auto.enabled !== false
      const chain = Array.isArray(auto.chain) ? auto.chain : []
      const first = chain[0]
      const cooling = auto.coolingCount ?? 0
      const last = auto.lastRoute
      return h('div', { style: { ...S.card, ...S.autoCard } },
        h('div', { style: S.autoTop },
          h('span', { style: { ...S.dot, background: enabled ? C.ok : C.faint } }),
          h('span', { style: S.autoName }, T.autoName),
          h('span', {
            style: {
              fontSize: 9.5, padding: '1px 5px', borderRadius: 4, fontWeight: 500,
              background: enabled ? '#dcfce7' : C.lineSoft, color: enabled ? C.ok : C.faint,
            },
          }, enabled ? T.autoOn : T.autoOff),
          h('span', { style: { marginLeft: 'auto' } }),
          h('button', { style: S.miniBtn, onClick: onManage }, T.autoManage),
        ),
        h('div', { style: S.autoMetrics },
          h('div', { style: S.autoMetric },
            h('div', { style: S.metricK }, T.autoCandidates),
            h('div', { style: S.metricV }, String(auto.candidateCount ?? 0),
              h('span', { style: S.metricUnit }, ` / ${auto.availableCount ?? 0} 可用`))),
          h('div', { style: S.autoMetric },
            h('div', { style: S.metricK }, T.autoFirst),
            h('div', { style: { ...S.metricV, fontSize: 11.5 } }, first?.modelName ?? '—')),
          h('div', { style: S.autoMetric },
            h('div', { style: S.metricK }, T.autoSwitch24h),
            h('div', { style: S.metricV }, String(auto.switchCount24h ?? 0),
              h('span', { style: S.metricUnit }, '次'))),
          h('div', { style: S.autoMetric },
            h('div', { style: S.metricK }, T.autoCooling),
            h('div', { style: { ...S.metricV, fontSize: 11.5, color: cooling > 0 ? C.warn : C.text } }, String(cooling))),
        ),
        chain.length === 0
          ? h('div', { style: { ...S.autoChain, color: C.faint } }, T.autoEmpty)
          : h('div', { style: S.autoChain },
              chain.map((entry, index) => [
                index === 0 ? null : h('span', { key: `a${entry.key}`, style: S.autoArrow }, '→'),
                h('span', {
                  key: entry.key,
                  style: {
                    ...S.autoNode,
                    ...(entry.ready && entry.coolingMs === 0 ? {} : { color: C.faint }),
                    ...(entry.coolingMs > 0 ? { borderColor: '#fde68a', background: '#fffbeb', color: C.warn } : {}),
                  },
                  title: `${entry.providerName} / ${entry.accountLabel} / ${entry.modelName}`,
                }, entry.modelName),
              ]),
              h('span', { style: { color: C.faint, marginLeft: 5 } }, '限流 / 用尽 / 掉登录自动换下一个'),
            ),
        last === undefined || last === null
          ? null
          : h('div', { style: S.autoFoot },
              h('span', { style: { color: C.faint, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' } }, clock(last.at)),
              h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                last.used === null
                  ? `全部候选失败（${(last.attempts ?? []).map((a) => a.code).join(' / ') || '未知'}）`
                  : `${(last.attempts ?? []).filter((a) => a.result === 'fail').map((a) => `${a.modelName} ${a.code}`).join('，') || '首包直出'} → ${last.used.modelName} · ${((last.ms ?? 0) / 1000).toFixed(1)}s`),
              h('span', { style: { marginLeft: 'auto', flex: '0 0 auto', color: last.used === null ? C.bad : C.ok } }, last.used === null ? '✕' : '✓'),
            ),
      )
    }

    /** Auto 管理面板：候选、策略、最近路由。 */
    function AutoPanel({ auto, onAction, busy }) {
      const [adding, setAdding] = useState(false)
      const candidates = Array.isArray(auto?.candidates) ? auto.candidates : []
      const policy = auto?.policy ?? {}
      const switchOn = Array.isArray(policy.switchOn) ? policy.switchOn : []
      const history = Array.isArray(auto?.history) ? auto.history : []

      const toggleCode = (code) => {
        const next = switchOn.includes(code) ? switchOn.filter((item) => item !== code) : [...switchOn, code]
        onAction('/auto/policy', { patch: { switchOn: next } })
      }

      const CHIPS = [
        ['RATE_LIMIT', '限流 429'],
        ['QUOTA', '积分用尽'],
        ['AUTH', '登录失效'],
        ['SERVER', '服务端 5xx'],
        ['TRANSPORT', '断流'],
        ['TIMEOUT', '超时'],
        ['EMPTY_RESPONSE', '空回复'],
        ['INVALID_REQUEST', '参数错误 400'],
        ['CONTEXT_WINDOW_EXCEEDED', '上下文超限'],
      ]

      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, minWidth: 0 } },
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, T.autoName),
          h('span', {
            style: {
              fontSize: 9.5, padding: '1px 5px', borderRadius: 4, fontWeight: 500,
              background: auto?.enabled === false ? C.lineSoft : '#dcfce7',
              color: auto?.enabled === false ? C.faint : C.ok,
            },
          }, auto?.enabled === false ? T.autoOff : T.autoOn),
          h('span', { style: { marginLeft: 'auto' } }),
          h('span', { style: { fontSize: 9.5, color: C.faint } }, T.autoShowInPicker),
          h('input', {
            type: 'checkbox',
            style: { ...S.checkbox, marginLeft: 2 },
            checked: auto?.enabled !== false,
            onChange: (event) => onAction('/auto/enable', { enabled: event.target.checked }),
          }),
        ),
        h('p', { style: { ...S.heroDesc, marginBottom: 10 } }, T.autoLead),

        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('span', { style: S.cardTitle }, T.autoCandTitle),
            h('span', { style: S.hint }, T.autoCandHint),
            h('span', { style: { marginLeft: 'auto' } }),
            h('button', { style: { ...S.btnStrong, height: 24 }, onClick: () => setAdding(true) }, T.autoAdd),
          ),
          candidates.length === 0
            ? h('div', { style: S.body }, h('div', { style: S.kv }, T.autoEmpty))
            : candidates.map((candidate, index) => h(AutoCandidateRow, {
                key: candidate.key,
                candidate,
                index,
                first: index === 0,
                last: index === candidates.length - 1,
                busy: busy === 'auto',
                onAction: (path, body) => onAction(path, body),
              })),
          h('div', {
            style: {
              padding: '8px 12px', borderTop: `1px solid ${C.lineSoft}`, background: C.raised,
              fontSize: 9.5, color: C.faint, lineHeight: 1.65,
            },
          }, T.autoCandFoot),
        ),

        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('span', { style: S.cardTitle }, T.autoPolicyTitle),
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, padding: '10px 12px 8px' } },
            CHIPS.map(([code, label]) => h('button', {
              key: code,
              style: { ...S.chip, ...(switchOn.includes(code) ? S.chipOn : {}) },
              onClick: () => toggleCode(code),
            }, label)),
          ),
          h('div', { style: S.policyRow },
            `${T.autoCoolLabel} `,
            h('input', {
              style: S.autoInput,
              defaultValue: String(Math.round((policy.coolMs ?? 60_000) / 1000)),
              onBlur: (event) => {
                const seconds = Math.max(5, Math.min(3600, Math.round(Number(event.target.value) || 60)))
                event.target.value = String(seconds)
                onAction('/auto/policy', { patch: { coolMs: seconds * 1000 } })
              },
            }),
            ` ${T.autoCoolUnit} · ${T.autoMaxLabel} `,
            h('input', {
              style: S.autoInput,
              defaultValue: String(policy.maxAttempts ?? 4),
              onBlur: (event) => {
                const count = Math.max(1, Math.min(16, Math.round(Number(event.target.value) || 4)))
                event.target.value = String(count)
                onAction('/auto/policy', { patch: { maxAttempts: count } })
              },
            }),
            ` ${T.autoMaxUnit} · ${T.autoPolicyTail}`,
          ),
          h('div', { style: { padding: '0 12px 10px', fontSize: 9.5, color: C.faint, lineHeight: 1.65 } }, T.autoPolicyNote),
        ),

        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('span', { style: S.cardTitle }, T.autoLogTitle),
            h('span', { style: S.hint }, T.autoLogHint),
            h('span', { style: { marginLeft: 'auto' } }),
            h('button', { style: { ...S.btnGhost, height: 18 }, onClick: () => onAction('/auto/history/clear', {}) }, T.autoLogClear),
          ),
          history.length === 0
            ? h('div', { style: S.body }, h('div', { style: S.kv }, T.autoLogEmpty))
            : h('div', { style: S.logScroll }, history.map((entry, index) => {
                const failed = (entry.attempts ?? []).filter((attempt) => attempt.result === 'fail')
                return h('div', { key: `${entry.at}-${index}`, style: S.logRow },
                  h('span', { style: S.logTime }, clock(entry.at).slice(0, 5)),
                  h('span', { style: S.logBody },
                    failed.length === 0
                      ? h('span', null, h('b', { style: { color: C.text, fontWeight: 600 } }, entry.used?.modelName ?? '—'), ' 首包')
                      : [
                          h('span', { key: 'f', style: { color: C.text, fontWeight: 600 } }, failed[0].modelName),
                          h('span', { key: 'c', style: S.logCode }, failed[0].code),
                          h('span', { key: 'a', style: { color: C.faint, margin: '0 2px' } }, '→'),
                        ],
                  ),
                  h('span', {
                    style: {
                      ...S.logResult,
                      color: entry.used === null ? C.bad : C.ok,
                    },
                  }, entry.used === null
                    ? `✕ ${T.autoLogFailAll}`
                    : `✓ ${entry.used.modelName} ${((entry.ms ?? 0) / 1000).toFixed(1)}s`),
                )
              })),
        ),

        adding
          ? h(AddCandidateModal, {
              auto,
              onClose: () => setAdding(false),
              onDone: async (items) => {
                setAdding(false)
                await onAction('/auto/candidates/add', { items })
              },
            })
          : null,
      )
    }

    function PlatformPanel({ platform, onAction, busy, onReload }) {
      const [expanded, setExpanded] = useState(null)
      const state = stateOf(platform.auth?.state)
      const quota = platform.quota ?? {}
      const accounts = Array.isArray(platform.accounts) ? platform.accounts : []
      const models = Array.isArray(platform.models) ? platform.models : []
      const enabledCount = typeof platform.enabledCount === 'number' ? platform.enabledCount : models.filter((m) => m.enabled).length
      const ratio = typeof quota.remaining === 'number' && typeof quota.total === 'number' && quota.total > 0
        ? Math.min(1, Math.max(0, quota.remaining / quota.total)) : null
      const checkIn = platform.checkIn ?? {}
      const checkInByAccount = Array.isArray(platform.checkInByAccount) ? platform.checkInByAccount : []

      // 签到只在「平台支持 + 当前账号有活动」时显示
      const showCheckIn = platform.checkInSupported === true && checkIn.unavailable !== true
      // 秒悟没有领取接口：2000 分是「打开 meoo 网页（登录态）」时自动到账的，
      // 所以那一栏只做检测 + 提示，不代领。
      const loginCheckIn = platform.provider === 'meoo'

      return h('div', null,
        // 余额
        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('span', { style: { ...S.dot, background: state.color } }),
            h('span', { style: S.cardTitle }, platform.displayName),
            h('span', { style: { fontSize: 11, color: state.color } }, state.text),
            (platform.accounts ?? []).find((a) => a.active)
              ? h('span', { style: { fontSize: 11.5, color: C.sub } }, (platform.accounts ?? []).find((a) => a.active).label)
              : null,
            platform.provider === 'codearts'
              ? h('label', { style: { ...S.settingItem, marginLeft: 10 }, title: T.concurrencyHint },
                h('span', { style: S.settingLabel }, T.concurrency),
                h('input', {
                  type: 'number', min: 1, max: 16, step: 1,
                  style: { ...S.settingInput, width: 42 },
                  value: (() => {
                    const n = Math.floor(Number(platform.options?.maxConcurrent ?? 2))
                    return Number.isFinite(n) && n >= 1 ? Math.min(n, 16) : 2
                  })(),
                  disabled: busy !== '',
                  onChange: (event) => {
                    const n = Math.floor(Number(event.target.value))
                    if (!Number.isFinite(n)) return
                    const clamped = Math.max(1, Math.min(16, n))
                    onAction({ path: '/option', body: { provider: 'codearts', key: 'maxConcurrent', value: clamped } })
                  },
                }),
              )
              : null,
            h('span', { style: { marginLeft: 'auto', ...S.hint } }, `${T.updated} ${clock(platform.lastRefreshMs)}`),
            h('button', {
              style: S.btn, disabled: busy !== '',
              onClick: () => onAction({ path: '/refresh' }),
            }, busy === 'refresh' ? T.refreshing : T.refresh),
          ),
          h('div', { style: S.body },
            h('div', { style: S.quotaRow },
              h('div', null,
                h('div', { style: S.qLabel }, T.remaining),
                quota.unlimited === true
                  ? h('div', { style: S.qValue }, '♾️', h('span', { style: S.qUnit }, '不限量'))
                  : h('div', { style: S.qValue }, num(quota.remaining), h('span', { style: S.qUnit }, '积分')),
              ),
              h('div', null,
                h('div', { style: S.qLabel }, T.models),
                h('div', { style: S.qValue }, String(enabledCount),
                  h('span', { style: S.qUnit }, `/ ${models.length}`)),
              ),
              quota.plan ? h('div', null, h('div', { style: S.qLabel }, T.plan), h('div', { style: S.kv }, String(quota.plan))) : null,
              quota.resetAt ? h('div', null, h('div', { style: S.qLabel }, T.cycle), h('div', { style: S.kv }, String(quota.resetAt))) : null,
            ),
            platform.lastError ? h('div', { style: S.err }, platform.lastError) : null,
          ),
        ),

        // 账号
        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('span', { style: S.cardTitle }, T.accounts),
            h('span', { style: S.hint }, T.accountHint),
            h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } },
              h(AddAccountModal, {
                platform,
                onDone: (outcome) => {
                  if (outcome.platforms) onReload(outcome.platforms)
                  else onAction({ path: '/refresh' })
                },
              }),
            ),
          ),
          h('div', { style: S.body },
            accounts.length === 0
              ? h('div', { style: S.kv }, T.noAccount)
              : accounts.map((account) => {
                  const quotaOf = (platform.quotaByAccount ?? []).find((entry) => entry.id === account.id) ?? {}
                  const record = (platform.checkInByAccount ?? []).find((entry) => entry.id === account.id)
                  const checkedIn = record !== undefined && record.alreadyCheckedIn === true
                  return h('div', {
                    key: account.id,
                    style: { ...S.acctRow, ...(account.active ? S.acctRowOn : {}) },
                  },
                    h('div', { style: { ...S.radio, ...(account.active ? S.radioOn : {}) } }),
                    h('span', { style: S.acctName }, account.label),
                    account.active ? h('span', { style: S.tag }, T.active) : null,
                    checkedIn ? h('span', { style: S.tagSigned }, T.signed) : null,
                    h('span', { style: { marginLeft: 14, fontSize: 11.5, color: C.sub } },
                      platform.auth?.state === 'expired'
                        ? h('span', { style: { color: C.bad } }, T.needReauth)
                        : quotaOf.error
                          ? h('span', { style: { color: C.bad } }, T.error)
                          : `${T.remaining} ${num(quotaOf.remaining)}`),
                    h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' } },
                      h('span', { style: { fontSize: 10.5, color: C.faint, marginRight: 6 } },
                        quotaOf.at ? `更新于 ${clock(quotaOf.at)}` : ''),
                      (account.active && (platform.auth?.state === 'expired' || quotaOf.error)) ? h(AddAccountModal, {
                        platform,
                        reauthId: account.id,
                        buttonLabel: T.reauth,
                        onDone: (outcome) => {
                          if (outcome.platforms) onReload(outcome.platforms)
                          else onAction({ path: '/refresh' })
                        },
                      }) : null,
                      account.active ? null : h('button', {
                        style: S.btnGhost,
                        onClick: () => onAction({ path: '/account/select', body: { provider: platform.provider, id: account.id } }),
                      }, T.switchTo),
                      h('button', {
                        style: S.btnGhost,
                        onClick: () => onAction({ path: '/account/remove', body: { provider: platform.provider, id: account.id } }),
                      }, T.remove),
                    ),
                  )
                }),
          ),
        ),

        // 模型
        h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('span', { style: S.cardTitle }, T.models),
            platform.provider === 'scnet'
              ? h(ScnetBasis, { inline: true })
              : h('span', { style: S.hint }, T.modelHint),
            h('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' } },
              platform.provider === 'scnet'
                ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 10 }, title: T.freeOnlyHint },
                  h('input', {
                    type: 'checkbox',
                    style: S.checkbox,
                    checked: platform.options?.scnetFreeOnly !== false,
                    onChange: (event) => onAction({
                      path: '/option',
                      body: { provider: 'scnet', key: 'scnetFreeOnly', value: event.target.checked },
                    }),
                  }),
                  h('span', { style: S.hint }, T.freeOnly),
                )
                : null,
              h('span', { style: { ...S.hint, marginRight: 2 } }, `${T.enabled} ${enabledCount}/${models.length}`),
              h('button', {
                style: S.btnGhost,
                onClick: () => onAction({ path: '/model/bulk', body: { provider: platform.provider, mode: 'all' } }),
              }, T.selectAll),
              h('button', {
                style: S.btnGhost,
                onClick: () => onAction({ path: '/model/bulk', body: { provider: platform.provider, mode: 'none' } }),
              }, T.selectNone),
            ),
          ),
          models.length === 0
            ? h('div', { style: S.body }, h('div', { style: S.kv }, T.noModels))
            : h('div', { style: { padding: '0 14px 14px' } },
                h('div', { style: S.scroll },
                  h('table', { style: S.table },
                    h('thead', null, h('tr', null,
                      h('th', { style: { ...S.th, width: 46 } }, T.use),
                      h('th', { style: S.th }, T.modelName),
                      h('th', { style: { ...S.th, width: 132 } }, T.badge),
                      h('th', { style: { ...S.th, width: 56 } }, '设置'),
                    )),
                    h('tbody', null, models.map((model) => {
                      const open = expanded === model.id
                      return [
                        h('tr', { key: model.id },
                          h('td', { style: S.td },
                            h('input', {
                              type: 'checkbox',
                              checked: model.enabled,
                              style: S.checkbox,
                              onChange: () => onAction({
                                path: '/model/patch',
                                body: { provider: platform.provider, id: model.id, patch: { enabled: !model.enabled } },
                              }),
                            }),
                          ),
                          h('td', { style: { ...S.td, ...(model.enabled ? {} : S.rowOff) }, title: model.name }, model.name),
                          h('td', { style: S.td },
                            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
                              model.badge
                                ? (/x?0(\.0+)?$/.test(String(model.badge).trim())
                                    ? h('span', { style: S.tagFree }, T.free)
                                    : h('span', { style: { fontSize: 11, color: C.sub } }, model.badge))
                                : h('span', { style: { color: C.faint } }, '—'),
                              model.promo ? h('span', {
                                style: { ...S.tagPromo, ...(model.promo.color ? { color: model.promo.color } : {}) },
                                title: model.promo.hover ?? model.promo.label,
                              }, model.promo.label) : null,
                            ),
                          ),
                          h('td', { style: S.td },
                            h('button', {
                              style: { ...S.btnGhost, padding: '0 6px' },
                              onClick: () => setExpanded(open ? null : model.id),
                            }, open ? '收起' : '设置'),
                          ),
                        ),
                        open
                          ? h('tr', { key: model.id + '-settings' },
                              h('td', { colSpan: 4, style: { ...S.td, background: C.raised } },
                                h('div', { style: { display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' } },
                                  h('label', { style: S.settingItem },
                                    h('span', { style: S.settingLabel }, T.context + ' (K)'),
                                    h('input', {
                                      type: 'number',
                                      defaultValue: Math.round((model.contextWindow ?? 0) / 1000),
                                      style: S.settingInput,
                                      onKeyDown: (event) => {
                                        if (event.key !== 'Enter') return
                                        const value = Number(event.currentTarget.value)
                                        if (!Number.isFinite(value) || value <= 0) return
                                        onAction({
                                          path: '/model/patch',
                                          body: { provider: platform.provider, id: model.id, patch: { contextWindow: Math.round(value * 1000) } },
                                        })
                                      },
                                    }),
                                  ),
                                  h('label', { style: S.settingItem },
                                    h('span', { style: S.settingLabel }, T.vision),
                                    h('input', {
                                      type: 'checkbox',
                                      checked: model.vision === true,
                                      style: S.checkbox,
                                      onChange: () => onAction({
                                        path: '/model/patch',
                                        body: { provider: platform.provider, id: model.id, patch: { vision: !model.vision } },
                                      }),
                                    }),
                                  ),
                                  h('label', { style: S.settingItem },
                                    h('span', { style: S.settingLabel }, T.thinking),
                                    (model.thinkingOptions ?? []).length === 0
                                      ? h('span', { style: { fontSize: 11, color: C.faint } }, '不支持')
                                      : h('select', {
                                          value: model.thinking ?? '',
                                          style: S.settingSelect,
                                          onChange: (event) => onAction({
                                            path: '/model/patch',
                                            body: { provider: platform.provider, id: model.id, patch: { thinking: event.currentTarget.value } },
                                          }),
                                        },
                                          (model.thinkingOptions ?? []).map((level) =>
                                            h('option', { key: level, value: level }, levelTone(level) + (model.thinkingIsDefault && level === model.thinking ? '（默认）' : '')),
                                          ),
                                        ),
                                  ),
                                ),
                              ),
                            )
                          : null,
                      ]
                    }).flat()),
                  ),
                ),
              ),
        ),

        // 签到（只在有活动时出现）：一行说完 —— 标题 · 状态胶囊 · 分值 · 按钮
        showCheckIn
          ? (() => {
              const ciFailed = typeof checkIn.error === 'string' && checkIn.error !== ''
              const ciDone = checkIn.alreadyCheckedIn === true
              const ciTone = ciFailed
                ? { fg: C.bad, bg: '#fef2f2', line: '#fecaca' }
                : ciDone
                  ? { fg: C.ok, bg: '#f0fdf4', line: '#bbf7d0' }
                  : { fg: C.warn, bg: '#fffbeb', line: '#fde68a' }
              const ciText = ciFailed ? `${T.error}：${checkIn.error}` : ciDone ? T.alreadyCheckedIn : T.pending
              const ciCredit = typeof checkIn.credit === 'number' && checkIn.credit > 0 ? `+${checkIn.credit}` : ''
              const ciStreak = typeof checkIn.streakDays === 'number' && checkIn.streakDays > 0
                ? `${T.streak} ${checkIn.streakDays} ${T.days}` : ''
              return h('div', { style: S.card },
                h('div', { style: S.ciRow },
                  h('span', { style: { ...S.cardTitle, whiteSpace: 'nowrap', flex: '0 0 auto' } }, '签到'),
                  h('span', {
                    style: {
                      ...S.ciPill, color: ciTone.fg, background: ciTone.bg,
                      border: `1px solid ${ciTone.line}`, maxWidth: 320, overflow: 'hidden',
                    },
                    title: ciText,
                  },
                    h('span', { style: { ...S.dot, background: ciTone.fg, flex: '0 0 auto' } }),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ciText)),
                  ciCredit !== '' ? h('span', { style: S.ciCredit }, ciCredit) : null,
                  ciStreak !== '' ? h('span', { style: S.ciStreak }, ciStreak) : null,
                  h('button', {
                    style: { ...S.ciBtn, ...(busy !== '' ? S.ciBtnOff : {}) },
                    disabled: busy !== '',
                    onClick: () => onAction({ path: '/checkin', body: { provider: platform.provider } }),
                  }, busy === 'checkin' ? T.checkingIn : loginCheckIn ? T.meooCheckInButton : T.checkInAll),
                ),
                // 多账号才有第二段：每行 名字 · 状态 · 分值 · 时刻
                checkInByAccount.length > 1
                  ? h('div', { style: S.ciList },
                      checkInByAccount.map((record) => {
                        const recFailed = typeof record.error === 'string' && record.error !== ''
                        const recTone = recFailed
                          ? C.bad
                          : record.unavailable === true ? C.faint : record.alreadyCheckedIn === true ? C.ok : C.warn
                        const recText = recFailed
                          ? T.error
                          : record.unavailable === true ? '无活动' : record.alreadyCheckedIn === true ? T.alreadyCheckedIn : T.pending
                        return h('div', { key: record.id, style: S.ciListItem },
                          h('span', { style: S.ciListName, title: record.label }, record.label),
                          h('span', { style: { color: recTone, fontWeight: 500, flex: '0 0 auto' } }, recText),
                          typeof record.credit === 'number' && record.credit > 0
                            ? h('span', { style: S.ciCredit }, `+${record.credit}`)
                            : null,
                          typeof record.at === 'number'
                            ? h('span', { style: S.ciListTime },
                                new Date(record.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
                            : null,
                        )
                      }),
                    )
                  : null,
              )
            })()
          : null,
      )
    }


    /**
     * 会话区左侧的积分胶囊。
     *
     * 只在「当前会话选中的模型属于模型池」时出现：直接读模型选择器的
     * 当前选择（modelDirectories 的 store），而不是猜「最近用过谁」。
     * 读不到选择就干脆不显示，宁可不显示也不显示错的。
     *
     * 胶囊展示「账号名 · 剩余积分」；渠道有多个账号时尾部带「切换」，
     * 点开列出该渠道全部账号与各自积分，点击即切换（全局生效）。
     */
    /**
     * 会话区的 Auto 胶囊。
     *
     * 选具体模型时胶囊显示「账号 · 剩余积分」；选 Auto 时没有固定账号可言，
     * 所以显示本轮实际用到的模型和切换次数 —— 这是 Auto 唯一的透明度来源。
     */
    function AutoCreditPill({ auto }) {
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const wrapRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      const route = auto?.lastRoute ?? null
      const used = route?.used ?? null
      const switched = route?.switched ?? 0

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        const rect = wrapRef.current?.getBoundingClientRect()
        if (rect !== undefined) {
          setAnchor({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 318)),
            bottom: Math.max(8, window.innerHeight - rect.top + 6),
          })
        }
        setOpen(true)
      }

      const attempts = Array.isArray(route?.attempts) ? route.attempts : []

      return h('div', { ref: wrapRef, style: { display: 'inline-flex' } },
        h('button', {
          style: { ...S.creditPill, cursor: 'pointer' },
          onClick: toggle,
          title: 'Auto 模式：按候选优先级兜底换模型',
        },
          h('span', { style: { ...S.creditName, maxWidth: 70 } }, 'Auto'),
          used === null
            ? null
            : h('span', { style: { maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' } }, used.modelName),
          switched > 0
            ? h('span', { style: S.switchBtn }, `${T.autoPillSwitch} ${switched}`)
            : null,
          h('span', { style: { color: C.faint, fontSize: 9 } }, open ? '▾' : '▴'),
        ),
        open
          ? h('div', {
              style: {
                ...S.switchPanel,
                width: 310,
                left: anchor?.left ?? 8,
                bottom: anchor?.bottom ?? 60,
                padding: 0,
              },
            },
              h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 11px 6px',
                },
              },
                h('span', { style: { fontSize: 11, fontWeight: 600 } }, T.autoPillRoute),
                h('span', {
                  style: { marginLeft: 'auto', fontSize: 9, color: C.faint, fontVariantNumeric: 'tabular-nums' },
                }, route === null ? '' : `${clock(route.at)} · ${((route.ms ?? 0) / 1000).toFixed(1)}s`),
              ),
              attempts.length === 0
                ? h('div', { style: { padding: '6px 11px 9px', fontSize: 9.5, color: C.faint } }, T.autoLogEmpty)
                : attempts.map((attempt, index) => h('div', {
                    key: `${attempt.model}-${index}`,
                    style: {
                      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 11px',
                      borderTop: `1px solid ${C.lineSoft}`, fontSize: 9.5, color: C.sub, minWidth: 0,
                    },
                  },
                    h('span', {
                      style: {
                        flex: '0 0 auto', fontWeight: 700,
                        color: attempt.result === 'ok' ? C.ok : C.bad,
                      },
                    }, attempt.result === 'ok' ? '✓' : '✕'),
                    h('span', {
                      style: {
                        color: C.text, fontWeight: 600, whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
                      },
                    }, attempt.modelName ?? attempt.model),
                    h('span', { style: { whiteSpace: 'nowrap' } }, `${attempt.providerName} / ${attempt.accountLabel ?? ''}`),
                    attempt.code === null || attempt.code === undefined
                      ? null
                      : h('span', {
                          style: { background: '#fef2f2', color: C.bad, borderRadius: 3, padding: '0 4px', fontSize: 9 },
                        }, attempt.code),
                    h('span', { style: { marginLeft: 'auto', color: C.faint, flex: '0 0 auto' } }, `${((attempt.ms ?? 0) / 1000).toFixed(1)}s`),
                  )),
              h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 11px',
                  borderTop: `1px solid ${C.lineSoft}`, background: C.raised, fontSize: 9.5, color: C.faint,
                },
              }, `冷却中 ${auto?.coolingCount ?? 0} 条 · 点设置里的「魔桥 → Auto 模式」调整`),
            )
          : null,
      )
    }

    function CreditPill(props) {
      const [state, setState] = useState(null)
      const [selected, setSelected] = useState(null)
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const [busy, setBusy] = useState(null)
      const wrapRef = useRef(null)

      // 订阅当前会话的模型选择
      useEffect(() => {
        const ctxApi = props?.ctx ?? globalThis.__DSH_PLUGIN_CTX__
        if (ctxApi === undefined) return undefined
        let unsubscribe
        try {
          const uiSession = ctxApi.get?.('uiSession')
          const directories = ctxApi.get?.('modelDirectories')
          const sessionId = uiSession?.current?.value?.key
          if (sessionId !== undefined && directories !== undefined) {
            const directory = directories.directoryFor(sessionId)
            const snapshot = directory?.store?.getSnapshot?.()
            setSelected(snapshot?.current ?? null)
            unsubscribe = directory?.store?.subscribe?.(() => {
              setSelected(directory.store.getSnapshot()?.current ?? null)
            })
          }
        } catch {
          setSelected(null)
        }
        return () => {
          try {
            unsubscribe?.()
          } catch {
            // 忽略
          }
        }
      }, [props])

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const next = await api('/status')
            if (alive) setState(next)
          } catch {
            if (alive) setState(null)
          }
        }
        void load()
        const timer = setInterval(() => void load(), 20_000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      // 点面板外部关闭
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      const provider = selected?.provider
      // Auto 没有「平台/账号」可言，走另一套胶囊
      if (provider === 'auto') return h(AutoCreditPill, { auto: state?.auto })
      if (!['workbuddy', 'codearts', 'meoo', 'scnet', 'lingxi', 'raccoon'].includes(provider)) return null
      if (state === null) return null

      const platform = (state.platforms ?? []).find((item) => item.provider === provider)
      if (platform === undefined) return null

      const accounts = Array.isArray(platform.accounts) ? platform.accounts : []
      const active = accounts.find((account) => account.active)
      const label = active?.label ?? T.noAccountShort
      const canSwitch = accounts.length > 1
      const quotaOf = (id) => (platform.quotaByAccount ?? []).find((entry) => entry.id === id) ?? {}
      const at = quotaOf(active?.id)?.at

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        const rect = wrapRef.current?.getBoundingClientRect()
        if (rect !== undefined) {
          setAnchor({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 258)),
            bottom: Math.max(8, window.innerHeight - rect.top + 6),
            maxHeight: Math.max(120, rect.top - 16),
          })
        }
        setOpen(true)
      }

      const switchTo = async (account) => {
        if (account.active || busy !== null) {
          setOpen(false)
          return
        }
        setBusy(account.id)
        try {
          const next = await api('/account/select', { provider, id: account.id })
          if (Array.isArray(next?.platforms)) setState((prev) => ({ ...(prev ?? {}), platforms: next.platforms }))
          setOpen(false)
        } catch {
          // 失败保持面板打开，用户可重试
        } finally {
          setBusy(null)
        }
      }

      // 外层用 div：浮层是 div，不能塞进 span（span 只允许短语内容）。
      return h('div', { ref: wrapRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('span', {
          title: `${platform.displayName} · ${label}${at ? ` · 更新 ${clock(at)}` : ''}`,
          style: S.creditPill,
        },
          h('span', { style: S.creditName }, label),
          h('span', { style: { color: C.faint } }, '·'),
          h('span', null, `剩余积分 ${quotaText(platform.quota)}`),
          canSwitch
            ? h('button', {
                type: 'button',
                style: S.switchBtn,
                onClick: toggle,
              }, open ? T.switchClose : T.switchUser)
            : null,
        ),
        open
          ? h('div', { style: { ...S.switchPanel, ...(anchor ?? {}) } },
              h('div', { style: S.switchHint }, T.switchGlobal),
              accounts.map((account) => {
                const quota = quotaOf(account.id)
                return h('button', {
                  key: account.id,
                  type: 'button',
                  disabled: busy !== null,
                  onClick: () => void switchTo(account),
                  style: {
                    ...S.switchRow,
                    ...(account.active ? S.switchRowOn : {}),
                    ...(busy !== null && busy !== account.id ? { opacity: 0.55 } : {}),
                  },
                },
                  h('span', { style: { ...S.radio, ...(account.active ? S.radioOn : {}) } }),
                  h('span', { style: S.switchName }, account.label),
                  h('span', { style: S.switchQuota }, busy === account.id ? T.switchBusy : quotaText(quota)),
                  quota.at ? h('span', { style: S.switchTime }, clock(quota.at)) : null,
                )
              }),
            )
          : null,
      )
    }

    /** 概览页的一张平台卡片（尺寸对齐设置面板实际宽度）。 */
    function PlatformCard({ platform, onManage, onReload }) {
      const provider = platform.provider
      const state = stateOf(platform.auth?.state)
      const accounts = Array.isArray(platform.accounts) ? platform.accounts : []
      const activeAccount = accounts.find((account) => account.active)
      const models = Array.isArray(platform.models) ? platform.models : []
      const enabledCount = typeof platform.enabledCount === 'number'
        ? platform.enabledCount
        : models.filter((model) => model.enabled).length
      const quota = platform.quota ?? {}
      const remaining = quota.remaining
      const checkIn = platform.checkIn ?? {}
      const expired = platform.auth?.state === 'expired'
      // 灵犀的积分叫「智点」，SCNet 没有余额接口 —— 口径要按平台说清楚
      const quotaLabel = provider === 'lingxi' ? T.uniCredits : T.avgRemaining
      const quotaValue = quotaText(quota)
      const quotaHint = quota.unlimited === true
        ? '不限量'
        : typeof remaining === 'number'
          ? clock(platform.lastRefreshMs)
          : expired ? '需重新认证'
            : platform.auth?.state === 'signed-out' ? '未登录'
              : '读取失败'

      const foot = (() => {
        if (expired) {
          return [
            h('span', { key: 't', style: { ...S.tagSmall, background: '#fee2e2', color: C.bad } }, T.expired),
            h(AddAccountModal, {
              key: 'a',
              platform,
              reauthId: activeAccount?.id,
              buttonLabel: T.reauth,
              onDone: (outcome) => {
                if (outcome.platforms) onReload(outcome.platforms)
              },
            }),
          ]
        }
        const parts = []
        if (provider === 'scnet') parts.push(h('span', { key: 'f', style: { ...S.tagSmall, background: '#dcfce7', color: C.ok } }, '限时免费'))
        if (platform.checkInSupported === true) {
          // 注意字段名：manager 落盘的是 alreadyCheckedIn，不是 todayCheckedIn
          parts.push((checkIn.alreadyCheckedIn === true || checkIn.todayCheckedIn === true)
            ? h('span', { key: 'c', style: { ...S.tagSmall, background: '#dcfce7', color: C.ok } }, T.signed)
            : h('span', { key: 'c', style: { ...S.tagSmall, background: '#fef3c7', color: C.warn } }, T.pending))
          if (typeof checkIn.streakDays === 'number' && checkIn.streakDays > 0) {
            parts.push(h('span', { key: 's', style: S.footText }, `${T.streak} ${checkIn.streakDays} ${T.days}`))
          }
        } else if (parts.length === 0) {
          parts.push(h('span', { key: 'n', style: S.footText }, T.noCheckIn))
        }
        if (provider === 'scnet' && parts.length < 2) {
          parts.push(h('span', { key: 'm', style: S.footText }, 'SCNet-Max'))
        }
        return parts
      })()

      return h('div', { style: { ...S.pcard, ...(expired ? S.pcardBad : {}) } },
        h('div', { style: S.pcHead },
          h('span', { style: { ...S.dot, background: state.color } }),
          h('span', { style: S.pcName, title: platform.displayName }, platform.displayName),
          h('span', { style: { ...S.pcState, color: state.color } }, state.text),
          h('button', { style: S.pcMng, onClick: () => onManage(provider) }, T.manage),
        ),
        h('div', { style: S.pcMetrics },
          h('div', { style: S.metric },
            h('div', { style: S.metricK }, quotaLabel),
            h('div', { style: { ...S.metricV, ...(typeof remaining === 'number' ? {} : { color: C.faint }) } }, typeof remaining === 'number' ? quotaValue : '—'),
            h('div', { style: S.metricS }, quotaHint),
          ),
          h('div', { style: { ...S.metric, ...S.metricGap } },
            h('div', { style: S.metricK }, T.models),
            h('div', { style: S.metricV }, String(enabledCount), h('span', { style: S.metricUnit }, `/ ${models.length}`)),
            h('div', { style: S.metricS }, `${T.enabled} ${enabledCount}`),
          ),
        ),
        h('div', { style: S.pcAcct },
          h('span', { style: S.pcAcctName, title: activeAccount?.label ?? '' }, activeAccount?.label ?? T.noAccountShort),
          h('span', { style: S.pcAcctCount }, `${T.acctCount} ${accounts.length} 个`),
        ),
        h('div', { style: S.pcFoot }, ...foot),
      )
    }

    /** 概览页里的一行设置：开关 + ⓘ（点开弹窗看详细说明）。 */
    function PickerPreferenceRow() {
      const prefs = usePrefs()
      const on = prefs.useGatewayPicker !== false
      const [helpOpen, setHelpOpen] = useState(false)
      return h(React.Fragment, null,
        h('div', { style: S.prefRow },
          h('span', { style: S.prefLabel }, '使用魔桥模型选择器'),
          h('button', {
            type: 'button', 'aria-label': '魔桥模型选择器说明',
            style: S.help,
            onClick: () => setHelpOpen(true),
          }, '?'),
          h('span', { style: S.prefGrow }),
          h('button', {
            type: 'button', role: 'switch', 'aria-checked': on,
            'aria-label': '使用魔桥模型选择器',
            style: on ? S.switchOn : S.switchOff,
            onClick: () => { writePrefs({ useGatewayPicker: !on }) },
          }, h('span', { style: on ? S.switchKnobOn : S.switchKnobOff })),
        ),
        helpOpen ? h('div', { style: S.overlay, onClick: () => setHelpOpen(false) },
          h('div', { style: S.modal, onClick: (e) => e.stopPropagation() },
            h('div', { style: S.modalHead }, h('span', { style: S.modalTitle }, '魔桥模型选择器')),
            h('div', { style: S.optionDesc }, '开启后，对话里点模型时，魔桥旗下各平台收进一个可折叠的「魔桥」分组，Auto 置顶显示；勾选过的模型按平台分组折叠，默认只展开当前正在用的那一组。'),
            h('div', { style: { ...S.optionDesc, marginTop: 8 } }, '关闭则回到 DSH 原生选择器，魔桥的模型不再出现在对话里。'),
            h('div', { style: { ...S.optionDesc, marginTop: 8, color: C.faint } }, '这个开关只影响对话里的选择器界面，不影响设置页里的平台与模型配置。'),
          ),
        ) : null,
      )
    }

    /** 状态点颜色：网关/平台都按语义色。 */
    function gwDotColor(ok, accent) {
      return ok ? (accent ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : C.ok) : C.faint
    }

    /** 网关行的主开关：立即 start/stop，切完让上层立刻 load 一次刷新状态。 */
    function GatewaySwitch({ gw, t, onToggle, busy }) {
      const on = gw?.enabled === true
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': on,
        'aria-label': t('gateway.toggleLabel'), title: t('gateway.toggleLabel'),
        disabled: busy,
        style: { ...S.rowSwitch, ...(on ? S.rowSwitchOn : S.rowSwitchOff), ...(busy ? S.smallBtnOff : {}) },
        onClick: () => onToggle(!on),
      }, h('span', { style: S.rowSwitchKnob }))
    }

    /**
     * 概览卡片式的网关卡（置顶，先于 Auto 卡与平台卡）。
     *
     * 卡片式是 AutoCard/PlatformCard 的原样复用，网关原本没有对应卡片，
     * 切过去就丢了入口。这里用与平台卡同一套头部/指标栅格补一张，
     * 交互（主开关 / 管理）与列表式完全一致。
     */
    function GatewayCard({ gw, t, onManage, onToggle, busy }) {
      const running = gw?.running === true
      const enabled = gw?.enabled === true
      const label = enabled ? (running ? t('gateway.open') : t('gateway.stopped')) : t('gateway.closed')
      const addr = gw?.address?.url ?? null
      const requestUrl = gw?.baseUrl ?? (addr === null ? '—' : `${addr}/v1`)
      return h('div', { style: S.gwCard },
        h('div', { style: S.pcHead },
          h('span', { style: { ...S.dot, background: gwDotColor(enabled && running, true) } }),
          h('span', { style: S.pcName }, t('gateway.name')),
          h('span', {
            style: {
              ...S.pcState,
              padding: '0 5px', borderRadius: 4, lineHeight: '16px', fontWeight: 500,
              background: running ? '#dcfce7' : C.lineSoft, color: running ? C.ok : C.faint,
            },
          }, label),
          h(GatewaySwitch, { gw, t, onToggle, busy }),
          h('button', { style: S.pcMng, onClick: onManage }, t('gateway.manage')),
        ),
        h('div', { style: S.pcMetrics },
          h('div', { style: S.metric },
            h('div', { style: S.metricK }, t('gateway.listen')),
            h('div', {
              style: { ...S.metricV, fontSize: 11.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              title: gw?.lastError || requestUrl,
            }, requestUrl),
          ),
          h('div', { style: { ...S.metric, ...S.metricGap } },
            h('div', { style: S.metricK }, t('gateway.keys')),
            h('div', { style: S.metricV }, String(gw?.keyCount ?? 0)),
          ),
          h('div', { style: { ...S.metric, ...S.metricGap } },
            h('div', { style: S.metricK }, t('gateway.todayRequests')),
            h('div', { style: S.metricV }, String(gw?.today?.requests ?? 0)),
          ),
        ),
      )
    }

    /** 概览列表式的网关行（置顶）。 */
    function GatewayRow({ gw, t, onManage, onToggle, busy }) {
      const running = gw?.running === true
      const enabled = gw?.enabled === true
      const label = enabled ? (running ? t('gateway.open') : t('gateway.stopped')) : t('gateway.closed')
      const addr = gw?.address?.url ?? null
      return h('div', { style: { ...S.row, ...S.rowGw } },
        h('span', { style: { ...S.dot, background: gwDotColor(enabled && running, true) } }),
        h('span', { style: { ...S.rowName, ...S.rowNameGw } }, t('gateway.name')),
        h('span', {
          style: {
            fontSize: 9.5, padding: '0 5px', borderRadius: 4, lineHeight: '16px', fontWeight: 500,
            background: running ? '#dcfce7' : C.lineSoft, color: running ? C.ok : C.faint,
            flex: '0 0 auto', whiteSpace: 'nowrap',
          },
        }, label),
        h('div', { style: S.rowMeta },
          h('span', {
            style: S.mono,
            title: gw?.lastError || `${t('gateway.listen')} ${addr ?? '—'}`,
          }, addr ?? '—'),
          h('span', { style: S.rowMetaSep }, '·'),
          h('span', null, h('b', { style: S.rowMetaB }, String(gw?.keyCount ?? 0)), ' ', t('gateway.keys')),
          h('span', { style: S.rowMetaSep }, '·'),
          h('span', null, t('gateway.todayRequests'), ' ', h('b', { style: S.rowMetaB }, String(gw?.today?.requests ?? 0))),
        ),
        h('span', { style: S.rowSwLabel }, t('gateway.toggleLabel')),
        h(GatewaySwitch, { gw, t, onToggle, busy }),
        h('button', { style: { ...S.rowBtn, ...S.rowBtnStrong }, onClick: onManage }, t('gateway.manage')),
      )
    }

    /** 概览列表式的 Auto 行。 */
    function AutoRow({ auto, t, onManage }) {
      if (auto === undefined || auto === null) return null
      const enabled = auto.enabled !== false
      const chain = Array.isArray(auto.chain) ? auto.chain : []
      return h('div', { style: S.row },
        h('span', { style: { ...S.dot, background: gwDotColor(enabled) } }),
        h('span', { style: S.rowName }, T.autoName),
        h('span', {
          style: {
            fontSize: 9.5, padding: '0 5px', borderRadius: 4, lineHeight: '16px', fontWeight: 500,
            background: enabled ? '#dcfce7' : C.lineSoft, color: enabled ? C.ok : C.faint,
            flex: '0 0 auto', whiteSpace: 'nowrap',
          },
        }, enabled ? T.autoOn : T.autoOff),
        h('div', { style: S.rowMeta },
          h('span', null, h('b', { style: S.rowMetaB }, String(auto.availableCount ?? 0)), '/', String(auto.candidateCount ?? 0), ' 可用'),
          h('span', { style: S.rowMetaSep }, '·'),
          h('span', null, '24h ', T.autoSwitch24h, ' ', h('b', { style: S.rowMetaB }, String(auto.switchCount24h ?? 0))),
          h('span', { style: S.rowMetaSep }, '·'),
          h('span', null, T.autoCooling, ' ', h('b', { style: S.rowMetaB }, String(auto.coolingCount ?? 0))),
          chain.length > 0
            ? h('span', { style: S.rowRoute },
                ...chain.slice(0, 4).map((entry, index) => h('span', {
                  key: `${entry.key}-${index}`,
                  style: S.routeNode,
                }, entry.modelName ?? entry.providerName ?? '—')))
            : null,
        ),
        h('button', { style: { ...S.rowBtn, marginLeft: 'auto' }, onClick: onManage }, T.manage),
      )
    }

    /** 概览列表式的平台行：一行塞下余额/模型/账号/签到，不省略。 */
    function PlatformRow({ platform, onManage, onReload }) {
      const provider = platform.provider
      const state = stateOf(platform.auth?.state)
      const accounts = Array.isArray(platform.accounts) ? platform.accounts : []
      const models = Array.isArray(platform.models) ? platform.models : []
      const enabledCount = typeof platform.enabledCount === 'number'
        ? platform.enabledCount : models.filter((model) => model.enabled).length
      const quota = platform.quota ?? {}
      const checkIn = platform.checkIn ?? {}
      const expired = platform.auth?.state === 'expired'
      const quotaLabel = provider === 'lingxi' ? T.uniCredits : T.avgRemaining
      const checkInNode = (() => {
        if (!platform.checkInSupported) return null
        const checked = checkIn.alreadyCheckedIn === true || checkIn.todayCheckedIn === true
        return h('span', {
          style: {
            fontSize: 9.5, padding: '0 5px', borderRadius: 4, lineHeight: '16px', flex: '0 0 auto',
            background: checked ? '#dcfce7' : '#fef3c7', color: checked ? C.ok : C.warn,
          },
        }, checked ? (typeof checkIn.streakDays === 'number' && checkIn.streakDays > 0
          ? `${T.signed} ${checkIn.streakDays}${T.days}` : T.signed) : T.pending)
      })()
      return h('div', { style: S.row },
        h('span', { style: { ...S.dot, background: state.color } }),
        h('span', { style: S.rowName, title: platform.displayName }, platform.displayName),
        h('span', { style: { ...S.rowState, color: state.color } }, state.text),
        h('div', { style: S.rowMeta },
          h('span', null, quotaLabel, ' ', h('b', { style: S.rowMetaB }, quotaText(quota))),
          h('span', { style: S.rowMetaSep }, '·'),
          h('span', null, T.models, ' ', h('b', { style: S.rowMetaB }, String(enabledCount)), '/', String(models.length)),
          h('span', { style: S.rowMetaSep }, '·'),
          h('span', null, T.acctCount, ' ', h('b', { style: S.rowMetaB }, String(accounts.length)), ' 个'),
          checkInNode,
          provider === 'scnet'
            ? h('span', { style: { fontSize: 9.5, padding: '0 5px', borderRadius: 4, lineHeight: '16px', background: '#fef3c7', color: C.warn, flex: '0 0 auto' } }, '限时免费')
            : null,
        ),
        expired
          ? h(AddAccountModal, { platform, reauthId: accounts.find((a) => a.active)?.id, buttonLabel: T.reauth,
              onDone: (outcome) => { if (outcome.platforms) onReload(outcome.platforms) } })
          : null,
        h('button', { style: { ...S.rowBtn, ...S.rowBtnStrong, marginLeft: 'auto' }, onClick: () => onManage(provider) }, T.manage),
      )
    }

    /** 复制按钮：优先用 clipboard API，失败退回 execCommand，不弹 alert。 */
    function copyText(text, t, onCopied) {
      const done = () => onCopied?.(t('gateway.copied'))
      try {
        if (globalThis.navigator?.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => {})
          return
        }
      } catch { /* 落到下面的兜底 */ }
      try {
        const el = document.createElement('textarea')
        el.value = text
        el.style.position = 'fixed'
        el.style.opacity = '0'
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        el.remove()
        done()
      } catch { /* 复制失败不折腾用户 */ }
    }

    /** 新增 Key 弹窗：创建成功后全文只在这一个弹窗里出现一次。 */
    function AddKeyModal({ t, onCreated, onDone }) {
      const [open, setOpen] = useState(false)
      const [name, setName] = useState('')
      const [secret, setSecret] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [copied, setCopied] = useState(false)
      const close = () => { setOpen(false); setName(''); setSecret(null); setError(''); setCopied(false) }
      const create = async () => {
        setBusy(true); setError('')
        try {
          const result = await onCreated(name)
          setSecret(result?.key ?? '')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }
      return h(React.Fragment, null,
        h('button', { style: { ...S.smallBtn, ...S.smallBtnAccent }, onClick: () => setOpen(true) }, t('gateway.addKey')),
        open ? h('div', { style: S.overlay, onClick: secret !== null ? undefined : close },
          h('div', { style: S.modal, onClick: (event) => event.stopPropagation() },
            h('div', { style: S.modalHead }, h('span', { style: S.modalTitle },
              secret === null ? t('gateway.addKeyTitle') : t('gateway.secretOnce'))),
            secret === null
              ? h('div', null,
                  h('div', { style: S.field },
                    h('label', { style: S.fieldLabel }, t('gateway.keyName')),
                    h('input', {
                      style: S.fieldInput, value: name, placeholder: t('gateway.addKeyName'),
                      onChange: (event) => setName(event.target.value),
                    })),
                  error ? h('div', { style: S.err }, error) : null,
                  h('div', { style: S.modalFoot },
                    h('button', { style: { ...S.btn, ...S.smallBtnAccent }, disabled: busy, onClick: create },
                      busy ? t('gateway.creating') : t('gateway.create')),
                    h('button', { style: S.btn, onClick: close }, t('gateway.cancel')),
                    h('span', { style: S.modalHint }, t('gateway.hashOnly')),
                  ),
                )
              : h('div', null,
                  h('div', { style: S.secretBox },
                    h('div', { style: S.secretKey }, t('gateway.secretOnce')),
                    h('div', { style: S.secretVal }, secret),
                  ),
                  h('div', { style: S.modalFoot },
                    h('button', { style: { ...S.btn, ...S.smallBtnAccent }, onClick: () => copyText(secret, t, setCopied) },
                      copied ? t('gateway.copied') : t('gateway.copyKey')),
                    h('button', { style: S.btn, onClick: () => { close(); onDone?.() } }, t('gateway.done')),
                    h('span', { style: S.modalHint }, t('gateway.hashOnly')),
                  ),
                ),
          ),
        ) : null,
      )
    }

    /** 新增别名弹窗。 */
    function AddAliasModal({ t, onCreated }) {
      const [open, setOpen] = useState(false)
      const [name, setName] = useState('')
      const [target, setTarget] = useState('')
      const [error, setError] = useState('')
      const close = () => { setOpen(false); setName(''); setTarget(''); setError('') }
      const submit = async () => {
        setError('')
        try {
          await onCreated(name, target)
          close()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }
      return h(React.Fragment, null,
        h('button', { style: S.smallBtn, onClick: () => setOpen(true) }, t('gateway.addAlias')),
        open ? h('div', { style: S.overlay, onClick: close },
          h('div', { style: S.modal, onClick: (event) => event.stopPropagation() },
            h('div', { style: S.modalHead }, h('span', { style: S.modalTitle }, t('gateway.addAliasTitle'))),
            h('div', { style: S.field },
              h('label', { style: S.fieldLabel }, t('gateway.alias')),
              h('input', { style: S.fieldInput, value: name, placeholder: t('gateway.aliasPlaceholder'),
                onChange: (event) => setName(event.target.value) })),
            h('div', { style: S.field },
              h('label', { style: S.fieldLabel }, t('gateway.target')),
              h('input', { style: S.fieldInput, value: target, placeholder: t('gateway.targetPlaceholder'),
                onChange: (event) => setTarget(event.target.value) })),
            error ? h('div', { style: S.err }, error) : null,
            h('div', { style: S.modalFoot },
              h('button', { style: { ...S.btn, ...S.smallBtnAccent }, onClick: submit }, t('gateway.create')),
              h('button', { style: S.btn, onClick: close }, t('gateway.cancel')),
            ),
          ),
        ) : null,
      )
    }

    /** 网关管理面板。t 由 PoolPage 从 ctx.locale.bind 传下来，不硬编码中文。 */
    function GatewayPanel({ gw, t, onAction, busy, onBack }) {
      const running = gw?.running === true
      const enabled = gw?.enabled === true
      const cfg = gw?.config ?? {}
      const keys = Array.isArray(gw?.keys) ? gw.keys : []
      const aliases = gw?.aliases ?? {}
      const candidates = Array.isArray(gw?.candidates) ? gw.candidates : []
      const baseUrl = gw?.baseUrl ?? (running ? `${gw?.address?.url ?? ''}/v1` : null)
      const curl = `curl ${baseUrl ?? '<base-url>'}/chat/completions \\\n  -H "Authorization: Bearer <key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"mg-auto","messages":[{"role":"user","content":"hi"}]}'`
      const [copied, setCopied] = useState('')
      const markCopied = (what) => { setCopied(what); setTimeout(() => setCopied(''), 1500) }
      const [draft, setDraft] = useState({
        host: cfg.host ?? '127.0.0.1', port: String(cfg.port ?? 8765),
        concurrency: String(cfg.limits?.concurrency ?? cfg.concurrency ?? 4),
        perMinute: String(cfg.limits?.perMinute ?? cfg.perMinute ?? 120),
      })
      useEffect(() => {
        setDraft({
          host: cfg.host ?? '127.0.0.1', port: String(cfg.port ?? 8765),
          concurrency: String(cfg.limits?.concurrency ?? cfg.concurrency ?? 4),
          perMinute: String(cfg.limits?.perMinute ?? cfg.perMinute ?? 120),
        })
      }, [cfg.host, cfg.port, cfg.limits?.concurrency, cfg.limits?.perMinute])

      const saveConfig = (patch) => {
        void onAction({ path: '/gateway/config', body: patch })
      }

      return h('div', null,
        h('div', { style: S.panelTop },
          h('button', { style: S.backBtn, onClick: onBack, style: { ...S.backBtn, marginBottom: 0 } }, t('gateway.back')),
          h('span', { style: S.panelTitle }, t('gateway.name')),
          h('span', { style: running ? S.panelTagOn : S.panelTagOff }, running ? t('gateway.running') : t('gateway.notRunning')),
          h('span', { style: { marginLeft: 'auto' } }),
          h('span', { style: S.rowSwLabel }, t('gateway.toggleLabel')),
          h(GatewaySwitch, { gw, t, busy, onToggle: (next) => onAction({ path: '/gateway/toggle', body: { enabled: next } }) }),
        ),
        gw?.lastError ? h('div', { style: S.err }, `${t('gateway.errorPrefix')}${gw.lastError}`) : null,

        // 接入信息：不要 API Key 行（用户明确要求删掉）
        h('div', { style: S.sec },
          h('div', { style: S.secTitle }, t('gateway.accessInfo')),
          h('div', { style: S.secSub }, t('gateway.accessHint')),
          h('div', { style: S.secCard },
            h('div', { style: S.gwKv },
              h('span', { style: S.gwKvLabel }, t('gateway.baseUrl')),
              h('span', { style: { ...S.mono, ...S.gwKvGrow }, title: baseUrl ?? '' }, baseUrl ?? '—'),
              h('button', {
                style: S.smallBtn, disabled: baseUrl === null,
                onClick: () => copyText(baseUrl ?? '', t, () => markCopied('base')),
              }, copied === 'base' ? t('gateway.copied') : t('gateway.copy')),
            ),
            h('div', { style: { ...S.gwKv, ...S.gwKvLast } },
              h('span', { style: S.gwKvLabel }, t('gateway.model')),
              h('span', { style: { ...S.mono, ...S.gwKvGrow } }, 'mg-auto'),
              h('button', {
                style: S.smallBtn,
                onClick: () => copyText(curl, t, () => markCopied('curl')),
              }, copied === 'curl' ? t('gateway.copied') : t('gateway.copyCurl')),
            ),
          ),
        ),

        // 监听与安全
        h('div', { style: S.sec },
          h('div', { style: S.secTitle }, t('gateway.listenSecurity')),
          h('div', { style: S.secSub }, t('gateway.listenHint')),
          h('div', { style: S.secCard },
            h('div', { style: S.gwKv },
              h('span', { style: S.gwKvLabel }, t('gateway.bind')),
              h('select', {
                style: S.gwKvSelect, value: draft.host,
                onChange: (event) => {
                  const value = event.target.value
                  setDraft((prev) => ({ ...prev, host: value }))
                  saveConfig({ host: value })
                },
              },
                candidates.map((entry) => h('option', { key: entry.host, value: entry.host },
                  entry.host === '127.0.0.1' ? t('gateway.bindLocal') : entry.label)),
              ),
            ),
            h('div', { style: S.gwKv },
              h('span', { style: S.gwKvLabel }, t('gateway.port')),
              h('input', {
                type: 'number', min: 1, max: 65535, style: S.gwKvInput, value: draft.port,
                onChange: (event) => setDraft((prev) => ({ ...prev, port: event.target.value })),
                onBlur: () => saveConfig({ port: Number(draft.port) }),
              }),
              h('span', { style: S.gwKvHint }, t('gateway.concurrency')),
              h('input', {
                type: 'number', min: 1, max: 64, style: S.gwKvInput, value: draft.concurrency,
                onChange: (event) => setDraft((prev) => ({ ...prev, concurrency: event.target.value })),
                onBlur: () => saveConfig({ concurrency: Number(draft.concurrency) }),
              }),
              h('span', { style: S.gwKvHint }, t('gateway.perMinute')),
              h('input', {
                type: 'number', min: 1, style: S.gwKvInput, value: draft.perMinute,
                onChange: (event) => setDraft((prev) => ({ ...prev, perMinute: event.target.value })),
                onBlur: () => saveConfig({ perMinute: Number(draft.perMinute) }),
              }),
            ),
            h('div', { style: S.gwKv },
              h('span', { style: S.gwKvLabel }, t('gateway.tls')),
              h('button', { type: 'button', role: 'switch', 'aria-checked': false, disabled: true,
                'aria-label': t('gateway.tls'), title: t('gateway.tlsHint'),
                style: { ...S.rowSwitch, ...S.smallBtnOff } }, h('span', { style: S.rowSwitchKnob })),
              h('span', { style: S.gwKvHint }, t('gateway.tlsHint')),
            ),
            h('div', { style: { ...S.gwKv, ...S.gwKvLast } },
              h('span', { style: S.gwKvLabel }, t('gateway.audit')),
              h('button', {
                type: 'button', role: 'switch', 'aria-checked': cfg.audit !== false,
                'aria-label': t('gateway.audit'),
                style: { ...S.rowSwitch, ...(cfg.audit !== false ? S.rowSwitchOn : S.rowSwitchOff) },
                onClick: () => saveConfig({ audit: cfg.audit === false }),
              }, h('span', { style: S.rowSwitchKnob })),
              h('span', { style: S.gwKvHint }, t('gateway.auditHint')),
            ),
          ),
          h('div', { style: S.warnbar }, t('gateway.warning')),
        ),

        // 访问 Key：只有 启用/禁用 + 删除，绝不放「复制」旧 Key
        h('div', { style: S.sec },
          h('div', { style: S.secTitle }, t('gateway.accessKeys'),
            h('span', { style: S.panelTagOff }, `${keys.length} ${t('gateway.keys')}`)),
          h('div', { style: S.secSub }, t('gateway.accessKeysHint')),
          h('div', { style: S.secCard },
            h('div', { style: S.tableWrap },
              h('table', { style: S.gwTable },
                h('thead', null,
                  h('tr', null,
                    h('th', { style: S.gwTh }, t('gateway.keyName')),
                    h('th', { style: S.gwTh }, t('gateway.keyValue')),
                    h('th', { style: S.gwTh }, t('gateway.status')),
                    h('th', { style: S.gwThRight }, t('gateway.action')),
                  )),
                h('tbody', null,
                  keys.length === 0
                    ? h('tr', null, h('td', { style: S.gwTd, colSpan: 4 }, '—'))
                    : keys.map((key) => h('tr', { key: key.id },
                        h('td', { style: { ...S.gwTd, maxWidth: 120 } }, key.name || '—'),
                        h('td', { style: S.gwTd }, h('span', { style: S.mono },
                          `${key.prefix}…${key.suffix}`)),
                        h('td', { style: S.gwTd }, h('span', {
                          style: key.enabled ? S.tagOn : S.tagOff,
                        }, key.enabled ? t('gateway.enable') : t('gateway.disable'))),
                        h('td', { style: S.gwTdRight },
                          h('div', { style: S.rowAct },
                            h('button', {
                              style: S.smallBtn, disabled: busy !== '',
                              onClick: () => onAction({ path: '/gateway/key/toggle', body: { id: key.id, enabled: !key.enabled } }),
                            }, key.enabled ? t('gateway.disable') : t('gateway.enable')),
                            h('button', {
                              style: { ...S.smallBtn, ...S.smallBtnDanger }, disabled: busy !== '',
                              onClick: () => onAction({ path: '/gateway/key/remove', body: { id: key.id } }),
                            }, t('gateway.delete')),
                          )),
                      )),
                ),
              ),
            ),
            h('div', { style: S.footBar },
              h(AddKeyModal, {
                t,
                onCreated: async (name) => onAction({ path: '/gateway/key/create', body: { name } }),
              }),
              h('span', { style: S.footBarHint }, t('gateway.hashOnly')),
            ),
          ),
        ),

        // 模型别名
        h('div', { style: S.sec },
          h('div', { style: S.secTitle }, t('gateway.aliases')),
          h('div', { style: S.secSub }, t('gateway.aliasesHint')),
          h('div', { style: S.secCard },
            h('div', { style: S.tableWrap },
              h('table', { style: S.gwTable },
                h('thead', null,
                  h('tr', null,
                    h('th', { style: S.gwTh }, t('gateway.alias')),
                    h('th', { style: S.gwTh }, t('gateway.target')),
                    h('th', { style: S.gwThRight }, t('gateway.action')),
                  )),
                h('tbody', null,
                  Object.keys(aliases).length === 0
                    ? h('tr', null, h('td', { style: S.gwTd, colSpan: 3 }, '—'))
                    : Object.entries(aliases).map(([alias, target]) => h('tr', { key: alias },
                        h('td', { style: S.gwTd }, h('span', { style: S.mono }, alias)),
                        h('td', { style: S.gwTd }, h('span', { style: S.mono }, String(target))),
                        h('td', { style: S.gwTdRight },
                          h('button', {
                            style: { ...S.smallBtn, ...S.smallBtnDanger },
                            onClick: () => onAction({ path: '/gateway/alias/remove', body: { name: alias } }),
                          }, t('gateway.delete')),
                        ),
                      )),
                ),
              ),
            ),
            h('div', { style: S.footBar },
              h(AddAliasModal, {
                t,
                onCreated: (name, target) => onAction({ path: '/gateway/alias/set', body: { name, target } }),
              }),
            ),
          ),
        ),
      )
    }

    function Overview({ platforms, auto, gateway, t, onManage, onManageAuto, onManageGateway, onToggleGateway, busy, onReload, error }) {
      const prefs = usePrefs()
      const layout = prefs.overviewLayout === 'card' ? 'card' : 'list'
      const setLayout = (next) => writePrefs({ overviewLayout: next })
      const layoutBtn = (kind, label, glyph) => h('button', {
        type: 'button',
        'aria-label': label, title: label,
        style: { ...S.layoutBtn, ...(layout === kind ? S.layoutBtnOn : {}) },
        onClick: () => setLayout(kind),
      }, glyph)
      return h('div', null,
        h('div', { style: S.hero },
          h('div', { style: S.heroHead },
            h('div', { style: S.heroGrow },
              h('h1', { style: S.heroTitle }, T.heroTitle),
              h('p', { style: S.heroDesc }, T.heroDesc),
            ),
            h('div', {
              style: S.layoutToggle, role: 'group', 'aria-label': t('gateway.switchLayout'),
            },
              layoutBtn('list', t('gateway.layoutList'), '☰'),
              layoutBtn('card', t('gateway.layoutCard'), '▦'),
            ),
          ),
          h('div', { style: S.prefBox }, h(PickerPreferenceRow, null)),
        ),
        error ? h('div', { style: S.err }, error) : null,
        layout === 'card'
          ? h(React.Fragment, null,
              h(GatewayCard, {
                gw: gateway, t, onManage: onManageGateway,
                onToggle: onToggleGateway, busy: busy === 'gateway',
              }),
              h(AutoCard, { auto, onManage: onManageAuto }),
              h('div', { style: S.cardGrid },
                platforms.map((platform) => h(PlatformCard, {
                  key: platform.provider,
                  platform,
                  onManage,
                  onReload,
                })),
              ),
            )
          : h('div', { style: S.list },
              h(GatewayRow, {
                gw: gateway, t, onManage: onManageGateway,
                onToggle: onToggleGateway, busy: busy === 'gateway',
              }),
              h(AutoRow, { auto, t, onManage: onManageAuto }),
              platforms.map((platform) => h(PlatformRow, {
                key: platform.provider, platform, onManage, onReload,
              })),
            ),
        h('div', { style: S.footNote }, T.heroTip),
      )
    }

    function PoolPage({ t }) {
      const [data, setData] = useState({ platforms: [] })
      /** 网关设置页的完整视图（Key / 别名 / 候选地址），单独拉。 */
      const [gatewayFull, setGatewayFull] = useState(null)
      /** 首屏是否已经拿到过一次 /status：false 时显示「加载中」，别误报「还没有平台」。 */
      const [ready, setReady] = useState(false)
      const [active, setActive] = useState('')
      // view: null = 概览；AUTO_KEY = Auto 管理；其余是平台键
      const [managing, setManaging] = useState(null)
      /** Auto 的完整视图（候选全量 + 目录 + 日志），只在打开管理页时拉。 */
      const [autoFull, setAutoFull] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [gwBusy, setGwBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const next = await api('/status')
          setData(next)
          setReady(true)
          setError('')
          // 正在管理的平台被删掉了就退回概览，别停在空面板上。
          // AUTO_KEY 不是平台，不受这条守卫管辖 —— 漏掉它会让 20 秒一次的轮询
          // 把 Auto 管理页踢回概览。
          setManaging((current) => {
            // AUTO_KEY / GATEWAY_KEY 不是平台，不受「平台被删了就退回概览」守卫管辖
            if (current === null || current === AUTO_KEY || current === GATEWAY_KEY) return current
            return next.platforms.some((p) => p.provider === current) ? current : null
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      const loadGateway = useCallback(async () => {
        try {
          const next = await api('/gateway')
          setGatewayFull(next)
          return next
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return null
        }
      }, [])

      useEffect(() => {
        void load()
        void loadGateway()
        const timer = setInterval(() => {
          void load()
          void loadGateway()
        }, 20_000)
        return () => clearInterval(timer)
      }, [load, loadGateway])

      const onAction = useCallback(async ({ path, body }) => {
        setBusy(path.includes('import') ? 'import' : path.includes('checkin') ? 'checkin' : path.includes('refresh') ? 'refresh' : '')
        try {
          const next = await api(path, body ?? {})
          if (next.platforms) setData({ platforms: next.platforms })
          else await load()
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy('')
        }
      }, [load])

      /** 网关动作：动作成功后立刻重拉一次 /gateway，不等 20 秒轮询。 */
      const onGatewayAction = useCallback(async ({ path, body }) => {
        setGwBusy(true)
        try {
          const next = await api(path, body ?? {})
          setGatewayFull(next)
          setError('')
          return next
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return null
        } finally {
          setGwBusy(false)
        }
      }, [])

      const onToggleGateway = useCallback(async (enabled) => {
        const next = await onGatewayAction({ path: '/gateway/toggle', body: { enabled } })
        if (next !== null) await load()
        return next
      }, [onGatewayAction, load])

      const loadAuto = useCallback(async () => {
        try {
          const next = await api('/auto')
          setAutoFull(next.auto ?? null)
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      const onAutoAction = useCallback(async (path, body) => {
        setBusy('auto')
        try {
          const next = await api(path, body ?? {})
          if (next.auto) setAutoFull(next.auto)
          if (Array.isArray(next.platforms)) setData((prev) => ({ ...prev, platforms: next.platforms }))
          setError('')
          return next
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return undefined
        } finally {
          setBusy('')
        }
      }, [])

      const platforms = Array.isArray(data.platforms) ? data.platforms : []
      const managed = managing === null
        ? undefined
        : platforms.find((platform) => platform.provider === managing)
      const reload = (nextPlatforms) => setData({ platforms: nextPlatforms })

      if (platforms.length === 0) {
        // 首屏还没拿到 /status：居中转圈，别在左上角闪一句「还没有平台」。
        if (!ready) {
          return h('div', { style: S.loadingBox },
            h('span', { style: S.spinner, 'aria-hidden': true }),
            h('span', null, error || '加载中…'),
          )
        }
        return h('div', { style: S.wrap },
          h('p', { style: S.heroDesc }, error || '还没有平台接入。'),
        )
      }

      // 概览：插件说明 + 列表/卡片
      if (managed === undefined && managing !== AUTO_KEY && managing !== GATEWAY_KEY) {
        return h('div', { style: S.wrap },
          h(Overview, {
            platforms,
            auto: data.auto,
            gateway: gatewayFull,
            t,
            busy,
            error,
            onManage: (provider) => { setManaging(provider); setError('') },
            onManageAuto: () => {
              setManaging(AUTO_KEY)
              setError('')
              void loadAuto()
            },
            onManageGateway: () => {
              setManaging(GATEWAY_KEY)
              setError('')
              void loadGateway()
            },
            onToggleGateway,
            onReload: reload,
          }),
        )
      }

      // 网关管理面板
      if (managing === GATEWAY_KEY) {
        return h('div', { style: S.wrap },
          error ? h('div', { style: S.err }, error) : null,
          gatewayFull === null
            ? h('div', { style: S.gwKv }, '加载中…')
            : h(GatewayPanel, {
                gw: gatewayFull,
                t,
                busy: gwBusy ? 'gateway' : '',
                onAction: onGatewayAction,
                onBack: () => { setManaging(null); setError(''); void loadGateway() },
              }),
        )
      }

      // Auto 管理：数据来自 /auto（含目录与日志），与平台面板互不影响
      if (managing === AUTO_KEY) {
        return h('div', { style: S.wrap },
          h('button', { style: S.backBtn, onClick: () => { setManaging(null); setError('') } }, T.backToOverview),
          error ? h('div', { style: S.err }, error) : null,
          autoFull === null
            ? h('div', { style: S.gwKv }, '加载中…')
            : h(AutoPanel, { auto: autoFull, onAction: onAutoAction, busy }),
        )
      }

      // 管理：返回按钮 + 该平台的四块面板
      return h('div', { style: S.wrap },
        h('button', { style: S.backBtn, onClick: () => { setManaging(null); setError('') } }, T.backToOverview),
        error ? h('div', { style: S.err }, error) : null,
        h(PlatformPanel, {
          platform: managed,
          onAction,
          busy,
          onReload: reload,
        }),
      )
    }


    // ------------------------------------------------------------------
    // 模型选择器替换 —— 只接管 composer 的 conversation.input.model 弹窗。
    // 唯一变化：魔桥各平台的模型收进一个可折叠的「魔桥」组，Auto 排最前；
    // 其余 provider 保持原样。团队模式开关从 options 子插槽一起搬进来
    // （子插槽声明权归宿主，替换父 entry 后无法再转发它）。
    // ------------------------------------------------------------------
    const MG_PICKER_KEYS = new Set(['auto', 'workbuddy', 'codearts', 'meoo', 'scnet', 'lingxi', 'raccoon'])
    const MG_ROOT_KEY = '__mgroot__'
    const mgReactDom = (() => { try { return require('react-dom') } catch { return null } })()
    const mgPrim = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return {} } })()
    const mgCls = (...xs) => xs.filter(Boolean).join(' ')
    let mgTeamApi = null
    const MG_PICKER_CSS = `.mgp_root{min-width:0;position:relative}.mgp_trigger{anchor-name:var(--dsh-model-anchor);border-radius:var(--dsw-radius-sm);min-width:0;max-width:360px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:400;line-height:20px;display:flex}@media (hover:hover){.mgp_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}.mgp_trigger:focus-visible:not([data-selection-focus]){box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}.mgp_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.mgp_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.mgp_triggerEffort{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-caption);flex-shrink:1000;overflow:hidden}.mgp_triggerIcon{display:var(--dsh-composer-model-icon-display,none);flex:none}.mgp_triggerLabel,.mgp_triggerEffort{display:var(--dsh-composer-model-text-display,block)}.mgp_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}.mgp_chevronOpen{transform:rotate(180deg)}.mgp_menu{box-sizing:border-box;position-anchor:var(--dsh-model-anchor);top:max(12px, var(--dsh-frame-overlay-top,12px));left:12px;right:anchor(right);bottom:calc(anchor(top) + 8px);z-index:1100;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:fit-content;min-width:min(240px,100vw - 24px);max-width:min(420px,100vw - 24px);height:fit-content;max-height:min(360px,100dvh - 96px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:0;flex-direction:column;place-self:safe end;margin:0;padding:4px;display:flex;position:fixed;overflow:hidden}.mgp_status,.mgp_empty{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}.mgp_error,.mgp_warning{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:3px;padding:6px 7px;font-size:11px;line-height:16px;display:flex}.mgp_warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}.mgp_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}.mgp_searchRow{flex-shrink:0;margin:2px 0 3px;position:relative}.mgp_searchRow .mgp_search{border-radius:var(--dsw-radius-md);background:0 0;border:0 solid #0000;height:auto;padding:5px 7px;display:flex}.mgp_searchRow .mgp_searchWithQuery{padding-right:34px}.mgp_searchClear{corner-shape:round;width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex;position:absolute;top:50%;right:4px;transform:translateY(-50%)}.mgp_searchClear:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}@media (hover:hover){.mgp_searchClear:hover{background:var(--dsw-alias-interactive-bg-hover);outline:none}}.mgp_searchRow .mgp_search:focus-within{border-color:#0000}.mgp_searchRow .mgp_search input{padding:0;font-size:12px;line-height:normal}@media (pointer:coarse){.mgp_searchRow .mgp_search input{font-size:16px}}.mgp_searchRow .mgp_search input::placeholder{color:var(--dsw-alias-label-caption)}.mgp_groups:not([hidden]){min-height:0;overflow:hidden auto}.mgp_option{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:5px 7px;display:flex}.mgp_option:focus-visible,.mgp_optionActive:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.mgp_modelOption{max-width:100%}@media (hover:hover){.mgp_option:not(.mgp_modelOption):hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}.mgp_selected{background:0 0}.mgp_option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.mgp_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}.mgp_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:400;line-height:17px;overflow:hidden}.mgp_badgedName{vertical-align:baseline;white-space:nowrap;align-items:center;gap:4px;max-width:100%;display:inline-flex}.mgp_badgedNameText{text-overflow:ellipsis;min-width:0;overflow:hidden}.mgp_badge{flex:none}.mgp_check{color:var(--dsw-alias-label-primary);flex:0 0 14px;place-items:center;display:grid}.mgp_check svg{width:14px;height:14px}.mgp_cell{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:auto;min-width:100%;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:0 8px;font-size:13px;line-height:20px;display:flex}.mgp_cell:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}@media (hover:hover){.mgp_cell:hover{background:var(--dsw-alias-interactive-bg-hover)}}.mgp_cellLabel{white-space:nowrap;flex:none}.mgp_cellValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}.mgp_cellChevron{width:12px;height:12px;color:var(--dsw-alias-menu-icon);flex:none}.mgp_section,.mgp_sub{min-width:0}.mgp_sectionHead,.mgp_subHead{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-height:28px;padding:4px 7px;cursor:pointer;background:0 0;border:0;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;text-align:left;border-radius:var(--dsw-radius-md)}.mgp_sectionHead:hover,.mgp_subHead:hover{background:var(--dsw-alias-interactive-bg-hover)}.mgp_sectionLabel,.mgp_subLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mgp_sub{padding-left:6px}.mgp_subHead{color:var(--dsw-alias-label-secondary)}.mgp_teamRow{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-primary)}.mgp_toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:1200;background:var(--dsw-alias-state-error-primary,#c0392b);color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;display:flex;gap:8px;align-items:center}.mgp_toast button{background:0 0;border:0;color:inherit;cursor:pointer;font-size:14px}.mgp_confirm{position:fixed;inset:0;z-index:1201;background:rgba(0,0,0,.35);display:grid;place-items:center}.mgp_confirmCard{background:var(--dsw-alias-bg-body,#fff);color:var(--dsw-alias-label-primary);padding:16px;border-radius:8px;min-width:260px;font-size:13px}.mgp_confirmActions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.mgp_confirmActions button{cursor:pointer;padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:inherit;font-size:12px}.mgp_searchInput{box-sizing:border-box;width:100%;padding:5px 7px;font-size:12px;background:transparent;border:0;outline:none;color:inherit}.mgp_searchInput::placeholder{color:var(--dsw-alias-label-caption)}
/* ---- 分组层级：一级段（魔桥 / 其他 provider）→ 二级组（平台）→ 模型行 ---- */
.mgp_section{margin-top:2px}
.mgp_section+.mgp_section{border-top:1px solid var(--dsw-alias-line-soft,var(--dsw-alias-border-l1));margin-top:4px;padding-top:4px}
.mgp_sectionHead,.mgp_subHead{background:0 0;border:0;cursor:pointer;width:100%;display:flex;align-items:center;text-align:left;border-radius:var(--dsw-radius-md);outline:none}
.mgp_sectionHead{min-height:26px;gap:7px;padding:4px 8px 4px 6px;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;letter-spacing:0}
.mgp_sectionHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mgp_sectionHead:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.mgp_sectionBar{flex:0 0 3px;width:3px;height:12px;border-radius:2px;background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.mgp_sectionBarPlain{background:var(--dsw-alias-border-l1,#c9cdd4)}
.mgp_sectionLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mgp_sectionCount{flex:none;font-size:10.5px;font-weight:500;color:var(--dsw-alias-label-caption);background:var(--dsw-alias-interactive-bg-hover);border-radius:5px;padding:0 5px;line-height:15px}
.mgp_twist{flex:none;width:9px;text-align:center;color:var(--dsw-alias-label-caption);font-size:9px;transition:transform .12s}
.mgp_twistOpen{transform:rotate(90deg)}
.mgp_subHead{min-height:24px;gap:6px;padding:3px 8px 3px 18px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.mgp_subHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mgp_subHead:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.mgp_subLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mgp_subCount{flex:none;font-size:10px;color:var(--dsw-alias-label-caption)}
.mgp_sub{margin-top:1px}
.mgp_sub .mgp_option{padding-left:30px}
/* ---- Auto：单独一行，不再套一层组 ---- */
.mgp_auto{box-sizing:border-box;width:auto;min-width:100%;display:flex;align-items:center;gap:8px;text-align:left;border:0;outline:none;cursor:pointer;margin:1px 2px 3px;padding:6px 8px 6px 10px;border-radius:var(--dsw-radius-md);background:linear-gradient(90deg,rgba(77,107,254,.07),rgba(77,107,254,0) 78%)}
.mgp_auto:hover,.mgp_auto:focus-visible{background:linear-gradient(90deg,rgba(77,107,254,.13),rgba(77,107,254,.02) 78%)}
.mgp_autoDot{flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe);box-shadow:0 0 0 3px rgba(77,107,254,.14)}
.mgp_autoCopy{flex:1;min-width:0;display:flex;flex-direction:column}
.mgp_autoName{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary)}
.mgp_autoBadge{flex:none;font-size:9.5px;font-weight:600;line-height:14px;padding:0 4px;border-radius:5px;color:var(--dsw-alias-state-business-primary,#4d6bfe);background:rgba(77,107,254,.1)}
.mgp_autoSub{font-size:11px;line-height:15px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption)}

.mgp_teamRow{height:34px;padding:0 8px;font-size:13px}
.mgp_teamLabel{display:flex;align-items:center;gap:6px;min-width:0}
.mgp_teamInfo{flex:none;width:14px;height:14px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);font-size:9px;line-height:12px;text-align:center;cursor:help}
.mgp_switch{width:32px;height:18px;border-radius:9px;border:0;padding:2px;cursor:pointer;flex:0 0 32px;display:flex;align-items:center;background:var(--dsw-alias-border-l1,#d9dce1)}
.mgp_switchOn{justify-content:flex-end;background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.mgp_switchOff{justify-content:flex-start}
.mgp_switchKnob{width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);display:block}
.mgp_switch:disabled{opacity:.5;cursor:default}
@keyframes mgspin{to{transform:rotate(360deg)}}
`
    function mgInjectCss() {
      if (typeof document === 'undefined' || document.querySelector('style[data-mg-picker="1"]')) return
      const el = document.createElement('style')
      el.dataset.mgPicker = '1'
      el.textContent = MG_PICKER_CSS
      document.head.appendChild(el)
    }
    function mgRank(models, query) {
      const q = String(query || '').trim().toLowerCase()
      if (q === '') return models
      return [
        ...models.filter(m => String(m.name || '').toLowerCase().includes(q)),
        ...models.filter(m => !String(m.name || '').toLowerCase().includes(q)),
      ]
    }

    function GatewayModelSelect(props) {
      const { locked, available, directory, load, select, resolveText, t, sessionId,
        useSession, useSessions, useProjection } = props
      const state = React.useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
      const [open, setOpen] = React.useState(false)
      const [pane, setPane] = React.useState('root')
      const [query, setQuery] = React.useState('')
      const [highlightedIndex, setHighlightedIndex] = React.useState(null)
      const [selectionFocus, setSelectionFocus] = React.useState(false)
      const [collapsed, setCollapsed] = React.useState(() => new Set())
      const [toast, setToast] = React.useState(null)
      const toastSeq = React.useRef(0)
      const lastActionRef = React.useRef('load')
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const searchRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const groupsRef = React.useRef(null)
      const itemRefs = React.useRef([])
      const id = React.useId()
      const anchorStyle = { '--dsh-model-anchor': `--dsh-model-${id.replaceAll(':', '')}` }
      const reportFailure = (message) => setToast({ seq: ++toastSeq.current, text: String(message) })
      const tr = (key, fallback) => {
        try { const v = t ? t(key) : undefined; return v === undefined || v === key ? fallback : v } catch { return fallback }
      }
      const resolve = (text) => { try { return resolveText ? resolveText(text) : (text && text.text) || '' } catch { return (text && text.text) || '' } }

      // 团队开关：只在非子会话显示；未装 agent-team 插件时投影为 undefined。
      const mode = useProjection ? useProjection('agentTeam') : undefined
      const modelSel = useProjection ? useProjection('modelSelection') : undefined
      const addressedChild = useSession ? useSession(s => s != null && s.subagent != null) : false
      const listedChild = useSessions ? useSessions(s => s != null && s.byId && s.byId[sessionId] && s.byId[sessionId].origin === 'subagent') : false
      const [teamPending, setTeamPending] = React.useState(false)
      const [confirmOpen, setConfirmOpen] = React.useState(false)

      const groups = React.useMemo(() => {
        const raw = state.groups || []
        const rank = id => id === 'auto' ? 0 : id === 'deepseek-account' ? 1 : id === 'deepseek-official' ? 2 : 3
        const ordered = [...raw].sort((a, b) => rank(a.id) - rank(b.id))
        return ordered.map(g => ({
        ...g,
        provider: { id: g.id, name: g.id === 'deepseek-account' ? tr('provider.account', 'DeepSeek 账号') : g.name },
        }))
      }, [state.groups, t])
      const choices = React.useMemo(() => groups.flatMap(g => g.models.map(m => ({
        group: g, model: m,
        selection: {
          provider: g.id, model: m.id,
          ...(m.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: m.reasoning.defaultEffort }),
        },
      }))), [groups])
      const showSearch = choices.length > 4
      const filteredGroups = React.useMemo(() => groups.map(g => ({
        ...g, models: mgRank(g.models, showSearch ? query : ''),
      })).filter(g => g.models.length > 0), [groups, query, showSearch])
      const mgGroups = filteredGroups.filter(g => MG_PICKER_KEYS.has(g.id))
      const otherGroups = filteredGroups.filter(g => !MG_PICKER_KEYS.has(g.id))
      const autoGroup = mgGroups.find(g => g.id === 'auto') || null
      const platformGroups = mgGroups.filter(g => g.id !== 'auto')
      const searching = query.trim() !== ''
      const groupOpen = key => searching || !collapsed.has(key)
      const toggleGroup = key => setCollapsed(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key); else next.add(key)
        return next
      })
      const visibleModels = React.useMemo(() => {
        const out = []
        if (groupOpen(MG_ROOT_KEY)) {
          for (const g of [autoGroup, ...platformGroups].filter(Boolean)) {
            if (groupOpen(g.id)) for (const m of g.models) out.push({ provider: g.id, model: m.id })
          }
        }
        for (const g of otherGroups) for (const m of g.models) out.push({ provider: g.id, model: m.id })
        return out
      }, [autoGroup, platformGroups, otherGroups, collapsed, searching])

      const currentVisibleIndex = visibleModels.findIndex(m => m.provider === state.current?.provider && m.model === state.current?.model)
      const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
      const selectedIndex = state.current === null || state.current === undefined ? -1
        : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
      const currentChoice = choices[selectedIndex]
      const reasoning = currentChoice?.model.reasoning
      const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel = currentChoice === undefined ? undefined
        : reasoning === undefined ? state.retainedEffort
          : effectiveEffort === undefined ? tr('effort.providerDefault', '跟随模型')
            : reasoning.efforts.find(e => e.id === effectiveEffort)?.name ?? effectiveEffort
      const effortChoices = React.useMemo(() => reasoning === undefined ? [] : [
        ...(reasoning.defaultEffort === undefined ? [{ key: 'provider-default', effort: undefined, label: tr('effort.providerDefault', '跟随模型') }] : []),
        ...reasoning.efforts.map(e => ({ key: `effort:${e.id}`, effort: e.id, label: e.name })),
      ], [reasoning, t])
      const { pending } = state
      const busy = pending !== null && pending !== undefined

      React.useEffect(() => {
        if (!open) return
        const closeOutside = e => {
          if (rootRef.current?.contains(e.target) === true) return
          if (menuRef.current?.contains(e.target) === true) return
          setOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [open])
      React.useEffect(() => { if (!showSearch) { setQuery(''); setHighlightedIndex(null) } }, [showSearch])
      // 当前选中的平台组自动展开，否则用户看不到自己正在用的模型。
      React.useEffect(() => {
        const cur = state.current?.provider
        if (!cur || !MG_PICKER_KEYS.has(cur) || cur === 'auto') return
        setCollapsed(prev => { if (!prev.has(cur)) return prev; const next = new Set(prev); next.delete(cur); return next })
      }, [state.current?.provider])
      React.useEffect(() => {
        if (!open) return
        if (pane === 'model' && showSearch) { searchRef.current?.focus(); return }
        const checked = menuRef.current?.querySelector('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
        const target = checked || itemRefs.current.find(n => n && !n.disabled)
        ;(target || triggerRef.current)?.focus()
      }, [open, pane])
      React.useLayoutEffect(() => {
        if (open && pane === 'model' && activeModelIndex >= 0) itemRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
      }, [open, pane, activeModelIndex, visibleModels])

      if (!available) return null

      const reload = () => { lastActionRef.current = 'load'; load() }
      const show = () => {
        setSelectionFocus(false)
        triggerRef.current?.focus()
        setQuery('')
        setHighlightedIndex(null)
        const cur = state.current?.provider
        // 只展开当前选中的那一组；其余（含非魔桥 provider）全部折叠。
        const mobaiActive = cur === 'auto' || (cur !== undefined && MG_PICKER_KEYS.has(cur))
        const allGroupIds = [...platformGroups, ...otherGroups].map(g => g.id)
        setCollapsed(() => new Set([
          ...allGroupIds.filter(gid => gid !== cur),
          ...(mobaiActive ? [] : [MG_ROOT_KEY]),
        ]))
        setPane(currentChoice === undefined ? 'model' : 'root')
        setOpen(true)
        reload()
      }
      const close = (restoreFocus = false) => {
        setOpen(false); setPane('root')
        if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus())
      }
      const closeAfterSelection = () => { setSelectionFocus(true); close(true) }
      const backToRoot = () => { setQuery(''); setHighlightedIndex(null); setPane('root') }
      const submit = selection => {
        lastActionRef.current = 'select'
        setSelectionFocus(true)
        triggerRef.current?.focus()
        void select(selection).then(result => {
          if (result === undefined) return
          if (result.ok) { closeAfterSelection(); return }
          const err = result.error || {}
          setToast({ seq: ++toastSeq.current, text: err.code === 'session/writer-held' ? tr('error.sessionInUse', '会话正忙') : `${err.code || '错误'}: ${err.message || ''}` })
        })
      }
      const choose = m => {
        if (state.current?.provider === m.provider && state.current.model === m.model) { closeAfterSelection(); return }
        submit(m)
      }
      const chooseEffort = effort => {
        if (state.current === null || state.current === undefined) return
        if (effectiveEffort === effort) { closeAfterSelection(); return }
        submit({ provider: state.current.provider, model: state.current.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
      }
      const moveFocus = offset => {
        const items = Array.from(menuRef.current?.querySelectorAll(
          'button[role="menuitem"]:not([disabled]), button[role="menuitemradio"]:not([disabled]), input[type="checkbox"]:not([disabled])') || [])
        if (items.length === 0) return
        const active = items.indexOf(document.activeElement)
        const next = active === -1 ? (offset > 0 ? 0 : items.length - 1) : (active + offset + items.length) % items.length
        items[next]?.focus()
      }
      const rowsInMenu = () => Array.from(menuRef.current?.querySelectorAll(
        'button[role="menuitem"]:not([disabled]), button[role="menuitemradio"]:not([disabled]), input[type="checkbox"]:not([disabled])') || [])
      const onRootKeyDown = e => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          if (pane !== 'root') backToRoot(); else close(true)
          return
        }
        if (!open) return
        if (pane === 'model' && showSearch && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault()
          if (!busy && visibleModels.length > 0) {
            const d = e.key === 'ArrowDown' ? 1 : -1
            setHighlightedIndex((activeModelIndex + d + visibleModels.length) % visibleModels.length)
            searchRef.current?.focus()
          }
          return
        }
        if (pane === 'model' && showSearch && e.target instanceof HTMLInputElement
          && (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey))) {
          if (e.key === 'Tab' && visibleModels.length === 0) return
          e.preventDefault()
          const m = visibleModels[activeModelIndex]
          if (!busy && m) choose(m)
          return
        }
        if (e.key === 'Tab') {
          if (e.shiftKey) { e.preventDefault(); if (pane !== 'root') backToRoot(); else close(true); return }
          const focused = document.activeElement
          const rows = rowsInMenu()
          if (focused instanceof HTMLButtonElement && rows.includes(focused)) { e.preventDefault(); focused.click(); return }
          if (focused !== triggerRef.current) return
          e.preventDefault()
          if (pane === 'model' && showSearch) { setHighlightedIndex(null); searchRef.current?.focus(); return }
          const checked = menuRef.current?.querySelector('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
          ;(checked || rows.find(n => !n.disabled))?.focus()
          return
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveFocus(e.key === 'ArrowDown' ? 1 : -1) }
      }
      const onBlur = e => {
        if (e.relatedTarget instanceof Node && (
          rootRef.current?.contains(e.relatedTarget) === true || menuRef.current?.contains(e.relatedTarget) === true)) return
        close()
      }
      const doSetTeam = async enabled => {
        const api = mgTeamApi
        if (!api) return
        setTeamPending(true)
        try {
          const res = await api.setEnabled(sessionId, enabled)
          if (!res || !res.ok) reportFailure((res && res.error && res.error.message) || '设置失败')
        } catch (err) { reportFailure(err instanceof Error ? err.message : String(err)) }
        finally { setTeamPending(false) }
      }
      const setTeam = enabled => {
        if (!enabled && modelSel !== undefined && modelSel !== null && modelSel.lastUsed != null) { setConfirmOpen(true); return }
        doSetTeam(enabled)
      }

      const waiting = currentChoice === undefined && state.status === 'loading'
      const modelLabel = waiting ? tr('trigger.loading', '加载中…') : (currentChoice?.model.name ?? tr('trigger.fallback', '选择模型'))
      const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
      const renderModelLabel = m => m.badge === undefined ? m.name :
        `${m.name} · ${resolve(m.badge.text)}`
      let itemIndex = 0
      let modelIndex = 0
      const itemRef = () => { const at = itemIndex++; return node => { itemRefs.current[at] = node } }

      const modelRow = (g, m) => {
        const index = modelIndex++
        const selected = state.current?.provider === g.id && state.current.model === m.id
        return h('button', {
          ref: itemRef(), type: 'button', role: 'menuitemradio', 'aria-checked': selected,
          id: `${id}-model-${index}`, tabIndex: showSearch ? -1 : 0,
          onFocus: () => setHighlightedIndex(index),
          'data-highlighted': index === activeModelIndex ? '' : undefined,
          className: mgCls('mgp_option', 'mgp_modelOption', selected && 'mgp_selected', index === activeModelIndex && 'mgp_optionActive'),
          onMouseMove: busy || index === activeModelIndex ? undefined : () => {
            if (showSearch) setHighlightedIndex(index); else itemRefs.current[index]?.focus()
          },
          key: m.id, title: m.name, disabled: busy,
          onClick: () => choose({ provider: g.id, model: m.id }),
        },
          h('span', { className: 'mgp_optionCopy' }, h('span', { className: 'mgp_modelName' }, renderModelLabel(m))),
          h('span', { className: 'mgp_check' },
            pending?.provider === g.id && pending.model === m.id ? '◌' : (selected ? '✓' : null)),
        )
      }
      const groupBlock = (g, headLabel, collapsible) => {
        const isOpen = groupOpen(g.id)
        return h('div', { key: g.id, className: 'mgp_sub', role: 'group' },
          collapsible ? h('button', {
            type: 'button', className: 'mgp_subHead', 'aria-expanded': isOpen,
            onClick: () => toggleGroup(g.id),
          },
            h('span', { className: mgCls('mgp_twist', isOpen && 'mgp_twistOpen') }, '▶'),
            h('span', { className: 'mgp_subLabel' }, headLabel || g.name),
            h('span', { className: 'mgp_subCount' }, String(g.models.length)),
          ) : null,
          isOpen ? g.models.map(m => modelRow(g, m)) : null,
        )
      }
      const autoRow = autoGroup && autoGroup.models.length > 0 ? (() => {
        const m = autoGroup.models[0]
        const selected = state.current?.provider === 'auto' && state.current.model === m.id
        return h('button', {
          key: 'mgp-auto-row', type: 'button', role: 'menuitemradio', 'aria-checked': selected,
          className: mgCls('mgp_auto', selected && 'mgp_autoSelected'),
          title: m.name, disabled: busy,
          onClick: () => choose({ provider: 'auto', model: m.id }),
        },
          h('span', { className: 'mgp_autoDot' }),
          h('span', { className: 'mgp_autoCopy' },
            h('span', { className: 'mgp_autoName' }, 'Auto', h('span', { className: 'mgp_autoBadge' }, '自动')),
            h('span', { className: 'mgp_autoSub' }, resolve(m.description) || m.name),
          ),
          h('span', { className: 'mgp_check' }, selected ? '✓' : null),
        )
      })() : null
      const mobaiSection = mgGroups.length > 0 ? h('div', { key: 'mgp-mobai', className: 'mgp_section', role: 'group' },
        h('button', { type: 'button', className: 'mgp_sectionHead', 'aria-expanded': groupOpen(MG_ROOT_KEY),
          onClick: () => toggleGroup(MG_ROOT_KEY) },
          h('span', { className: 'mgp_sectionBar' }),
          h('span', { className: 'mgp_sectionLabel' }, '魔桥'),
          h('span', { className: 'mgp_sectionCount' }, `${mgGroups.length} 家`),
          h('span', { className: mgCls('mgp_twist', groupOpen(MG_ROOT_KEY) && 'mgp_twistOpen') }, '▶'),
        ),
        groupOpen(MG_ROOT_KEY) ? [
          autoRow,
          ...platformGroups.map(g => groupBlock(g, g.name, true)),
        ] : null,
      ) : null
      const plainSections = otherGroups.map(g => h('div', { key: g.id, className: 'mgp_section', role: 'group' },
        h('button', { type: 'button', className: 'mgp_sectionHead', 'aria-expanded': true,
          onClick: () => toggleGroup(g.id) },
          h('span', { className: 'mgp_sectionBar mgp_sectionBarPlain' }),
          h('span', { className: 'mgp_sectionLabel' }, g.provider.name),
          h('span', { className: mgCls('mgp_twist', groupOpen(g.id) && 'mgp_twistOpen') }, '▶'),
        ),
        groupOpen(g.id) ? g.models.map(m => modelRow(g, m)) : null,
      ))

      let menuChildren
      if (pane === 'root') {
        menuChildren = [h('button', { key: 'model', ref: itemRef(), type: 'button', role: 'menuitem', className: 'mgp_cell',
          onClick: () => { setQuery(''); setHighlightedIndex(null); setPane('model') } },
          h('span', { className: 'mgp_cellLabel' }, tr('menu.model', '模型')),
          h('span', { className: 'mgp_cellValue' }, currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.model)),
          h('span', { className: 'mgp_cellChevron' }, '›'),
        )]
        if (reasoning !== undefined) menuChildren.push(h('button', { key: 'effort', ref: itemRef(), type: 'button', role: 'menuitem',
          className: 'mgp_cell', onClick: () => { setQuery(''); setHighlightedIndex(null); setPane('effort') } },
          h('span', { className: 'mgp_cellLabel' }, tr('menu.effort', '推理等级')),
          h('span', { className: 'mgp_cellValue' }, effortLabel),
          h('span', { className: 'mgp_cellChevron' }, '›'),
        ))
        if (mode !== undefined && !addressedChild && !listedChild) menuChildren.push(h('div', { key: 'team', className: 'mgp_teamRow' },
          h('span', { className: 'mgp_teamLabel' },
            h('span', null, tr('mode.label', '启用智能体团队协作')),
            mgPrim.Tooltip
              ? h(mgPrim.Tooltip, {
                label: tr('mode.description', '让多个智能体协作完成当前任务'),
                side: 'top', delayMs: 300, maxWidth: 300, portal: true, openOnClick: true,
              }, h('span', { className: 'mgp_teamInfo', role: 'img', 'aria-label': tr('mode.infoLabel', '说明') }, 'i'))
              : h('span', { className: 'mgp_teamInfo', title: tr('mode.description', '让多个智能体协作完成当前任务') }, 'i'),
          ),
          h('button', {
            type: 'button', role: 'switch', 'aria-checked': mode.enabled === true,
            'aria-label': tr('mode.label', '启用智能体团队协作'),
            className: mgCls('mgp_switch', mode.enabled && 'mgp_switchOn', !mode.enabled && 'mgp_switchOff'),
            disabled: locked || busy || teamPending || modelSel === undefined,
            onClick: () => setTeam(!mode.enabled),
          }, h('span', { className: 'mgp_switchKnob' })),
        ))
      } else if (pane === 'model') {
        menuChildren = [
          showSearch ? h('div', { key: 'search', className: 'mgp_searchRow' },
            h('input', { ref: searchRef, className: 'mgp_searchInput', type: 'text', role: 'searchbox',
              'aria-label': tr('search.placeholder', '搜索模型…'), 'aria-controls': `${id}-models`,
              'aria-activedescendant': activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`,
              placeholder: tr('search.placeholder', '搜索模型…'), value: query, readOnly: busy,
              onChange: ev => { setQuery(ev.target.value); setHighlightedIndex(0) } }),
            query !== '' ? h('button', { type: 'button', className: 'mgp_searchClear', 'aria-label': tr('search.clear', '清除'),
              disabled: busy, onClick: () => { setQuery(''); setHighlightedIndex(0); searchRef.current?.focus() } }, '×') : null,
          ) : null,
          state.status === 'loading' ? h('div', { key: 'load', className: 'mgp_status' }, tr('status.loading', '加载中…')) : null,
          state.error !== null && state.error !== undefined && lastActionRef.current === 'load'
            ? h('div', { key: 'err', className: 'mgp_error' },
              h('span', null, `${tr('error.action', '加载失败：')}${state.error}`),
              h('button', { type: 'button', className: 'mgp_retry', onClick: reload }, tr('retry', '重试'))) : null,
          (state.failures || []).map(f => h('div', { className: 'mgp_warning', key: f.id },
            h('span', null, `${f.name || f.id}：${f.message}`),
            h('button', { type: 'button', className: 'mgp_retry', onClick: reload }, tr('retry', '重试')))),
          h('div', { key: 'groups', ref: groupsRef, id: `${id}-models`, className: mgCls('mgp_groups', 'scrollable'),
            role: 'menu', 'aria-label': tr('menu.model', '模型'), hidden: filteredGroups.length === 0 },
            mobaiSection, ...plainSections,
          ),
          state.status === 'ready' && filteredGroups.length === 0
            ? h('div', { key: 'empty', className: 'mgp_empty', role: 'status' }, tr(choices.length === 0 ? 'empty.models' : 'search.empty', '没有模型')) : null,
        ]
      } else {
        menuChildren = [
          state.error !== null && state.error !== undefined && lastActionRef.current === 'load'
            ? h('div', { key: 'err', className: 'mgp_error' }, h('span', null, state.error),
              h('button', { type: 'button', className: 'mgp_retry', onClick: reload }, tr('retry', '重试'))) : null,
          h('div', { key: 'efforts', className: mgCls('mgp_groups', 'scrollable') },
            effortChoices.length === 0 ? h('div', { className: 'mgp_empty' }, tr('empty.efforts', '无思考档位')) :
              effortChoices.map(level => h('button', {
                ref: itemRef(), type: 'button', role: 'menuitemradio', 'aria-checked': effectiveEffort === level.effort,
                className: mgCls('mgp_option', effectiveEffort === level.effort && 'mgp_selected'), key: level.key, disabled: busy,
                onClick: () => chooseEffort(level.effort),
              },
                h('span', { className: 'mgp_optionCopy' }, h('span', { className: 'mgp_modelName' }, level.label)),
                h('span', { className: 'mgp_check' }, effectiveEffort === level.effort ? '✓' : null),
              )),
          ),
        ]
      }
      const MenuSurface = mgPrim.MenuSurface || 'div'
      const menuNode = h(MenuSurface, { ref: menuRef, id: `${id}-menu`, className: 'mgp_menu', style: anchorStyle,
        role: pane === 'model' ? 'group' : 'menu', 'aria-label': tr('menu.aria', '模型选择'),
        'aria-busy': state.status === 'loading' || busy }, menuChildren)

      return h('div', { ref: rootRef, className: 'mgp_root', onKeyDown: onRootKeyDown, onBlur: onBlur,
        onMouseDown: ev => {
          if (ev.target instanceof Element && ev.target.closest('button') !== null) ev.preventDefault()
        } },
        h('button', { ref: triggerRef, type: 'button', className: 'mgp_trigger', style: anchorStyle,
          'aria-label': `选择模型：${triggerLabel}`, 'aria-haspopup': 'menu', 'aria-expanded': open,
          'aria-controls': open ? `${id}-menu` : undefined, title: triggerLabel, 'aria-busy': busy,
          'data-selection-focus': selectionFocus ? '' : undefined,
          onBlur: () => setSelectionFocus(false), disabled: locked,
          onClick: () => { if (open) close(true); else show() } },
          h('span', { className: 'mgp_triggerLabel' }, currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.model)),
          effortLabel !== undefined ? h('span', { className: 'mgp_triggerEffort' }, effortLabel) : null,
          busy ? h('span', { className: 'mgp_status' }, '◌')
            : h('span', { className: mgCls('mgp_chevron', open && 'mgp_chevronOpen') }, '▾'),
        ),
        open ? (mgReactDom ? mgReactDom.createPortal(menuNode, document.body) : menuNode) : null,
        toast !== null ? h('div', { key: toast.seq, className: 'mgp_toast', role: 'alert' },
          toast.text, h('button', { type: 'button', onClick: () => setToast(null) }, '×')) : null,
        confirmOpen ? h('div', { className: 'mgp_confirm', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'mgp_confirmCard' },
            h('div', null, '关闭团队模式？当前使用的模型会被清空。'),
            h('div', { className: 'mgp_confirmActions' },
              h('button', { type: 'button', onClick: () => setConfirmOpen(false) }, '取消'),
              h('button', { type: 'button', onClick: () => { setConfirmOpen(false); doSetTeam(false) } }, '关闭'),
            ),
          ),
        ) : null,
      )
    }

    return {
      name: 'dsh-connect-model-gateway',
      inject: ['slots', 'locale'],
      apply(ctx) {
        const injectSlot = (name, callback) => {
          try {
            return ctx.slots.inject(name, callback)
          } catch {
            return undefined
          }
        }

        /**
         * 网关文案走宿主 locale 服务（TK-0004）。
         *
         * 宿主没提供 locale（老版本/精简组合）时退回 GATEWAY_T.zh，
         * 保证界面不会出现 undefined。
         */
        try {
          ctx.effect?.(() => ctx.locale?.register?.(GATEWAY_NS, GATEWAY_T))
        } catch (error) {
          console.warn('[model-gateway] 网关文案注册失败：', error)
        }
        let t = gatewayFallbackT
        try {
          const bound = ctx.locale?.bind?.(GATEWAY_NS)
          if (typeof bound === 'function') t = bound
        } catch { /* 用兜底 */ }


        // 只替换 composer 里的模型弹窗；single 槽 priority 低者胜（-1 压过宿主 0）。
        // 崩溃时槽框架自动 abdicate 回宿主选择器，不会让 composer 缺模型入口。
        try {
          mgInjectCss()
          // 团队开关原先住在 conversation.input.model.options 子插槽里；子插槽
          // 的声明权归宿主，替换父 entry 后无法再转发，于是把同样的能力搬进来。
          try {
            ctx.inject(['remote', 'remote.agentTeams'], (scope) => {
              mgTeamApi = {
                setEnabled: (sessionId, enabled) => scope.remote.agentTeams.setEnabled(sessionId, enabled),
              }
            })
          } catch { /* 没装 agent-team 就不显示这个开关 */ }
          {
            // 直接在主 fiber 上注册；modelDirectories/sessions 在渲染时用 ctx.get
            // 延迟取——嵌套 ctx.inject 声明这些依赖会因本包未声明而永不激活。
            const mount = () => ctx.slots.inject('conversation.input.model', () =>
              ctx.slots.register({
                name: 'conversation.input.model',
                locale: 'model',
                priority: -1,
                registrant: 'dsh-connect-model-gateway',
                inject: (sessionId) => {
                  const models = ctx.get('modelDirectories')
                  const sessions = ctx.get('sessions')
                  if (!models || !sessions) {
                    return { available: false, directory: null, load: () => {}, select: () => Promise.resolve(), resolveText: text => (text && text.text) || '', sessionId }
                  }
                  const dir = models.directoryFor(sessionId)
                  return {
                    available: sessions.subagentAddress(sessionId) === undefined,
                    directory: dir.store,
                    load: () => { dir.load().catch(() => {}) },
                    select: selection => dir.select(selection),
                    resolveText: text => ctx.locale?.resolveText ? ctx.locale.resolveText(text) : ((text && text.text) || ''),
                    sessionId,
                  }
                },
              }, GatewayModelSelect),
            )
            // 开关关掉时整条 entry 撤掉（而不是只让组件返回 null）——
            // 否则槽里仍是我们这条低优先级 entry，宿主选择器永远上不来。
            let live = readPrefs().useGatewayPicker === false ? null : mount()
            const unsubscribe = subscribePrefs((next) => {
              const want = next.useGatewayPicker !== false
              if (want && live === null) { live = mount(); return }
              if (!want && live !== null) { try { live.dispose() } catch { /* 已释放 */ } live = null }
            })
            ctx.effect(() => () => {
              unsubscribe()
              if (live !== null) { try { live.dispose() } catch { /* 已释放 */ } live = null }
            })
          }
        } catch (error) {
          // 依赖服务未就绪就不注册，宿主选择器照常工作。
          console.warn('[model-gateway] 模型选择器替换未生效：', error)
        }

        injectSlot('settings.section', () =>
          ctx.slots.register({
            name: 'settings.section',
            id: SECTION_ID,
            order: 62,
            label: () => T.name,
          }, () => h(PoolPage, { t })),
        )

        injectSlot('conversation.input.left', () =>
          ctx.slots.register({
            name: 'conversation.input.left',
            id: 'dsh-connect-model-gateway-credits',
            order: 5,
            inject: () => ({ ctx }),
          }, CreditPill),
        )

        // 与包根 icon.svg 同一套几何（星芒 + 拱桥 + 桥面 + 桥墩），这里用
        // currentColor 跟随主题；插件列表用彩色 icon.svg，两处轮廓一致。
        injectSlot('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID }, () =>
            h('svg', { viewBox: '0 0 36 36', width: 16, height: 16, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' },
              h('path', { d: 'M18 2.4 19.2 5.2 22 6.4 19.2 7.6 18 10.4 16.8 7.6 14 6.4 16.8 5.2Z', fill: 'currentColor', stroke: 'none' }),
              h('path', { d: 'M8.6 20.6h18.8', strokeWidth: 2.2 }),
              h('path', { d: 'M7.6 26.2c0-5.8 4.7-10.5 10.4-10.5s10.4 4.7 10.4 10.5', strokeWidth: 2.6 }),
              h('path', { d: 'M4.4 26.2h27.2M9.4 26.2v3.4M26.6 26.2v3.4', strokeWidth: 2.2 }),
            )),
        )
      },
    }
  },
})
