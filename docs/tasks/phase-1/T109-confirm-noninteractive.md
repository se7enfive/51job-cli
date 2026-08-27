# T109：非交互确认安全（stdin EOF 不挂起）

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P1 |
| 状态 | done（2026-08-27） |
| 依赖 | 无 |
| 验证 | 自动 + 管道实机 |

## 问题

`src/utils/confirm.ts:9-25`：只调用了 `rl.question(...)`，未监听 `close`、无超时。当编排层以子进程运行 `51job greet ...`（未传 `--no-confirm`）或 `51job action unsuitable` 且 stdin 是已关闭的管道时，readline 只触发 `close` 不触发 question 回调 → **Promise 永不 resolve，命令永久挂起**。编排层只能靠外部超时杀死，且可能误判为成功/失败。

调用点：`chat.ts:327-329`（action 不可逆操作）、`search.ts:640-642`（greet 决策确认）。

## 修复要求

1. `confirmAction` 补充 EOF/非交互处理：
   - 监听 `rl.on('close')`：用户未作答流已关闭 → `resolve(false)` 并 `warn('stdin 已关闭，未获得确认，默认拒绝')`；
   - 检测 `process.stdin.isTTY === false`（或 `!isTTY`）时直接走拒绝路径（跳过创建 readline，避免无谓等待），文案同上并提示可用 `--no-confirm` 显式放行。
2. **EOF 默认拒绝而非默认同意**：不可逆操作（action）与真实 Hi（greet）在无人工输入时拒绝是安全侧；编排层确需自动化的场景已有 `--no-confirm` 显式通道（greet）——`chatAction` 目前无 `--no-confirm`，检查 `index.ts` action 命令是否需要补该选项（补充则属于本任务范围）。
3. 可选：增加确认超时（默认关闭或 300s，`51JOB_CONFIRM_TIMEOUT_MS` 可配），超时按拒绝处理。
4. 两个调用点确认拒绝路径的返回语义正确（`confirmAction` 返回 false → greet 返回 `cancelled` / action 返回 false），不产生部分执行。

## 验收标准

- [ ] `echo -n "" | 51job action unsuitable`（或 stdin 重定向空输入）→ 立即拒绝退出，不挂起
- [ ] `51job greet X`（未传 --no-confirm，stdin 关闭）→ 立即拒绝，退出码非 0 或明确「已跳过」，不挂起
- [ ] 交互 TTY 下 Y/n 行为与之前完全一致
- [ ] `--no-confirm` 路径不经过 confirmAction，行为不变

## 实施记录（2026-08-27）

- `confirmAction` 重写三层防护：
  1. **非 TTY 立即拒绝**（不创建 readline）+ warn 提示用 `--no-confirm`；
  2. **EOF（stdin 关闭）拒绝**：`rl.on('close')` → settle(false)，`settled` 标志防双 settle；
  3. **超时拒绝**：默认 300s，`51JOB_CONFIRM_TIMEOUT_MS` 可配（<=0 关闭）；timer `unref()` 不阻塞进程。
- action 命令已有 `--no-confirm` 选项（index.ts:185），greet 亦然——任务第 2 点核查通过，无需补。
- 已验证：管道环境（本会话 shell）确认 4ms 内返回 false；强制 TTY + 销毁 stdin（EOF）返回 false 不挂起。
- `defaultYes` 语义仅在 TTY 有输入时生效——「EOF 默认同意」不存在，不可逆操作无人工输入即拒绝。
- 「非交互必须 --no-confirm」的文档化归 T403。

## 注意事项

- 「默认拒绝」会让不知情的编排脚本从「挂起」变成「失败」——这是期望行为（fail fast），但要在 T403 文档中明确写「非交互环境必须传 --no-confirm」。
- 不把「EOF 默认同意」做成可配置项——降低误配置把不可逆操作自动化放行的风险。
