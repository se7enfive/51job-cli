# T112：positions --candidates 按职位拉取候选人/投递列表

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性（实测缺口补全） |
| 优先级 | P1 |
| 状态 | done（2026-08-28） |
| 依赖 | T111（滚动加载）、T105（序号契约）、T306（新 tab 捕获） |
| 验证 | 真机投递分支 + 搜索分支 + 66 测试全绿 |

## 问题

用户需要「查看某个职位的投递候选人列表」，但现有命令无此能力：

- `list` = 工作台**全局投递聚合流**（不分职位）
- `positions` = 岗位**目录**（含待处理数，但只作文本）
- **没有「职位 → 该职位投递候选人」的命令**

实测（真机只读探测）确认 DOS（页面行为）：

1. 职位卡**有投递人**时 `.job_card_num`（待处理数）存在且可点击 → 点击**新开 tab** 到 `/Revision/talent/management`（人才管理页，已按该职位过滤投递候选人）。
2. 职位卡**无投递人**时无 `.job_card_num`，但有 `.job_to_talent_content`（「去人才」按钮）→ 点击**新开 tab** 到 `/Revision/talent/search?jobid=…`（人才搜索页），**自动预填职位名 + 期望工作地并触发搜索**。

## 语义澄清（写入文档）

- **有投递职位分支** = 该职位收到的**候选人投递**（人才管理列表，投递语义）
- **无投递职位分支** = **主动搜该职位匹配人才**（人才搜索，搜索语义），因该职位无投递流
- 文档提示避免把「搜索匹配」误当「投递」

## 修复

新增 `positions --candidates <职位名>`：

- 复用 `readPositions` 前期导航定位职位卡；按卡上 `.job_card_num` 存在与否分叉入口
- 有投递 → 点 `.card_num`，捕获新 tab（复用 T306 的 `beforePages`+轮询 `browser.pages()` 模式）
  - 人才管理页：**滚动 `.main_container` 到底触发懒加载全量**（T111 同法），再逐行解析（`parseMgmtRow`）
  - `source='delivery'`
- 无投递 → 点 `.job_to_talent_content`，捕获搜索 tab → 复用 `readSearchResults` 读匹配
  - `source='search'`
- 统一输出 `{ position, source, portal, count, candidates[] }`，`--json` 结构化；非 JSON 表格
- 关闭新 tab 保持原 `positions` 上下文

`src/pages/selectors.ts` job 组新增 `jobToTalent: '.job_to_talent_content'`；`src/pages/job.ts` 新增 `readPositionCandidates` + 可测纯函数 `parseMgmtRow`；`src/index.ts` `positions` 命令加 `--candidates <选型>` 并分派。

## 实施记录（2026-08-28）

- 探测确认两种入口元素与落地 tab URL、人才管理页滚动容器 `.main_container`、行文本画像结构
- 真机复测：`positions --candidates "三维扫描工程师" --json` → `source:'delivery'` + 9 位带画像；`--candidates "市政造价员" --json` → `source:'search'` + 30 位匹配
- 城市解析锚定到经历时间戳前，杜绝「回复/继续聊」等操作词误报
- 新增 `test/job.test.ts`（5 用例覆盖解析），66/66 测试全绿

## 验收

- [x] `positions --candidates <有投递职位> --json` → `source='delivery'` + 候选人列表（含画像）
- [x] `positions --candidates <无投递职位> --json` → `source='search'` + 匹配人才（自动预填+搜）
- [x] 非 JSON 表格展示 `# / 姓名 / 画像 / 摘要`
- [x] 新 tab 自动关闭、原 `positions` 上下文不残留
- [x] 全程 build/typecheck/66 测试全绿

## 边界

- 人才管理/搜索行结构随 51job 改版而变，解析失败会留空字段但不丢候选人
- 「无投递」职位的搜索分支本质是匹配搜索，结果规模通常更大且带薪期望等，非投递清单，使用需留意