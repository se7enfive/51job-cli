# 修复任务总索引

来源：2026-08-27 完整代码审查（基线 commit `577860c`，行号以该提交为准，实施时以文件 + 函数名为锚点）。

## 使用约定

1. **一个任务一个 commit**，消息格式：`fix(T1xx): 描述` / `chore(T3xx): 描述` / `docs(T4xx): 描述`。
2. 实施前先读本任务文件全文；完成后勾选验收项、更新本索引状态列。
3. **验证分级**：
   - 自动验证：`npm run build` / `npm test`（T301 落地后）可直接跑；
   - 实机验证（标 🧪）：需要真实 51job 账号 + 本机 Chrome，按任务内步骤人工执行。
4. **文件冲突**：同组任务触碰相同文件，必须串行实施（见文末冲突组表）。
5. 任务内「修复要求」是指令性的；如实施中发现与现状不符，先更新任务文件再动代码。

## 阶段总览

| 阶段 | 目标 | 任务 |
|---|---|---|
| Phase 1 | 正确性与退出码契约（阻断级） | T101–T110 |
| Phase 2 | 安全与隐私 | T201–T205 |
| Phase 3 | 质量门禁与可靠性加固 | T301–T308 |
| Phase 4 | 文档与配置对齐 | T401–T404 |

执行顺序基本等于编号顺序；跨阶段依赖在任务表「依赖」列标注。

## 任务表

| ID | 任务 | 优先级 | 依赖 | 主要文件 | 状态 |
|---|---|---|---|---|---|
| T101 | `fail()` 异常化退出（基础机制） | P0 | 无 | utils/output.ts、index.ts | done |
| T102 | `greet` 退出码与结果类型修正 | P0 | T101 | index.ts、pages/search.ts、pages/hi-result.ts | done |
| T103 | JSON 输出协议：单文档 + 统一退出码 | P0 | T101、T102 | index.ts | done |
| T104 | `wait-login` 超时退出码与参数校验 | P0 | T101 | index.ts、pages/login.ts | done |
| T105 | `list`/`chat` 序号空间一致性 | P0 | 无 | pages/inbox.ts、pages/chat.ts、index.ts | done |
| T106 | Hi 结果判定收敛到被点击卡片 | P0 | 无 | pages/hi-result.ts、pages/recommend.ts、pages/search.ts | done |
| T107 | 详情页身份校验与错位防护 | P0 | 无 | pages/talent-insight.ts、pages/candidate-detail.ts、index.ts | done |
| T108 | 会话重试边界：写操作不自动重跑 | P0 | 无 | core/sessionPage.ts、pages/chat.ts | done |
| T109 | 非交互确认安全（stdin EOF 不挂起） | P1 | 无 | utils/confirm.ts | done |
| T110 | 输入防护杂项（未命中/空关键词/0 falsy） | P1 | T105 | index.ts、pages/search.ts | done |
| T201 | CDP 调试端点收敛 | P0 | 无 | core/browser.ts、utils/store.ts | done |
| T202 | 简历 OCR 改显式 opt-in | P0 | 无 | ocr/resume_ocr.ts、pages/chat.ts | done |
| T203 | 本地 PII 权限收紧与保留期清理 | P1 | 无 | utils/store.ts、index.ts（新 clean 命令） | done |
| T204 | 会话锁不再记录完整命令行 | P1 | 无 | core/sessionLock.ts | todo |
| T205 | cwd `.env` 加载策略收敛 | P1 | 无 | index.ts | todo |
| T301 | Vitest 单元测试基线 | P1 | T102/T103/T105（映射类用例） | package.json、test/（新增） | todo |
| T302 | CI 门禁与发布流程修复 | P1 | T301 | .github/workflows/*、package.json | todo |
| T303 | smoke 冒烟测试隔离化 | P2 | 无 | scripts/smoke-*、core/state.ts、utils/store.ts | todo |
| T304 | 脚本归档与死代码清理 | P2 | 无 | scripts/*、多个 src 文件 | todo |
| T305 | availability 网络失败缓存修复 | P1 | 无 | core/availability.ts | todo |
| T306 | 异步超时与详情 tab 捕获加固 | P1 | T107 | ocr/baidu_ocr.ts、pages/candidate-detail.ts、pages/talent-insight.ts、core/pageGuards.ts | todo |
| T307 | 浏览器生命周期加固 | P1 | T101 | core/browser.ts、core/sessionPage.ts | todo |
| T308 | 默认拦截规则收敛 | P2 | 无 | core/pageGuards.ts | todo |
| T401 | 环境变量统一（命名与优先级） | P2 | 无 | core/browser.ts、ocr/baidu_ocr.ts | todo |
| T402 | `.env.example` 修正 | P2 | T202、T205、T401 | .env.example | todo |
| T403 | README / CAPABILITIES / AGENTS / RELEASE 同步 | P2 | 多数任务后 | README.md、docs/CAPABILITIES.md、AGENTS.md、RELEASE.md | todo |
| T404 | 仓库卫生（LICENSE / lockfile / main / CHANGELOG） | P2 | 无 | LICENSE、package.json、package-lock.json | todo |

## 建议执行批次

- **批次 1（Phase 1 全部）**：T101 → T102 → T103 → T104 → T105 → T106 → T107 → T108 → T109 → T110。
  T101 是机制改造，先行可避免后续任务返工；T105/T106/T107/T108 与 T101 无代码依赖，可在 T101-T104 之外并行（注意冲突组）。
- **批次 2（Phase 2）**：T201 与 T202 可并行；T203、T204、T205 独立。
- **批次 3（Phase 3）**：T305、T306、T307 先行（可靠性），T301 → T302 建立门禁，T303、T308、T304 收尾。
- **批次 4（Phase 4）**：T401 → T402 → T403；T404 随时可做。

## 文件冲突组（同组串行）

| 冲突组 | 文件 | 涉及任务 |
|---|---|---|
| G1 | index.ts | T101、T102、T103、T104、T105、T107、T110、T205 |
| G2 | utils/output.ts | T101 |
| G3 | core/sessionPage.ts | T108、T307 |
| G4 | pages/hi-result.ts、pages/recommend.ts、pages/search.ts | T102、T106 |
| G5 | pages/talent-insight.ts、pages/candidate-detail.ts | T107、T306 |
| G6 | utils/store.ts | T201、T203、T303 |
| G7 | core/browser.ts | T201、T307、T401 |
| G8 | core/pageGuards.ts | T306、T308 |
| G9 | ocr/baidu_ocr.ts | T306、T401 |
| G10 | pages/chat.ts | T105、T108、T202 |

## 全局验收（Phase 1–4 全部完成后）

- [ ] `npm run build`、`npm test`、`npm run typecheck` 全绿
- [ ] 读命令全链路实机回归：login → wait-login → list → search → recommend → inspect → talent-detail → positions → jd（🧪）
- [ ] 写命令受控回归：send / greet / action 各 1 次人工监督执行（🧪）
- [ ] 断网场景：命令快速失败或 warn 跳过，不被 6h 禁用（🧪）
- [ ] 文档走查：README 命令表与 `51job --help` 逐条对照一致
