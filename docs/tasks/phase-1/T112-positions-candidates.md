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

### 视图范围（scope）补强（2026-08-28）

实测发现职位管理页有两个 tab：**「我的职位」**（本账号发布，如三维扫描工程师）与**「组织下职位」**（组织全部，~10 个）。原 `positions` 只取「页面当前视图」——若页面残留停在某 tab，结果随页面漂移不可复现。

补强：`positions --scope <my|org>` 主动点击对应 tab（`ensureJobScope` 按文本精确匹配叶子节点）后再收集，结果可复现；`readPositions` / `readPositionCandidates` 均透传 scope；未指定则保持当前视图（向后兼容）；非法 scope fail。

真机验证：`--scope org` 稳定 10 个、`--scope my` 稳定 1 个；`--candidates "三维扫描工程师" --scope org` 在组织视图正确拉取（`source=delivery, count=9`，不再依赖残留）；`--scope foo` 报 `--scope 只能为 my 或 org`。

## 实施记录（2026-08-28）

- 探测确认两种入口元素与落地 tab URL、人才管理页滚动容器 `.main_container`、行文本画像结构
- 真机复测：`positions --candidates "三维扫描工程师" --json` → `source:'delivery'` + 9 位带画像；`--candidates "市政造价员" --json` → `source:'search'` + 30 位匹配
- 城市解析锚定到经历时间戳前，杜绝「回复/继续聊」等操作词误报
- 新增 `test/job.test.ts`（5 用例覆盖解析），66/66 测试全绿
- scope 补强：真机验证 my/org 两种视图可复现（10 vs 1）+ `--candidates` 在 org 视图定位成功 + 非法 scope 拦截

### 全量候选人采集加固（2026-08-28 实机回访）

真机发现原实现**只采到当前页（约 10 条）**，而「三维扫描工程师」实际有 **33 位投递**（动态增长）。根因：
- 人才管理页是**分页列表**（底部 .eh-pagination，每页约 10 人），原 `collectMgmtRows` 只滚动当前页；
- **快速/一次性跳底会触发懒加载竞态 → 空白卡片**；进页面立即开滚也拿不全。

加固方案（用户实机建议 + 探测确认）：
1. **进页面先随机停 3~6s**，等首屏懒加载稳定；
2. 把底部**每页条数切到 50**（`el-select` 下拉 → 「50条/页」），单页最大化、**减少翻页**（即使>50 也仅少量翻页）；
3. **缓慢渐进滚动**：每步小段增量（600px）+ 每步 pause 等渲染，杜绝一次性跳底空白卡；
4. 滚动到底且读数稳定后再**兜底翻页**（数量可能 >50）。

另加固**新 tab 捕获**：原按「URL 含 `/Revision/talent/`」轮询，会漏掉点击瞬间 `about:blank` 空 URL 帧导致偶发 15s 超时。改为**先按「新出现的 page 对象身份」判新，拿到对象后再 `waitForFunction` 等 URL 落到人才页**，稳定捕获。

真机验证：`--candidates "三维扫描工程师" --scope org --json` → `source='delivery'` + **count=33**（全量）；`--candidates "资深土建造价工程师/经理" --json` → `source='delivery'` + count=10。连续多跑稳定。

### `--source <auto|delivery|search>`：投递不足时去人才池搜索扩充（2026-08-28）

**问题**：投递「少但 >0」的职位（如销售主管=1 投递）原实现硬编码走 delivery，只拿 1 个投递人，无法去人才池补充匹配人才。

**方案**（grilling 决策后实施）：
- `--source search`：**强制走人才池搜索**。直接 goto 搜索页 + 职位名作关键词，并把职位卡 `detail`（`城市 | 学历 | 年限 | 薪资`）经纯函数 `detailToSearchFilters` 自动注入 `SearchFilters`：
  - 城市`湛江-霞山区`→去区级取市级→`city`
  - 学历`本科`→**向上取扩大**`本科及以上`→`edu`（用户确认「学历向上取扩大合适」）
  - 年限`3年及以上`与页面枚举槽不符、薪资`7-12万/年`按年≠页面按月档位 → **都不转跳过**
  - 不能稳定 1:1 转的字段一律跳过
