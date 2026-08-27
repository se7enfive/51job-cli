# T104：`wait-login` 超时退出码与参数校验

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P0 |
| 状态 | done（2026-08-27） |
| 依赖 | T101 |
| 验证 | 自动 + 实机 🧪（未登录态易构造） |

## 问题

1. `src/index.ts:124-127`：`await waitForLogin(page, {...})` 的返回值被丢弃。`pages/login.ts:57-78` 超时时返回 `{ ok: false }`，命令仍退出 0 → 编排层把「登录超时」当成功，后续命令在未登录态空跑。
2. `--timeout` 无校验：`parseInt(opts.timeout, 10)` 得到 `NaN` 时 `while (Date.now() - start < NaN)` 恒假 → **立即超时返回**；`0`、负数同理。`--timeout abc` 用户得到的是「看起来跑完了」的假成功。

## 修复要求

1. `index.ts` wait-login action：

   ```ts
   const sec = parseInt(opts.timeout, 10);
   if (!Number.isFinite(sec) || sec <= 0) {
     fail(`--timeout 需为正整数秒，收到: "${opts.timeout}"（示例: 51job wait-login --timeout 300）`);
   }
   const r = await waitForLogin(page, { timeoutSec: sec });
   if (!r.ok) fail(`等待登录超时（${sec}s）。请完成扫码/验证后重试，或直接运行业务命令检测登录态。`);
   ```

2. 顺带检查 `pages/login.ts` 的 `waitForLogin`：确认轮询对「已登录」判定不会因 `loginSuccess.dashboard` 宽泛选择器提前误判（该问题记录在审查 L7，若改动选择器超出本任务范围，在任务备注记录、留 T106/T403 联动）。
3. 可选增强（不强制）：给 wait-login 增加 `--json`，输出 `{ ok, waitedSec }`，失败时同样走 T103 协议。

## 验收标准

- [ ] 未登录 + 短超时（`--timeout 5`）→ 等满 5s 后退出非 0，stderr 有超时原因（🧪）
- [ ] 登录状态下 `wait-login` → 立即返回退出 0（🧪）
- [ ] `--timeout abc` / `--timeout 0` / `--timeout -1` → 立即报错退出非 0，不进入轮询
- [ ] 不带 `--timeout` → 默认 300s 行为不变

## 实施记录（2026-08-27）

- `wait-login` action：`--timeout` 先经 `Number.isFinite && > 0` 校验（放在 `runCommand` 之前，非法值不启动浏览器/可用性校验）；`waitForLogin` 返回 `ok:false` 时 `fail()` 非零退出。
- `login.ts` 的超时 `err()` 移除（信息与命令层 fail 消息重复），超时只通过返回值 `ok:false` 表达；`err` import 一并清理。
- 已验证：`--timeout abc/0/-1/""` 均立即报错退出 1，不进入轮询。
- 待实机回归：未登录 + 短超时 → 等满后非零退出（归实机批次，不影响账号）。
- 备注：`isLoggedIn` 的宽泛 dashboard 选择器误判风险记录在审查 L7，归 T403/后续任务，不在本任务范围。

## 注意事项

- 测试「登录成功退出 0」需要真实扫码，安排在实机批次；未登录态测试不影响账号。
- 超时文案要引导下一步动作（重新 wait-login 或直接跑业务命令），方便 Agent 自愈。
