# T103：JSON 输出协议——单文档 + 统一退出码

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P0 |
| 状态 | todo |
| 依赖 | T101（fail 异常化保证 flush）、T102（outcome 映射） |
| 验证 | 自动 + 管道实机 |

## 问题

1. **stdout 输出多个 JSON 文档**：`inspect --hi`（index.ts:384-388 先 `printJson(d)`，394/398 再 `printJson({...d, hiResult})`）和 `talent-detail --hi`（index.ts:425-429、435）同样。stdout 变成两个拼在一起的 JSON，`JSON.parse(stdout)` 必然失败——直接破坏 AGENTS.md「`--json` 可被 LLM 解析」的契约。
2. **JSON 模式失败不非零退出**：
   - `recommend --greet`（index.ts:283-289）：JSON 分支打印 `hiResult` 后直接 return，`failed`/`unknown` 退出 0（文本模式会 fail）；
   - `inspect --hi`（index.ts:397-403）：同上；
   - `talent-detail --hi`（index.ts:434-443）：同上（`failed` 时 JSON 模式退出 0）。
   同一失败在两种模式下退出码不同，编排层按模式二选一解析时必然漏掉一半失败。

## 修复要求

1. **协议定为：`--json` 模式下，每条命令 stdout 恰好输出一个 JSON 文档**：
   - 成功：结果对象（含 `hiResult` 等）；
   - 失败：`{ ...结果, hiResult, error: '原因摘要' }`，随后 `fail()`（借 T101 的 throw 保证 flush、退出码与 finally 清理）。
2. 改造涉及命令：`inspect`（含 `--hi`）、`talent-detail`（含 `--hi`）、`recommend`（`--inspect` / `--greet` / 列表）、`greet`、`list`、`search`、`positions`。核心改法：命令内**先攒完整结果对象，最后一次输出**；禁止「先 printJson 再 printJson」。
3. `error` 字段内容与 stderr 的 `✖` 消息保持同源（一个变量两处用）。
4. view_limit 熔断路径（index.ts:251-264）已符合「先输出再 fail」，纳入同一结构，补 `error` 字段。
5. 在 `utils/output.ts` 的 `printJson` 注释中写明协议约定（完整文档化放 T403）。

## 验收标准

- [ ] `51job inspect <姓名> --hi --json` 成功时：`node -e "JSON.parse(require('fs').readFileSync(0))"` 通过，输出仅一个文档，含 `hiResult`
- [ ] 失败时：stdout 仍可解析（含 `error`），退出码 1
- [ ] `recommend <岗位> --greet <姓名> --json` 失败时退出 1 且 stdout 可解析
- [ ] `talent-detail <姓名> --hi --json` 失败时退出 1 且 stdout 可解析
- [ ] 纯读命令（list/search/positions/recommend 列表）行为不回归

## 注意事项

- 本任务改输出结构，任何依赖「两次 printJson」顺序的下游（若有）需同步——当前仓库内无此依赖。
- stderr 诊断信息（`⚠` 警告）保持不变，协议只约束 stdout。
