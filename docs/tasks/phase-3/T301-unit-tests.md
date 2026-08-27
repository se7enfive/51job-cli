# T301：Vitest 单元测试基线

| 字段 | 值 |
|---|---|
| 阶段 | Phase 3 — 质量门禁与可靠性加固 |
| 优先级 | P1 |
| 状态 | done（2026-08-27） |
| 依赖 | T102/T103/T105 完成后补「映射/协议」类用例；纯逻辑用例可随时先行 |
| 验证 | 自动 |

## 问题

仓库零自动化测试：无 test 框架、无 `npm test`、CI 无测试门禁。大量**纯逻辑**（不依赖浏览器、可直接断言）完全裸奔，回归只能靠人工实机。

## 修复要求

1. 引入 `vitest`（devDependency）；`package.json` 增加：
   - `"test": "vitest run"`
   - `"typecheck": "tsc --noEmit"`
   - （可选 `"test:watch": "vitest"`）
2. 新建 `test/` 目录（tsconfig 若需单独配置，加 `tsconfig.test.json` 或把 test 纳入 include 但排除出 build 产物路径——**build 产物不得包含 test**，保持 `tsconfig.json` include 为 `src/**`，vitest 自带 TS 转换无需预编译）。
3. 首批用例范围（全部纯逻辑，不起浏览器）：

   | 模块 | 用例点 |
   |---|---|
   | `core/throttle.ts` | `parseThrottleEnv`：默认值、单值、`800,2000`、现状下 `800-2000` 的实际行为（断言现状，T402 修文档/解析后再改断言）；`createThrottle` 的 min/max 边界（mock 随机或大样本断言范围） |
   | `core/pageGuards.ts` | `isRiskNavigationUrl` 各关键词命中/不命中；`classifyPausedRequest` 三分类；`parsePatternList` 默认值与环境变量覆盖 |
   | `core/guard.ts` | `RISK_URL_PATTERNS`/`RISK_TEXT_PATTERNS` 的正则单测（导出后测，若未导出则补导出） |
   | `pages/hi-result.ts` | `stillInitial` 混合文案判定（T106 的目标限定逻辑一并覆盖） |
   | `utils/output.ts` | `displayWidth`（中文/全角）、`padDisplay`、`printTable` 截断 |
   | `pages/inbox.ts` | T105 抽取的过滤+编号函数：投递卡/非投递卡/未读混合输入 |
   | 退出码映射（T102/T103） | outcome→exit 码映射表驱动用例（若映射抽成纯函数，直接测；否则测 `hiOutcomeTag` + 集成层留实机） |
   | `ocr/baidu_ocr.ts` | key 解析优先级（T401 改造后）；token 缓存过期逻辑（mock fetch） |
   | `core/sessionLock.ts` | meta 构造脱敏（T204）：不含参数值 |

4. CI 接入归 T302；本任务保证 `npm test` 本地全绿。
5. 测试风格从简：Node 内置 `node:test` 若团队更倾向零依赖也可替代 vitest——二选一后统一，**不引入两套**。

## 验收标准

- [ ] `npm test` 全绿；`npm run typecheck` 通过
- [ ] 上表所列模块每个至少 1 个直接用例
- [ ] `npm run build` 产物（dist/）不含 test 文件
- [ ] CI 集成准备就绪（T302 直接引用 `npm test`）

## 实施记录（2026-08-27）

- vitest ^4.1.11（devDep）；`npm test` = `vitest run`，`npm run typecheck` = `tsc --noEmit`；测试在 `test/*.test.ts`（不进 build 产物，tsconfig include 保持 `src/**`）。
- 为可测性导出：`parsePatternList`/`classifyPausedRequest`（pageGuards）、`stillInitial`（hi-result）、`displayWidth`/`truncateDisplay`（output）、`sanitizedCommand`（sessionLock，加 argv 注入参数）。
- 首批 6 个文件 51 用例：throttle（含 `800-2000` 现状断言）、pageGuards（URL 判定/三分类/pattern 解析）、output（宽度/截断/表格对齐）、hi-result（stillInitial）、sessionLock（脱敏）、resume-ocr（opt-in 矩阵）。
- **测试立即抓到两个真实缺陷并修复**：
  1. `stillInitial` 朴素 includes——「已Hi聊」「已沟通」等成功后文案包含短词「Hi聊」「沟通」，会把成功态误判为初始态（Hi 成功永远检测不出）；改为前缀正则 + 精确短词匹配；
  2. `RISK_NAVIGATION_RE` 路径分隔符缺 `-`/`_`——`security-check` 类风控路径漏拦。
- 51/51 通过；build + typecheck 干净。

## 注意事项

- 涉及 `process.env` 的用例注意保存/还原环境变量（vitest `beforeEach/afterEach` 或 `vi.stubEnv`）。
- 不追求覆盖率数字，优先覆盖「审查中实际出过 bug 的逻辑」。