- `--source delivery`：强制只读投递；无投递入口时 warn + 返回 null
- `--source auto`（缺省）：按有无投递自动分派，**行为与改前完全一致**
- 非法 `--source` → `fail`（exit 1）

**真机验证**：
- `positions --candidates "销售主管" --source search --json` → `source='search'` + **count=30**（远多于 1 投递，自动注入「居住地=广东省,湛江、学历≥本科」）
- `positions --candidates "销售主管" --json`（无 --source）→ `source='delivery'` + count=1（同一人，向后兼容 ✅）
- `positions --candidates "三维扫描工程师" --source search` → `source='search'`（有投递也强制搜索，覆盖生效）
- `positions --candidates "三维扫描工程师" --source delivery` → `source='delivery'` + count=34（动态增长）
- `--source foo` → `--source 只能为 auto/delivery/search` exit 1
- 新增 `detailToSearchFilters` 6 单测（城市去区级、学历上取、中技/中专跳过、年薪/年限不转、空 detail、缺学历段），72/72 全绿

### 城市筛选修复：期望工作地禁用误判 → 级联选择器直选（2026-08-28 实测回访）

**用户实测发现**：销售主管搜索结果**没有湛江人**（30 人全是韶关/广州/惠州等异地）——搜索没带上城市条件。

**第一版根因判断（误）**：探测到「期望工作地」input 是 `readonly/disabled`，判定为「站点禁用」→ 改用居住地级联（residence）。虽能收敛（居住地=湛江），但语义是「现居所」而非「期望工作地」，且依赖市→省映射表。

**用户纠正（正确）**：期望工作地在页面**可点可选**。重新探测确认：
- input readonly/disabled 只是**防手打**，点击容器（`.talent_search_address`）会弹出**级联选择器**（`.eh_cascader_dialog`：热门城市/省级列表 → 市级）；
- 之前误判是因为最初探测用了 DOM `.click()`（8 次探测脚本全用的 evaluate click 不触发 Vue 绑定），而真正生效需要真实交互路径——用户动手点过才知道真相。

**最终修复**：
- `applySearchFilters` city 分支：从 `fillInputByPlaceholder`（直填被 readonly 挡）改为 **`pickCityByCascader`**：点容器 → 级联弹窗逐级选（省→市）→ 确定；幂等（input 已回显目标市则跳过）。
- `detailToSearchFilters` 城市段输出 `city: '省,市'`（带省名，级联需省→市两级；`CITY_TO_PROVINCE` 映射补全）。
- 删除死代码 `fillInputByPlaceholder` / `isInputDisabled`（T304）。
- `core/browser.ts` protocolTimeout 30s → 90s（SPA 级联渲染长任务让 evaluate 排队，30s 偶发误杀）。

**真机验证**：`--source search 销售主管` 注入「期望工作地=广东省,湛江」，结果 30 人全为省内（湛江霞山/赤坎/麻章/吴川 + 广州/深圳少数），首条「邓仁乾 广州-番禺区」；幂等第二次跳过。73/73 测试全绿。

### 【严重问题】搜索范围残留：当前选中职位 tag 未切换（2026-08-28 用户实测揪出）

**用户发现**：搜索框旁边可选择职位，但没选「销售主管」，而是残留「市政造价员」→ 搜索结果被**锁死在上一次职务的人才池**，这是「销售主管搜出一堆造价/预结算背景」的真正根因（此前城市筛选修复仅缓解表面现象）。

**探测确认**：搜索页头部有「当前选中职位」tag（`.cur_selected_job_tag`，内含 `.cur_selected_job_tag_jobname`）。goto 搜索页后**残留上次职位的选中态**（`.job-item.active`，如市政造价员）。点击 tag 弹出职位下拉 `.talent_search_select_job_dropdown`（分组：搜索词匹配职位/我的职位/组织下职位，项 `.job-item` 内 `.job-item-name`）。**DOM `.click()` 不触发 Vue → 探测必须真实鼠标点击**；下拉会随关键词输入刷新「搜索词匹配职位」分组。

