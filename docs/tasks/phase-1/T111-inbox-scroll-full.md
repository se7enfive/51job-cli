# T111：投递列表滚动加载全量（T105 补全）

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约（T105 后续实测补全） |
| 优先级 | P0 |
| 状态 | done（2026-08-28） |
| 依赖 | T105（序号空间契约） |
| 验证 | 真机 list --json 全量 31 条 + 61 测试全绿 |

## 问题（实测发现）

`list --json` 只返回投递箱**首屏已渲染**的候选人卡片（实测 10 条），但投递箱实际共 31 位。

根因：投递箱是**内部容器无限滚动 / 懒加载**模式——页面 body 不滚动（`scrollHeight === innerHeight`，`scrollY=0`），真正滚动区是 `.resume-list`（`overflowY:auto`，实测 `scrollHeight 4557 > clientHeight 505`）。候选卡靠「滚动到底」逐步追加渲染。原 `collectCards` 仅 `page.$$(itemSel)` 一次性取 DOM 已存在的卡片，未滚动容器，故漏掉未渲染的后续卡片。

## 验证证据（只读探针）

- 页面层：`scrollBodyH=889`, `winH=889`, `scrollY=0` → body 不滚动，列表在内部容器
- 容器层：`.resume-list` `scrollHeight 4557 / clientHeight 505 / overflowY:auto` → 唯一可滚动容器
- 无分页器（`pagination` 选择器命中为空）→ 非翻页分页，是无尽滚动

## 修复

`src/pages/inbox.ts` `collectCards`：在 `waitForListSettled` 稳定轮询后加入 `scrollListToBottom` 滚屏收敛——

- 定位 `.resume-list` 容器，反复 `scrollTop = scrollHeight`（到底），等新卡渲染后数卡片数；
- 连续 `SCROLL_STABLE_ROUNDS=2` 次滚到底无新增 → 收敛（全量加载完）；
- 上限守卫：`SCROLL_MAX_STEPS=60` 轮 / `SCROLL_MAX_MS=60s`，防止异常页面死循环；
- 滚屏沉降复用 `LIST_POLL_MS`（420~780ms 随机），保持既有人类行为节奏。

**不排序不改序**：滚动是追加式加载，卡片保持自然 DOM 顺序 → T105 的 list 序号与 chat `--index` 契约天然保持一致（同一实现、同一顺序），仅让 `#` 1..N 覆盖到完整列表。

## 实施记录（2026-08-28）

- `collectCards` 增加滚屏加载；探明 `.resume-list` 为滚动容器（selectors.inbox 已有该 `list` 选择器，原未用于滚动）。
- 三机复测：`list --json` 由 10 条 → **31 条**（含 INDEX 1–31，序号连续、1–10 与修复前一致），61 项单元测试全绿。

## 验收

- [x] `list --json` 返回投递箱全量（31 条，非首屏 10）
- [x] 序号连续 1-based，且首 10 条顺序与修复前完全一致（未打乱）
- [x] 无死循环（收敛守卫）；`--unread` / `chat --index` 复用相同 collectCards 即全量生效
- [x] `npm test` 61/61 通过、build/typecheck 干净

## 边界

- 若某投递箱是极端长列表（>60 轮仍未收敛），`SCROLL_MAX_STEPS` 会停止，返回已加载部分——可接受，防御异常页面。
- 滚动只发生在 `.resume-list`；若未来 51job 改版把滚动容器换成别的类，需按新 DOM 校准 `SCROLL_CONTAINER_SEL`（可先用 `51job probe` 复查）。