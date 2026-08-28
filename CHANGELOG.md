# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-28

### Added
- **[T203]** 新增 `51job clean` 命令用于清理本地生成的 OCR 文本、截图与探针快照。
- **[T301]** 增加 `npm test`（基于 Vitest）与 `npm run typecheck` 测试门禁。
- **[T302]** 新增 GitHub Actions CI 检查（push/PR）与发布门禁。

### Changed (Breaking or Behavior Changes)
- **[T205] 防注入**：默认不再加载当前目录的 `./.env`，需显式设置 `51JOB_PROJECT_ENV=1` 才会加载（用户级 `~/.51job-cli/.env` 默认加载逻辑不变）。
- **[T202] 隐私安全**：简历预览时的 OCR 打码识别改为**默认关闭（opt-in）**。需显式配置 `51JOB_RESUME_OCR=1` 且同意数据上传百度智能云方可开启。
- **[T103] JSON 协议**：`--json` 模式 stdout 保证恒为单文档 JSON。`inspect`/`recommend`/`talent-detail` 内的 `--hi` 执行结果并入最终 JSON 文档中一并输出（附加 `hiResult` 字段），取代了以前过程分次输出破坏 JSON 结构的问题。失败通过附加 `error` 字段体现。
- **[T102] 退出码契约**：四条打招呼路径的失败（`quota_exhausted` / `failed` / `unknown`）现均会非零退出 1；`--dry-run` 和交互确认跳过时返回 0（`dry_run` / `cancelled`），修复了失败误退 0 干扰 AI 编排的问题。
- **[T109] 交互安全**：非 TTY 环境或 stdin 关闭（EOF）时遇到打招呼确认等不可逆操作，不再无限挂起，改为立即拒绝；自动化脚本需显式传递 `--no-confirm`。
- **[T308] 默认拦截收敛**：`collect`/`monitor` 等含埋点类关键词的内部请求，默认仅观察记录不再 204 阻断，避免误杀业务接口导致工具操作被“静默吞噬”。如果已查明确认为埋点的 URL 可按需配置 `51JOB_BLOCK_REPORT_PATTERNS` 阻断。
- **[T104] `wait-login`**：超时或使用非法 `--timeout` 参数（负数/非数字）时会立即抛错（退出码 1），便于编排区分。
- **[T112] `search --position`**：按职位搜索（与 `<关键词>` 互斥）——自动导航职位管理页读职位卡，注入期望工作地/学历筛选并锁定搜索范围，零城市参数即可收敛（`--scope my|org` 选视图；显式 `--city` 等参数覆盖注入值；职位卡未找到回退「不限职位」，未显式城市时 fail 拒绝裸奔全池）。
- **[T112] `search --json` 输出对象化（Breaking）**：从纯数组改为 `{keyword, count, hits, ...}`（`--position` 时含 `position/positionScope/injected/fallback`），注入成败可观测；编排消费方需从数组改读 `.hits`。
- **[T112] 搜索范围清池**：关键词匹配不到职位时自动切「不限职位」（替代保留上次残留 tag），根治搜索结果锁死旧职位池的问题。

### Deprecated
- **[T401]** 环境变量 `RECRUIT_BROWSER_HIDDEN` 被弃用，更名为 `RECRUIT_BROWSER_HEADLESS`（本版本内仍兼容）。
- **[T401]** 不推荐使用通用名的百度服务密钥（`API_KEY`/`SECRET_KEY`），这与其它集成易串扰。建议迁移使用 `51JOB_BAIDU_API_KEY`/`51JOB_BAIDU_SECRET_KEY`。

### Fixed
- **[T305] 可用性检测自愈**：偶尔因断网原因导致的自检受挫不再禁用写出 6 小时长效失败缓存，改为 2 分钟的 Pending 豁免执行。
- **[T307] 浏览器生命周期**：修复因旧 Chrome Profile 宕机死锁情况下无法起新常驻实例的致命挂起；自修复旧进程失联清理功能。
- **[T107] 详情抓取**：加固简历详情身份匹配，错位二次校验失败时会立刻断开，不再交付污染过的对应候选人记录。
- **[T108] 并发控制**：修复会话页面跳风控自刷或 context 销毁时，将已完成外发聊天消息二次整段重试发送的竞态机制，新增消息记录探测护栏保护。
- **[T106] 并发遮蔽**：Hi 结果校验严格束敛由点击操作发起的那张单一选项卡，不再因为未读列表的其他初始文案项存在导致成功被误报 `unknown` 状态。
- **[T105] chat 编号匹配**：完全统一 `list` 和 `chat` 对于「--unread 时 # 列序号偏移错乱」问题。
- **[T306] 详情 Tab 轮询**：修复连入两次同一个页面 URL 被判定为永远没捕获到新详情的问题。
- **[T303] Smoke 冒烟**：脚本环境独立了临时存放数据，不再污染并抢占本地运行态浏览器进程。
