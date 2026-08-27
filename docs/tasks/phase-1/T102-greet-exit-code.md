# T102：`greet` 退出码与结果类型修正

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P0 |
| 状态 | todo |
| 依赖 | T101（fail 异常化） |
| 验证 | 自动 + 实机 🧪 |

## 问题

1. `src/index.ts:319-328`：`greetTalent` 已改为返回 `HiOutcome`（`'success' | 'quota_exhausted' | 'failed' | 'unknown'`，见 `pages/search.ts:591-603`），但入口仍写 `if (!ok) fail(...)`——所有取值都是非空字符串（truthy），**失败判定是死代码**：Hi 失败、额度不足、详情打开失败全部退出 0，上层编排会误判成功。
2. **`unknown` 语义过载**：`search.ts:635-637`（`--dry-run` 结束）和 `search.ts:643-645`（用户在 Y/N 确认时取消）都返回 `'unknown'`，与「Hi 后无成功信号」的 `unknown` 混在一起，调用方无法区分「主动不看/没发」和「发了但没确认」。
3. JSON 模式下 `greet` 只输出详情 JSON（`search.ts:629-633`），没有最终 `hiResult` 字段（协议统一在 T103 处理）。

## 修复要求

1. **扩展结果类型**：`HiOutcome` 增加 `'dry_run' | 'cancelled'`（`pages/hi-result.ts` 同步类型与 `hiOutcomeTag`），或改为返回结果对象 `{ outcome, detail? }`。二选一，推荐扩展联合类型（改动面小）：
   - `--dry-run` 分支返回 `'dry_run'`；
   - 用户确认取消返回 `'cancelled'`。
2. **入口判定**（`index.ts` greetCmd.action）：

   | outcome | 文本模式 | JSON 模式 | 退出码 |
   |---|---|---|---|
   | success | 成功提示 | `{ hiResult: 'success', ... }` | 0 |
   | dry_run | 提示未发出 | `{ hiResult: 'dry_run' }` | 0 |
   | cancelled | 提示已跳过 | `{ hiResult: 'cancelled' }` | 0 |
   | quota_exhausted | fail（保留现有文案） | 输出结果 + fail | 1 |
   | failed / unknown | fail | 输出结果 + fail | 1 |

3. `recommend --greet` / `inspect --hi` / `talent-detail --hi` 的 outcome→退出码映射与本表对齐（JSON 单文档协议由 T103 落地，本任务先保证映射正确）。
4. 同名候选/序号缺失时 `greetTalent` 内部的 `return 'failed'` 路径保持，入口统一处理。

## 验收标准

- [ ] `51job greet 不存在的人 --job x` → 退出 1，stderr 有明确原因
- [ ] 额度不足场景（或 mock）→ 退出 1，输出含 `quota_exhausted`
- [ ] `--dry-run` → 退出 0，输出明确标记「未发出」
- [ ] 确认时答 n → 退出 0，输出「已跳过」，不被误报为成功
- [ ] Hi 成功 → 退出 0（🧪）
- [ ] 四条 Hi 路径（greet / recommend --greet / inspect --hi / talent-detail --hi）退出码行为一致

## 注意事项

- `dry_run` / `cancelled` 是「正常未发出」，绝不能退出非 0，否则编排层会把正常跳过当故障。
- `unknown`（发了但无信号）按失败处理，宁可误报失败也不误报成功。
- 实机验证 Hi 成功路径会真实消耗 Hi 点数，先确认额度再测。
