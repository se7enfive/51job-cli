/**
 * ehire.51job.com 页面选择器集中配置层。
 *
 * 说明：ehire 企业端页面结构随改版变化，本文件为初始默认值。
 * 请先运行 `51job probe` 探查实际页面结构，然后按 probe 输出校准本文件。
 * 每组的 key 即 probe 输出的元素标识，校准只需改 selector 字符串。
 */

export interface SelectorSet {
  [key: string]: string;
}

export const selectors = {
  /** 登录页（login.51job.com / ehire.51job.com 登录弹层） */
  login: {
    /** 微信扫码登录切换按钮 */
    wechatTab: '.login-tab-wechat, [class*="wechat"], [class*="Wechat"]',
    /** 手机验证码输入框 */
    phoneInput: 'input[type="tel"], input[name="mobile"], input[placeholder*="手机"]',
    /** 获取验证码按钮 */
    sendCode: 'button[class*="code"], [class*="getCode"], [class*="send-code"], [class*="sms"]',
    /** 验证码输入框 */
    codeInput: 'input[name="code"], input[placeholder*="验证码"], input[placeholder*="短信"]',
    /** 登录/提交按钮 */
    submit: 'button[type="submit"], [class*="login-btn"], [class*="submit"]',
    /** 扫码登录二维码容器 */
    qrContainer: '[class*="qrcode"], [class*="qr-code"], canvas',
  },

  /** 登录成功标志（用于轮询检测） */
  loginSuccess: {
    /** 登录后进入的工作台/首页标志元素 */
    dashboard: '[class*="dashboard"], [class*="home"], [class*="index"]',
  },

  /** 收件箱 / 候选人投递列表（我的工作台 resume-card 卡片） */
  inbox: {
    list: '[class*="resume-list"], [class*="candidate-list"], [class*="delivery-list"]',
    item: '.resume-card',
    name: '.resume-base-info .name',
    time: '.delivery-info span',
    unreadBadge: '[class*="unread"], [class*="badge"], [class*="dot"]',
    snippet: '.delivery-info',
    /** 第二行画像：26岁 / 2年 / 本科 / 广州 */
    infoItem: '.secondline .info-item',
    pagination: '[class*="pagination"], [class*="page"]',
  },

  /** 人才搜索页（/Revision/talent/search，2026-08-26 实测校准） */
  search: {
    /** 搜索页 URL（SPA，搜索后 URL 不变） */
    url: 'https://ehire.51job.com/Revision/talent/search',
    /** 搜索词输入框（el-input 内部 input，需原生 setter + input 事件驱动 Vue） */
    keywordInput: '.talent_search_keywords_input input',
    /** 搜索按钮 */
    searchBtn: 'button.search_button',
    /** 结果列表容器 */
    resultList: '.list-box',
    /** 候选人卡片（`.item.resume-card`） */
    resultItem: '.resume-card',
    /** 无结果提示容器（存在即表示本次搜索无匹配） */
    noResult: '.no-search-text',
    /** 姓名 */
    name: '.userinfo .name',
    /** 求职意向区（地点+期望职位+薪资，如「求职意向：深圳,广州 室内设计 1.1-1.7万/月」） */
    expect: '.expect',
    /** 状态标签（已转发/已聊等） */
    expectGray: '.expect_gray',
    /** 活跃时间（如「24小时内活跃」） */
    active: '.active',
    /** 所在城市 */
    address: '.address',
    /** 当前/最近公司 */
    company: '.company_name',
    /** 当前/最近职位 */
    job: '.job_name',
    /** 自我描述/简介 */
    desc: '.content_text_wrapper',
    jobSelect: 'select, [class*="job-select"], [class*="dropdown"]',

    // ---- 筛选控件（2026-08-26 实测校准） ----
    /** 筛选条容器 */
    filterRow: '.search-row-list',
    /** 下拉触发器（label 即筛选项名，10 个：工作年限/年龄/居住地/学历要求/学校性质/期望行业/期望职能/期望月薪/从事行业/从事职能） */
    baseSelectBtn: '.base-select-button',
    /** 触发器内 label 文本 */
    baseSelectLabel: '.base-select-label',
    /** popover 式弹层选项（工作年限/年龄/学历要求/学校性质/期望月薪 用 el-popover） */
    popperOption: '.base-select-popper .option-item',
    /** dialog 式弹窗选项（居住地/期望行业/期望职能/从事行业/从事职能 用 el-dialog，含 li.cascader_panel_item 级联项） */
    dialogOption: 'li.cascader_panel_item',
    /** 期望工作地输入框（搜索头区域） */
    cityInput: 'input[placeholder="期望工作地"]',
    /** 性别输入框（可直接输入文字） */
    genderInput: 'input[placeholder="性别"]',
    /** 求职状态输入框 */
    statusInput: 'input[placeholder="求职状态"]',
  },

  /** 人才推荐页「人才望远镜」（/Revision/talent/search-recommend，2026-08-26 实测校准） */
  recommend: {
    /** 推荐页 URL（人才望远镜，智能推荐池） */
    url: 'https://ehire.51job.com/Revision/talent/search-recommend',
    /** 推荐卡片（与搜索页同结构 .item.resume-card，外层 .el-card） */
    resultItem: '.item.resume-card',
    /** 姓名 */
    name: '.userinfo .name',
    /** 求职意向区（地点+期望职位+薪资） */
    expect: '.expect',
    /** 状态标签（已转发/已聊等） */
    expectGray: '.expect_gray',
    /** 活跃时间 */
    active: '.active',
    /** 所在城市 */
    address: '.address',
    /** 当前/最近公司 */
    company: '.company_name',
    /** 当前/最近职位 */
    job: '.job_name',
    /** 自我描述 */
    desc: '.content_text_wrapper',
    /** 「立即Hi聊」按钮 */
    hiBtn: 'button.tm_button',
    /** 左侧岗位菜单项（推荐按岗切换） */
    jobMenuItem: '.menu-item',
  },

  /** 人才管理页（候选人行 + 「回复」按钮 = 聊天入口，实测 2026-08-25） */
  talentMgmt: {
    /** 行内「回复」按钮（聊天入口；以它为锚向上找行容器） */
    replyBtn: 'button.tm_button',
    /** 行内姓名元素 */
    name: '.name',
  },

  /** 候选人简历详情页（/Revision/talent/resume/detail，点击搜索卡片后新开 tab，2026-08-26 实测校准） */
  candidateDetail: {
    /** 详情页 URL 特征 */
    urlPattern: '/Revision/talent/resume/detail',
    /** 顶部信息区：姓名/活跃/求职状态/年龄/经验/学历/现居（.resume_detail_content 为容器） */
    header: '.resume_detail_info',
    /** 姓名（详情页出现两次，user_name 容器） */
    name: '.user_name',
    /** 求职意向区（期望职位/城市/性质/薪资 + 求职偏好技能） */
    intention: '.eh_resume_detail_job_intention_wrap',
    /** 工作经历条目容器 */
    workItem: '.workExp_item',
    /** 工作经历-时间段（如「2012.05-2026.02（13年9个月）」） */
    workTimeRange: '.work_timerange',
    /** 工作经历-职责描述 */
    workContent: '.work_content',
    /** 教育经历容器 */
    eduWrap: '.education_wrap',
    /** 技能标签（求职偏好 + 智能标签） */
    skillTag: '.tag_skill',
    /** 技能明细标签（RTK/全站仪/GPS…，.skill_label 在 skill_card 内） */
    skillLabel: '.skill_label',
    /** 技能卡片文本（设备/经验/软件/证书分组的原始文本） */
    skillCard: '.skill_card_content',
    /** 右侧动作卡「立即Hi聊」按钮（点击即打招呼；实际祖先链 .chat_btn ← .btn_item_chat） */
    hiChatBtn: '.chat_btn, .btn_item_chat',
  },

  /** Hi聊 会话页（人才管理页点「回复」后右侧展开的 chatting-area 面板） */
  chat: {
    sessionList: '[class*="session-list"], [class*="chat-list"], [class*="conversation"]',
    sessionItem: '[class*="session-item"], [class*="chat-item"]',
    /** 聊天输入框（面板内 contenteditable div，placeholder「发送给 <姓名>」）。
     * 注意：DOM 常驻一个 0x0 隐藏模板实例，匹配时必须校验可见性（rect>0）。 */
    messageInput: '.input-textarea_self',
    /** 发送按钮。注意：不能加 `.send-box` 等容器兜底——逗号选择器按 DOM 序返回，
     * 容器排在按钮前且 rect>0，坐标点击会落到容器中心（输入框上）而非按钮。 */
    sendBtn: '.new-send-button',
    messages: '[class*="message-content"], [class*="chat-content"]',
    actionMenu: '[class*="action"], [class*="toolbar"], [class*="more"]',
  },

  /** 职位管理页（/Revision/job-manage，2026-08-26 实测校准） */
  job: {
    /** 职位卡片 */
    jobItem: '.job_card',
    /** 职位名称 */
    jobName: '.job_name',
    /** 职位类型标签（如「竞招」） */
    jobTypeTag: '.job-type-tag',
    /** 状态标签（已暂停/到期下线/审核中等，可能多个） */
    jobTag: '.job_tag',
    /** 详情行：地点|学历|经验|薪资 */
    bottomInfo: '.job_bottom_info',
    /** 待处理人才数 */
    cardNum: '.job_card_num',
    jdContent: '[class*="jd-content"], [class*="job-desc"], [class*="description"]',
    refreshBtn: '[class*="refresh"], [class*="repost"]',
  },

  /** 简历预览（在线简历弹窗，2026-08-25 实测校准） */
  resume: {
    /** 会话面板头部「在线简历」入口图标 */
    entry: '.chat-user-operate .file-style.online',
    /** 在线简历弹窗（含求职意向/工作经历/教育经历） */
    dialog: '.resume',
    /** 弹窗关闭按钮 */
    close: '.con-close',
    content: '[class*="resume-content"], [class*="cv-content"], [class*="preview"]',
    downloadBtn: 'button[class*="download"], [class*="export"]',
  },

  /** Hi聊 结果弹窗（点击「立即Hi聊」后可能弹出的模态框；需手动点关闭，2026-08-26 实测） */
  hiResult: {
    /** 弹窗容器（element-plus el-dialog 类结构，含 mask + dialog + wrapper） */
    dialog: '[role="dialog"], .el-dialog, [class*="el-message-box"], [class*="dialog"]',
    /** 关闭按钮（右上角 ×，el-dialog 标准结构） */
    close: '.el-dialog__headerbtn, [class*="dialog"] [class*="close"]',
    /** 弹窗内可点的确认/知道了按钮（文本匹配兜底） */
    confirmBtn: 'button',
  },

  /** 风控/验证特征元素 */
  risk: {
    captcha: '[class*="captcha"], [class*="verify"], [class*="geetest"], [id*="captcha"]',
    dialog: '[class*="dialog"], [class*="modal"], [class*="popup"]',
  },
} as const;

export type SelectorGroup = keyof typeof selectors;
