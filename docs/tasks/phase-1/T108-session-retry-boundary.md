# T108：会话重试边界——写操作不自动重跑

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P0 |
| 状态 | todo |
| 依赖 | 无 |
| 验证 | 自动（代码走查）+ 单元可注入 |

## 问题

`src/core/sessionPage.ts:200-237`：`withSessionPage` 捕获 `Execution context was destroyed` 类错误后，**重跑整个 callback**（223 行 `return await callback(page)` 在重试 try 内）。当 callback 已执行了对外写操作、只是后续校验因页面跳转抛错时，重跑 = 重复操作：

- `send`：`sendMessage` 第一次点击可能已实际发出，页面跳转后抛 context destroyed → 重跑再发一遍 → **同一消息发两次**；
- `greet`：重复消耗 Hi 点数；
- `action`：不可逆按钮（标记不合适/接受/拒绝）被点击两次。

与 `sendMessage` 内部的补发逻辑（chat.ts:258-285，`inputCleared` 失败 → 再点一次/再按 Enter）叠加，形成双重重发路径。

## 修复要求

1. **拆分 setup 与 callback 的重试边界**：仅对进入 callback 之前的阶段（`ensureBrowser` / 选页 / `bringToFront` / 守卫安装 / `ensureEhireUrl` / 熔断检查）的 context-destroyed 错误做重试；`callback(page)` 抛出的错误**不再重试**，直接进入现有 catch 处理（风控检查后 throw）。
2. 实现上把 callback 调用移出重试循环，或用 `options.retryCallback = false`（默认）显式控制；确有重试需求的纯读命令可显式开启并注明理由。
3. `sendMessage` 补发逻辑加防重发护栏：
   - 补发前先读消息列表/最后一条消息文本，确认首击确实未出现在会话记录中才补发；
   - 补发最多 1 次（现状最多 2 次补发，收敛）；
   - 无法确认时**不补发**，warn「消息可能已发出，请人工确认」并返回 false（宁失败不重复）。
4. `AGENTS.md` 幂等性说明的更新归 T403。

## 验收标准

- [ ] 代码走查：写路径（send/greet/action/preview）的 callback 在任何错误下只执行一次
- [ ] 读路径命令（list/search/positions/recommend 列表）的开局阶段重试行为保留
- [ ] `sendMessage` 补发前有消息记录校验；无法确认时补发被跳过且有 warn
- [ ] `npm run build` 通过；既有命令行为不回归（list 全链路实机 🧪 抽查）

## 注意事项

- context-destroyed 也可能发生在「发送点击前」的输入阶段（合法重试场景）——第 1 点拆的是「callback 整体」，`sendMessage` 内部对输入阶段的局部重试可以保留，但要受第 3 点护栏约束。
- 风控熔断优先级不变：callback 抛错后的 `assertNoPageRisk` 检查（sessionPage.ts:227-229）必须保留。
