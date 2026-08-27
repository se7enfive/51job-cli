# T305：availability 网络失败缓存修复

| 字段 | 值 |
|---|---|
| 阶段 | Phase 3 — 质量门禁与可靠性加固 |
| 优先级 | P1 |
| 状态 | done（2026-08-27） |
| 依赖 | 无 |
| 验证 | 自动 + 弱网实机 🧪 |

## 问题

`src/core/availability.ts:295-329` `assertJobCliAvailable` 的 `finally` 块**无论何种异常**都写 `ok: false` 缓存（TTL 6h）：

1. **瞬时网络故障被缓存为 6h 禁用**：断网 / DNS 失败 / 代理超时 / 站点短暂 5xx → `assertOnlineFrontendMatchesBaseline` 抛非 `JobAvailabilityError` → `reasons` 为空仍写 `ok:false` → 之后 6h 所有业务命令退出 2，报「缓存的上次校验未通过」（无原因）。一次断网让 CLI 哑半天。
2. **错误消息双重包装**：缓存的是 `e.message.split('\n')`（314 行，已是 `formatDisabledMessage` 的产物），下次读取再过一遍 `formatDisabledMessage`（301 行）→ 嵌套冗余消息。
3. **无总超时预算**：入口页 + 登录页 + 6 个钉哈希脚本逐个 `AbortSignal.timeout(45s)`，最坏连续约 6 分钟才报错——编排层的子进程超时（如 60s）会提前杀掉命令，连禁用原因都拿不到。
4. 校验在会话锁之外，多命令并发时各自重复校验（缓存写竞态 last-writer-wins）——可接受，但记录之。

## 修复要求

1. **失败分类缓存**：
   - `JobAvailabilityError`（基线确不一致）→ 维持现状：缓存 `ok:false` 6h；
   - 其他异常（网络类）→ **不写禁用缓存**，`warn('可用性校验未完成（疑似网络问题），本次跳过校验继续执行')` 后放行；可选：写一个短 TTL（如 2 分钟）的「校验未完成」记录避免弱网下每条命令都全量重试——二选一，倾向放行 + 短 TTL 提示缓存。
2. **缓存结构改为存原始 reasons 数组**：`assertOnlineFrontendMatchesBaseline` 抛错时携带结构化 reasons（改 `JobAvailabilityError` 为 `constructor(message, public readonly reasons: string[])` 或新增字段），缓存存 reasons；读取时才 `formatDisabledMessage`。消除双包装。
3. **总超时预算**：校验整体套 `AbortController` / `Promise.race`，总预算 30s（env `51JOB_AVAILABILITY_TIMEOUT_MS` 可配）；超时按「网络类」处理（不写禁用缓存）。
4. 保留 `51JOB_AVAILABILITY_REFRESH=1` 强刷语义。

## 验收标准

- [ ] 模拟断网（关代理/飞行模式）：命令 warn 后继续执行或快速失败，**且 6h 内后续命令不被禁用**（🧪）
- [ ] 模拟基线不一致（临时改本地 GUARDED_SCRIPT_HASHES 中的一个哈希）→ 仍禁用、缓存 6h、消息清晰不重复包装
- [ ] 弱网模拟下校验总耗时 ≤ 30s
- [ ] 正常网络下校验结果与缓存命中行为不变

## 实施记录（2026-08-27）

- **失败分类**：`JobAvailabilityError` 携带结构化 `reasons`（两处抛出点传入），仅基线不一致写 6h 禁用缓存；网络类/超时异常 → warn 放行 + 短 TTL（2 分钟）`pending` 标记缓存，不再「一次断网哑 6h」。
- **双重包装消除**：缓存存原始 reasons，读取时才 `formatDisabledMessage`。
- **总超时预算**：`Promise.race` 整体 30s（`51JOB_AVAILABILITY_TIMEOUT_MS` 可配），timer 已 unref。
- **派生发现并修复**：`ensureBrowser` spawn 的 Chrome 子进程以 ref 状态持有 CLI 事件循环——命令完成后进程挂起不退出（无超时预算问题时也存在，此前被 fail 的 process.exit 掩盖）。加 `child.unref()` 修复：CLI 自然退出，Chrome 继续常驻。
- **实测验证**：`51JOB_AVAILABILITY_TIMEOUT_MS=1` 模拟故障 → warn 放行 + exit 0 + 进程正常退出；pending 缓存 `{ok:false, pending:true}` 写入；2 分钟内第二命令 1ms 快速跳过。
- 派生发现已记录：可用性校验超时后其内部 fetch 仍在后台跑到各自 45s 超时——只影响进程尾部滞留（有界），不影响命令执行，接受。
- 真实断网（关代理/飞行模式）复测归实机批次。

## 注意事项

- 「网络失败放行」是有意放宽：基线守护的目的是防**页面改版误操作**，网络问题不属于该风险；放行后若页面真改版，具体命令会在选择器层失败——可接受的权衡，写进代码注释。
- 改造后同步更新 `docs/CAPABILITIES.md` 中对 availability 的描述（归 T403）。