**修复**：`searchTalents` 填入关键词后（等匹配组刷新）调新 helper `selectJobForKeyword`：
1. tag 已等于关键词 → 幂等跳过；
2. 否则真实鼠标点 tag → 在下拉找 `.job-item-name` 文本 == 关键词的项点击；
3. 找不到匹配职位项（人名/技能词搜索）→ warn 但**不阻断**（保留当前范围）。

**真机验证**：先制造残留（tag=市政造价员）→ `searchTalents('销售主管')` → 日志「搜索范围已切换至职位『销售主管』」→ tag 更新，结果首条变「吴先生 湛江 · 销售主管 · 客户经理/主管」（此前全是造价背景）。73/73 测试全绿。

### 搜索结果首屏限制与 resumeId 直链（2026-08-28 实测边界）

**实测发现**（Hi 银先生过程中）：
1. 搜索结果接口返回 `total: 2289`（销售主管×湛江×本科 全量），但 DOM 是**虚拟滚动**——只保留视口 ~30 张卡，滚动时**复用节点替换内容**（同一 `.item.resume-card` 换姓名/经历），配合分页接口（`talent_hunt_resume_list`，page_index/page_size=50）。「先滚到底再读 DOM」只会拿到底部 30 人，前面的人全丢。
2. 人才搜索关键词**不按姓名匹配**（搜「银先生」返回无关结果）；`locateCandidate`/`greet` 按姓名定位只对**当前已渲染的 30 条**有效。搜索排序随活跃度**动态变化**——同一条件两次搜索的 30 人集合可能不同（银先生曾在前 30，后滑出）。
3. **resumeId 直链有效**（推荐路径）：`talent/resume/detail?resumeId=<id>`（带 jobId/recommendJobId/fromModule）可直接打开任意候选人详情页（含此前 `inspect`/`talent-detail` 抓到的 resumeId），页面上「立即Hi聊」（`.chat_btn`）可用 `hiChatOnDetail` 发 Hi——对「已看过详情、随后滑出首屏」的候选人，这是比滚动找回**更快更稳**的触达路径。

**决策（2026-08-28，用户引导）**：
- `readSearchResults` 默认**只读首屏 ~30 人**（秒级）——形成候选池足够；**不走全量滚动**。
- 新增 `--all` 可选全量滚动收集（边慢滚边读，分钟级），但**⚠️ 滚动采集大量人才档案的行为易触发风控**，参数描述已注明「非必要不使用」，不主动测试。
- **正确定位方式**：候选人的 `resumeId` 是**持久键**——看过的候选人落台账（`~/.51job-cli/ledger/`，0700，含 resumeId/画像/评估），后续任何查看/Hi 走**resumeId 直链**，不依赖搜索排序与虚拟滚动。

### resumeId 直链固化为 CLI 命令能力（2026-08-28）

**需求**（用户指出）：直链此前只存在于临时脚本，Agent 看 `--help` 不知道这条路——必须固化为命令能力并写进说明。

**实现**：`src/pages/candidate-detail.ts` 新增 `resumeDetailUrl(resumeId, jobId?)`（纯函数，3 单测）+ `openDetailByResumeId(browser, resumeId, {jobId, throttle})`（直链打开 → `readCandidateDetail` 提取）。命令接入：
- `inspect <姓名> | --resume-id <id> [--job-id <职位ID>] [--hi]`
- `talent-detail <姓名> | --resume-id <id> [--job-id <职位ID>] [--hi]`
- 直链参数语义（实测）：**只带 resumeId** 即能打开详情（纯查看，无操作按钮）；**带 jobId**（`recommendJobId`/`jobId` 同值 + `fromModule=foundTalentSerachCommon`）才出现「立即Hi聊」（搜索池上下文，耗点数）。`--hi` 未带 `--job-id` 时明确报错提示，不静默失败。

**实测边界**：已 Hi 过的候选人详情页按钮文本变为「继续聊」（非「立即Hi聊」）——`--hi` 仅对未 Hi 候选人有效，编排时注意。

