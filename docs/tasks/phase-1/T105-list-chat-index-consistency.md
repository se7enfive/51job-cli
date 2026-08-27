# T105：`list` / `chat` 序号空间一致性

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P0 |
| 状态 | todo |
| 依赖 | 无 |
| 验证 | 自动（逻辑层）+ 实机 🧪 |

## 问题

**`chat --index N --unread` 可能定位到错误的候选人**，两层错位叠加：

1. **`--unread` 是死选项**：`src/index.ts:154` 声明了 `.option('--unread', '对应 list --unread 的序号')`，但 action（index.ts:156-167）从未把它传给 `openChat`。
2. **序号空间不一致**：
   - `readInbox`（inbox.ts:108-155）先按摘要含「投递了」过滤非投递卡（136 行）、过滤后用 `candidates.length + 1` 重新编号（139 行）、`unreadOnly` 再过滤一次（152-154）；
   - `openChat` 的 index 模式（chat.ts:78-105）直接用 `collectDeliveryCards` 的**全量原始卡片**数组取 `items[opts.index - 1]`——不过滤、不重编号、不考虑未读。

   因此 `list --unread` 输出的第 1 项，在 `chat --index 1 --unread` 中可能对应完全不同的卡片，后续 `send` / `action` 会作用到错误的人。

3. **`--index 0` falsy bug**：`index.ts:161` `opts.index ? parseInt(...) : undefined` —— `--index 0` 被吞掉后静默回退到姓名匹配（姓名为空时进一步退化为报错或全列表首行），同类写法在 T110 全仓排查。

## 修复要求

1. 在 `pages/inbox.ts` 抽取共享收集函数（命名建议 `collectInboxCandidates`）：

   ```ts
   export async function collectInboxCandidates(
     page: Page,
     opts: { unreadOnly?: boolean; throttle?: Throttle }
   ): Promise<Candidate[]>  // 过滤 + 编号逻辑与现 readInbox 完全一致
   ```

   `readInbox` 改为直接调用它。
2. `openChat` 增加 `unreadOnly` 选项：index 模式改为用 `collectInboxCandidates` 的结果取 `candidates[opts.index - 1]`，保证与 `list` 输出**同一数组、同一编号**。
3. `index.ts` chat action 把 `opts.unread` 传入 `openChat`；`opts.index` 判断改为 `opts.index !== undefined`。
4. `chat` 命令帮助文案补充：`--index` 语义 =「`list`（含 `--unread` 时同过滤口径）输出的 `#` 列」。
5. 序号越界、无法解析姓名时保持现有 warn + 返回 false，但补充提示「序号口径与 list 输出一致，请重新运行 list」。

## 验收标准

- [ ] 单元级（T301 落地后补用例）：过滤/编号函数对「投递卡 + 非投递卡 + 未读/已读混合」输入产出与 list 一致的序列
- [ ] 实机 🧪：`list --unread` 记下第 1 项姓名 → `chat <该姓名> --index 1 --unread` 打开的确实是该人（沟通面板 placeholder 校验通过）
- [ ] 实机 🧪：全量 `list` 第 N 项 → `chat --index N`（不带 --unread）定位一致
- [ ] `--index 0` 不再被静默吞掉（明确报「序号从 1 开始」或按语义处理）
- [ ] 纯 `chat <姓名>` 路径行为不回归

## 注意事项

- `readInbox` 的过滤规则（摘要含「投递了」）本身脆弱（站点改文案即全空，审查 L8），本任务**不改变过滤规则**，只统一两条路径共用它；规则健壮化若要做，另立任务。
- `previewResume` 内部也调用 `openChat`（chat.ts:358），签名变更时同步默认参数（不传 unreadOnly 行为不变）。
