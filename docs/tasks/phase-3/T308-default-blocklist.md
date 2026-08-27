# T308：默认拦截规则收敛

| 字段 | 值 |
|---|---|
| 阶段 | Phase 3 — 质量门禁与可靠性加固 |
| 优先级 | P2 |
| 状态 | done（2026-08-27，实机业务抽查待批次） |
| 依赖 | 无（与 T306 同改 pageGuards.ts，注意冲突组 G8） |
| 验证 | 实机 🧪（业务功能抽查） |

## 问题

`src/core/pageGuards.ts:61-65`：

```ts
const REPORT_KEYWORDS = ['dap', 'collect', 'tracker', 'monitor'] as const;
// 默认 pattern: *51job.com/*dap* 等
```

默认对 51job 域内路径含 `collect` / `monitor` / `dap` / `tracker` 的请求 204 吞掉。这些是**未经验证的猜测关键词**（文件头注释自述「51job 未做过前端逆向」）：若站点有合法业务接口路径含这些词（如收藏 `/collect`、报表 `/monitor`），会被静默吞掉——按钮点了没反应、数据不加载，而 CLI 侧毫无感知（只在页面 console 留一条日志）。对自动化工具而言，「操作没生效但不报错」是最危险的故障形态。

## 修复要求

1. **默认不拦截任何上报请求**：`REPORT_KEYWORDS` 默认值改为空（对齐 `BLOCKED_SECURITY_SCRIPT_PATTERNS` 的「默认不拦、env 显式启用」策略）；
2. 保留 `51JOB_BLOCK_REPORT_PATTERNS` 显式启用通道（机制不变），`.env.example` 注释更新为「默认关闭；probe 校准确认埋点路径后配置」（T402 承接）；
3. 拦截关闭期间，对**命中候选关键词但未配置拦截**的请求打一条 page console 日志（便于 probe 校准时发现真实埋点路径）——即「观察模式」：默认只记录不拦截；
4. `classifyPausedRequest` / `REPORT_REQUEST_RE` 随空默认值的行为核对（无 pattern 时不应产生任何 paused 拦截）。

## 验收标准

- [ ] 默认配置下 `list` / `send` / `greet`（受控）全链路正常，无请求被 204（🧪）
- [ ] 配置 `51JOB_BLOCK_REPORT_PATTERNS` 后拦截行为与之前一致
- [ ] 观察模式日志只进页面 console，不污染 CLI stdout/stderr
- [ ] `isRiskNavigationUrl` / 风险导航拦截行为不变（本任务不碰 RISK 关键词）

## 实施记录（2026-08-27）

- `REPORT_KEYWORDS` → `REPORT_CANDIDATE_KEYWORDS`：默认**不拦截**，作为观察 pattern（`REPORT_OBSERVE_PATTERNS`）加入 `Fetch.enable`——命中请求记页面 console 后 `continueRequest` 放行；`51JOB_BLOCK_REPORT_PATTERNS` 显式配置后才走 204（`REPORT_REQUEST_PATTERNS` 默认空，与安全脚本拦截同一策略）。
- handler 分流：`report` 类请求按「是否配置了拦截 pattern」决定 204 或放行。
- `.env.example` 注释同步（默认观察、probe 校准后再启用拦截）。
- `skills/`、`scripts/` grep 确认无引用旧行为。
- `npm run build` 通过；默认配置下 list/send 无请求被吞的实机抽查归实机批次。
- 跟进项（实施记录）：probe 确认真实埋点路径后，把精确 pattern 写回默认值。

## 注意事项

- 反检测强度会略降（埋点可能上报自动化痕迹）——这是「不确定的防护」换「确定的可用性」的取舍；若后续 probe 确认了真实埋点路径，把精确 pattern 写回默认值即可（在实施记录里跟进）。
- 默认值变更要同步 `skills/51job-frontend-analysis` 的说明（若其中引用了默认拦截行为，实施时 grep 确认）。
