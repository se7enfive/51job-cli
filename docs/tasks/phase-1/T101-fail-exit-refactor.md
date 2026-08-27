# T101：`fail()` 异常化退出（基础机制）

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P0 |
| 状态 | done（2026-08-27） |
| 依赖 | 无（建议最先实施，后续任务基于新机制） |
| 验证 | 自动 + 管道场景实机 |

## 问题

`src/utils/output.ts:74-77`：

```ts
export function fail(msg: string): never {
  err('✖ ' + msg);
  process.exit(1);
}
```

`process.exit` 直接终止进程，造成四个后果：

1. **跳过清理**：`runCommand` 的 `finally { await detachBrowserSession() }`（index.ts:92-96）与 `withSessionLock` 的 `finally { rm(lock) }`（sessionLock.ts:126-130）都不执行 → 详情 tab 残留、会话锁残留。
2. **stdout 截断**：stdout 为管道（Agent 编排场景）时缓冲可能未 flush，`printJson` 后紧跟 `fail` 的调用点会丢失/截断 JSON。
3. **可用性禁用路径同样直退**：`src/index.ts:88` 对 `JobAvailabilityError` 用 `process.exit(2)`，同样跳过清理。
4. 残留的详情 tab 会让下一条命令的 `pickExistingPage` 选中错误页面（见 T307）。

## 修复要求

1. 新增可识别的致命错误类型（放 `utils/output.ts` 或新建 `utils/errors.ts`）：

   ```ts
   export class FatalCliError extends Error {
     constructor(message: string, public readonly exitCode: number = 1) { super(message); }
   }
   ```

2. `fail(msg, exitCode = 1)` 改为：`err('✖ ' + msg)` 后 `throw new FatalCliError(msg, exitCode)`。
3. `src/index.ts` 顶层（`program.parseAsync()` 之后）统一捕获：

   ```ts
   program.parseAsync(process.argv).catch((e) => {
     if (e instanceof FatalCliError) {
       process.exitCode = e.exitCode;   // 不用 process.exit，让 stdout 自然排空
     } else {
       err(`✖ 未处理异常: ${e instanceof Error ? e.stack || e.message : String(e)}`);
       process.exitCode = 1;
     }
   });
   ```

4. `index.ts:83-91` 的可用性分支改为 `fail(e.message, 2)`，删除直接 `process.exit(2)`。
5. 全仓检查 `fail()` 调用点：`fail` 返回类型仍声明 `never`，调用后不应有依赖继续执行的代码（TS 会兜底检查）。
6. 确认 `withSessionPage` / `withSessionLock` 的 `finally` 在 throw 传播路径上正常执行（现有结构已支持，验证即可）。

## 验收标准

- [ ] 构造 `printJson(...)` 后 `fail(...)` 的路径（如 `inspect --hi --json` 失败），stdout 经管道可完整解析且退出码为 1
- [ ] 任意 `fail` 退出后 `~/.51job-cli/.cache/session.lock` 不残留
- [ ] 任意 `fail` 退出后业务打开的详情 tab 被关闭（`detachBrowserSession` 生效）
- [ ] 可用性校验失败退出码仍为 2，且同样走清理
- [ ] `npm run build` 通过

## 实施记录（2026-08-27）

- `FatalCliError` 落在 `utils/output.ts`（与 `fail` 同文件，避免循环依赖）。
- `fail` 签名扩展为 `fail(msg, exitCode = 1)`，仍声明 `never`——全部既有调用点零改动，编译通过。
- 顶层收口：`program.parseAsync().catch` 对 `FatalCliError` 只置 `process.exitCode`；其他异常打印后置 1。**不再调用 `process.exit`**。
- 可用性禁用路径改为 `fail(e.message, 2)`，退出码语义保留。
- 无参帮助路径 `process.exit(0)` 同步改为 `process.exitCode = 0`（管道下帮助文本不再截断）。
- 已验证：`51job send`（缺 --text）→ stderr `✖` + 退出 1 + stdout 0 字节；无参帮助正常；`npm run build` 通过。
- 待实机回归（归 INDEX 全局验收）：fail 发生在 `withSessionPage` 内部时 session.lock 无残留、extra tab 被关闭。

## 注意事项

- 不要把 `process.exitCode` 误写成在异步回调里赋值后又被后续代码覆盖；顶层 catch 是唯一出口。
- commander 自身的 `--help` / `--version` / 参数错误路径不受影响（commander 自己调用 `process.exit`，可接受）。
- 本任务只改机制，不改任何业务判定逻辑（那些是 T102–T110）。
