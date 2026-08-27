# T204：会话锁不再记录完整命令行

| 字段 | 值 |
|---|---|
| 阶段 | Phase 2 — 安全与隐私 |
| 优先级 | P1 |
| 状态 | done（2026-08-27） |
| 依赖 | 无 |
| 验证 | 自动 |

## 问题

`src/core/sessionLock.ts:25`：

```ts
command: process.argv.join(' ').trim(),
```

完整命令行（含参数值）写入 `~/.51job-cli/.cache/session.lock`：

- `51job send --text "<包含候选人隐私的消息>"` → 消息全文落盘；
- 进程被杀/崩溃时锁文件残留，内容长期留存；
- 并发命令等待超时时，`formatSessionLockOwner`（85-98）把 `cmd=...` 打进 stderr（139-146），内容进入编排层日志。

## 修复要求

1. `buildSessionLockMeta` 的 `command` 字段只保留**脱敏摘要**：
   - 形如 `basename(argv[1]) + ' ' + 子命令名`（如 `index.js send`）；
   - 丢弃所有选项与参数值；
   - 子命令识别：`argv[2]` 若不含 `-` 前缀则视为子命令名。
2. `formatSessionLockOwner` 输出随之只含 pid/host/age/脱敏 command。
3. 字段仍保留 `cwd`（定位用）——cwd 本身不算高敏，保留现状。
4. 类型 `SessionLockMeta` 注释注明「不含参数值，避免消息内容落盘」。

## 验收标准

- [ ] `51job send --text "秘密消息内容"` 执行期间检查 session.lock：文件中不含消息内容
- [ ] 人为制造锁等待超时（并发两条命令）→ stderr 错误信息中不含消息内容
- [ ] 锁的 stale 清理、30s 超时、EEXIST 重试逻辑行为不变（现有流程回归）

## 实施记录（2026-08-27）

- `buildSessionLockMeta.command` 改为 `sanitizedCommand()`：`basename(argv[1]) + 子命令名`（argv[2] 非 `-` 开头时），丢弃全部选项与参数值；类型注释写明「消息内容不落盘」。
- `formatSessionLockOwner` 无需改动——输出的是脱敏后的 command 字段，超时错误信息随之干净。
- 已验证（等价逻辑 4 组用例）：`send --text 秘密` → `index.js send`；`greet 张三 --job 测绘` → `index.js greet`；无子命令/仅有 flag → `index.js`；均不泄露参数值。
- 锁获取/stale 清理/30s 超时/EEXIST 重试机制零改动。

## 注意事项

- 本任务纯属脱敏，不改变锁的获取/释放机制。
- 排障信息损失（看不到完整命令）可接受：超时提示已含 pid/age/cwd，足够定位持有者。
