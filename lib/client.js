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
      autoPolicyHint: '默认勾这 6 项',
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
      return h('div', { style: { ...S.cand, ...(candidate.ready ? {} : { opacity: 0.62 }) } },
        h('div', { style: S.candIdx },
          h('span', { style: { color: '#cfd4db', fontSize: 11, letterSpacing: '-1px' } }, '⠿'),
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
            h('span', { style: { marginLeft: 'auto' } }),
            h('span', { style: S.hint }, T.autoPolicyHint),
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
            : history.map((entry, index) => {
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
              }),
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

    /** 概览页：插件说明 + 所有平台卡片。 */
    function Overview({ platforms, auto, onManage, onManageAuto, onReload, error }) {
      const signedIn = platforms.filter((platform) => platform.auth?.state === 'signed-in').length
      const accountCount = platforms.reduce((sum, platform) => sum + (platform.accounts?.length ?? 0), 0)
      const enabledCount = platforms.reduce((sum, platform) => sum + (platform.enabledCount ?? 0), 0)
      return h('div', null,
        h('div', { style: S.hero },
          h('h1', { style: S.heroTitle }, T.heroTitle),
          h('p', { style: S.heroDesc }, T.heroDesc),
          h('div', { style: S.heroStats },
            h('div', null, h('div', { style: S.statN }, String(platforms.length)), h('div', { style: S.statL }, T.statPlatforms)),
            h('div', null, h('div', { style: S.statN }, String(signedIn)), h('div', { style: S.statL }, T.statSignedIn)),
            h('div', null, h('div', { style: S.statN }, String(accountCount)), h('div', { style: S.statL }, T.statAccounts)),
            h('div', null, h('div', { style: S.statN }, String(enabledCount)), h('div', { style: S.statL }, T.statEnabled)),
          ),
          h('div', { style: S.heroTips }, T.heroTip),
        ),
        error ? h('div', { style: S.err }, error) : null,
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
    }

    function PoolPage() {
      const [data, setData] = useState({ platforms: [] })
      const [active, setActive] = useState('')
      // view: null = 概览；AUTO_KEY = Auto 管理；其余是平台键
      const [managing, setManaging] = useState(null)
      /** Auto 的完整视图（候选全量 + 目录 + 日志），只在打开管理页时拉。 */
      const [autoFull, setAutoFull] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      const load = useCallback(async () => {
        try {
          const next = await api('/status')
          setData(next)
          setError('')
          // 正在管理的平台被删掉了就退回概览，别停在空面板上。
          // AUTO_KEY 不是平台，不受这条守卫管辖 —— 漏掉它会让 20 秒一次的轮询
          // 把 Auto 管理页踢回概览。
          setManaging((current) => {
            if (current === null || current === AUTO_KEY) return current
            return next.platforms.some((p) => p.provider === current) ? current : null
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 20_000)
        return () => clearInterval(timer)
      }, [load])

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
        return h('div', { style: S.wrap }, h('p', { style: S.heroDesc }, error || '还没有平台接入。'))
      }

      // 概览：插件说明 + 卡片
      if (managed === undefined && managing !== AUTO_KEY) {
        return h('div', { style: S.wrap },
          h(Overview, {
            platforms,
            auto: data.auto,
            error,
            onManage: (provider) => { setManaging(provider); setError('') },
            onManageAuto: () => {
              setManaging(AUTO_KEY)
              setError('')
              void loadAuto()
            },
            onReload: reload,
          }),
        )
      }

      // Auto 管理：数据来自 /auto（含目录与日志），与平台面板互不影响
      if (managing === AUTO_KEY) {
        return h('div', { style: S.wrap },
          h('button', { style: S.backBtn, onClick: () => { setManaging(null); setError('') } }, T.backToOverview),
          error ? h('div', { style: S.err }, error) : null,
          autoFull === null
            ? h('div', { style: S.kv }, '加载中…')
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

    return {
      name: 'dsh-connect-model-gateway',
      inject: ['slots'],
      apply(ctx) {
        const injectSlot = (name, callback) => {
          try {
            return ctx.slots.inject(name, callback)
          } catch {
            return undefined
          }
        }

        injectSlot('settings.section', () =>
          ctx.slots.register({
            name: 'settings.section',
            id: SECTION_ID,
            order: 62,
            label: () => T.name,
          }, PoolPage),
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
