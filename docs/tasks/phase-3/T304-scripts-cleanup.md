# T304：脚本归档与死代码清理

| 字段 | 值 |
|---|---|
| 阶段 | Phase 3 — 质量门禁与可靠性加固 |
| 优先级 | P2 |
| 状态 | todo |
| 依赖 | 无（建议在 T301-T307 之后做，避免清到将被启用的代码） |
| 验证 | 自动 |

## 问题

1. `scripts/diag-recommend.ts` 是全仓唯一 `.ts` 脚本，但 `tsconfig.json:17` 只 include `src/**` → 永不会被 build，其注释却写 `node dist/diag-recommend.js`（必然找不到文件），且从未被类型检查。
2. 16 个一次性 `scripts/diag-*.cjs` 与 2 个 smoke 混在一层，噪音大。
3. `scripts/fix-node-modules.js/.sh` 自述「已废弃、不再需要 puppeteer-core」——与现状相反，误导删除依赖。
4. 死代码（grep 确认无引用）：
   - `browser.ts:26` `isEhireLoginUrl`、`login.ts:84` `doLogin`
   - `sessionPage.ts:101` `getPageRef`、`:118` `findPageByUrl`、`:237` 循环后必不到的 `throw lastErr`
   - `baidu_ocr.ts:26` `clearBaiduTokenCache`
   - `guard.ts:87-116` `RiskCircuitBreaker`（且计数逻辑本身有 bug：非风险页也累计 hits）
   - `human_delay.ts` `selectAllModifierKey`、`typeTextWithRandomKeyDelay` 等未接线导出
   - `recommend.ts:183` `replace(/\|/g, '|')` 无操作；`talent-insight.ts:137-144` `rowH` 计算后未用

## 修复要求

1. **diag-recommend.ts**：迁入 `src/`（调整 import 相对路径，纳入 build 与类型检查），注释运行方式改为 `node dist/diag-recommend.js`；或直接删除（若其功能已被 probe/正式命令覆盖——实施时判断，判断结果记入实施记录）。
2. `scripts/` 整理：
   ```
   scripts/
   ├── smoke-puppeteer.cjs
   ├── smoke-guards.cjs
   └── diag/          # 一次性诊断脚本归档，README 一句话说明「历史探查脚本，非运行必需」
   ```
3. 删除 `fix-node-modules.js` / `fix-node-modules.sh`。
4. 删除上述死代码（逐项 grep 二次确认无引用后删）；`RiskCircuitBreaker` 直接删（pageGuards 已有熔断体系，不修不留）。
5. 清理 `recommend.ts:183` 无操作 replace、`talent-insight.ts` 未用 `rowH`（保留行为等价的最小代码）。

## 验收标准

- [ ] `npm run build` 通过；`npx tsc --noEmit` 无新增报错
- [ ] `npm run smoke` 通过（需 T303 的 build 前置，至少本地手动 build 后验证）
- [ ] 全仓 grep 不再出现已删符号
- [ ] `git grep -n "RiskCircuitBreaker\|fix-node-modules"` 为空

## 注意事项

- 删除前逐个符号 grep（含 `.cjs` 脚本、skills/ 目录的引用）——诊断脚本可能 require dist 里的这些导出。
- 死代码清单以实施当日 `git grep` 复核为准，本文件清单是 2026-08-27 快照。
