# T110：输入防护杂项（未命中 / 空关键词 / 0 falsy）

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P1 |
| 状态 | todo |
| 依赖 | T105（chat 的 0 falsy 已在该任务修，本任务扫全仓余量） |
| 验证 | 自动 |

## 问题

一组「静默错误成功」的边界输入：

1. **`inspect` 未命中姓名静默退出 0**：`src/index.ts:371-374`，`warn(...)` 后 `return` → 退出 0 + 空 stdout，编排层误判成功但拿不到数据。
2. **`greet` 空姓名 + 空 `--job` → 空关键词搜索**：`pages/search.ts:609` `ensureSearchPool(page, opts.job || name, ...)`，两者皆空时提交空串搜索，返回不可控结果池，再按 `--by-index` 定位 → 可能对错误候选人打招呼。
3. **`opts.index ? ...` 的 0 falsy 模式**：除 index.ts:161（T105 修）外，全仓排查同类写法（如 greet 的 `--by-index`、inspect 的 `--index`），`--index 0` 被吞后静默回退姓名匹配。
4. （低，顺手项）`printTable` 列宽上限 60 直接截断导致表格错位（output.ts:48），可加省略号。

## 修复要求

1. `inspect` 未命中 → `fail('未在搜索结果中定位到「姓名」…')`，退出 1（与 `recommend --inspect` 未定位时的 fail 对齐）。
2. `greetTalent` 入口校验：`!name && !opts.job && opts.index === undefined` → 直接失败「需要姓名、--job 或 --by-index 之一」；`opts.index` 存在但页面无既有结果池时也应失败，不做空关键词兜底搜索（`ensureSearchPool` 关键词为空串时拒绝执行）。
3. 全仓 `grep -n "opts\.\(index\|byIndex\) ?"` 排查，统一改为 `!== undefined` + `parseInt` + `Number.isFinite` 校验（非法值报错而非 NaN 传播）。
4. `printTable` 截断单元格尾部加 `…`（保证列宽仍 ≤60）。

## 验收标准

- [ ] `51job inspect 不存在的人` → 退出 1，stderr 明确原因
- [ ] `51job greet --by-index 1`（无姓名无 --job、页面无结果池）→ 退出 1，不发起空搜索
- [ ] `--index 0` / `--by-index 0` / 非数字 → 明确报错，不静默回退
- [ ] 含超长字段的表格输出列不再错位

## 注意事项

- `--index 0` 的正确语义：本工具序号 1-based，0 应报错并提示范围，而不是当作「未提供」。
- 空关键词拒绝要放在 `ensureSearchPool` 内部（防御所有调用方），不只靠 greet 入口校验。