**真机验证**：`inspect --resume-id 404581021 --json` → 莫先生详情（百威/红牛、求职意向）完整提取；`--job-id 162089910` 直链出现操作按钮。83/83 测试全绿。

### search 命令支持职位/城市参数注入（2026-08-28 grilling 决议，实施中）

**需求**（用户）：`positions --source search` 会注入城市、职位下拉自动选中；单命令 `search` 也要能用参数控制——城市和职位不注入时搜索出的候选人基本不匹配。

**grilling 产出的事实修正**：
1. `search --city`（期望工作地）在 3cfab72 已修复（级联选择器直选），「search 不支持城市」是 8f377b4 之前老 bug 的残留印象；
2. 搜索页职位下拉存在**「不限职位」项**（用户确认；既有代码从未使用）——它同时解锁「失败回退落点」与「默认路径清池」两个能力。

**决议（grilling 逐轮确认）**：
- 新增 `search --position <职位名>`：职位名即搜索词，与位置参数 **互斥**（同传 fail）；`--scope <my|org>` 缺省 `my`，决定职位管理页读卡视图。
- **自动注入**：`--position` 时先导航职位管理页定位职位卡，读 detail（`城市 | 学历 | 年限 | 薪资`）→ `detailToSearchFilters` 注入期望工作地/学历（年限薪资不转，沿用既有决议）；零城市参数即可收敛。
- **失败回退**：职位卡未找到 → 切「不限职位」；若未显式 `--city/--residence` → fail（拒绝无收敛裸奔全池）；显式给了城市 → 「不限职位 + 显式城市」继续。
- **优先级**：显式筛选参数（`--city/--residence/--edu…`）**覆盖**注入值。
- **注入断供但池已对**（职位卡读到但城市不在 CITY_TO_PROVINCE 映射）：warn 继续，不 fail。
- **默认路径清池（行为变更）**：无 `--position` 时 `selectJobForKeyword` 匹配不到关键词对应职位 → 切「不限职位」替代原「warn 保留残留」——根治 d6e5a36 只修一半的残留锁池；`--position` 且卡已找到的异常态（下拉同步失败）仍 warn 保留。
- **可观测性**：`search --json` 输出从纯数组**统一对象化**（用户拍板）：`{ keyword, count, hits, [position, positionScope, injected(city/edu), fallback: 'unlimited'|null] }`——与 `positions --candidates` 的 `{position, source, count, candidates}` 同构；AI 编排消费方需从数组改读 `.hits`。
- **不做**：`greet`/`inspect` 保持 `--job`（纯关键词兜底）语义，本轮不动。

**实现拆分**：
- `job.ts`：从 `readPositionCandidates` 抽 `resolvePositionCard(page, name, {throttle, scope}) → detail|null`（导航职位管理页 → 切 scope → 文本匹配职位卡 → 读 bottomInfo），`readPositionCandidates` 与 search 链路共用。
- `search.ts`：抽 helper `readJobTagName/openJobTagDropdown/pickJobDropdownItem/ensureUnlimitedJob`；`selectJobForKeyword` 返回 `'matched'|'unlimited'|'kept'` 并支持 `fallbackToUnlimited`；`searchTalents` 增 `position`/`fallbackToUnlimited` 入参并透传范围结果。
- `index.ts`：search 命令 `--position/--scope` 接线、互斥 fail、注入合并（显式>注入）、`{count, hits, ...}` 对象输出。

## 验收

- [x] `positions --candidates <有投递职位> --json` → `source='delivery'` + 候选人列表（含画像）
- [x] `positions --candidates <无投递职位> --json` → `source='search'` + 匹配人才（自动预填+搜）
- [x] 非 JSON 表格展示 `# / 姓名 / 画像 / 摘要`
- [x] 新 tab 自动关闭、原 `positions` 上下文不残留
- [x] 全程 build/typecheck/66 测试全绿

## 边界

- 人才管理/搜索行结构随 51job 改版而变，解析失败会留空字段但不丢候选人
- 「无投递」职位的搜索分支本质是匹配搜索，结果规模通常更大且带薪期望等，非投递清单，使用需留意