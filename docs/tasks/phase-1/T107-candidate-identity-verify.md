# T107：详情页身份校验与错位防护

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P0 |
| 状态 | todo |
| 依赖 | 无（T306 会进一步加固捕获机制，本任务先修语义） |
| 验证 | 自动 + 实机 🧪 |

## 问题

**候选人 A 的入口可能产出候选人 B 的详情，且流程继续**，三处叠加：

1. **错位重试耗尽仍返回错误详情**：`pages/talent-insight.ts:423-439`，`openCardDetail` 姓名不一致时递归重试 2 次，`retry >= 2` 后直接 `return { page: detailPage, detail }` —— 调用方拿到的是他人详情，`recommend --inspect` 会输出它、后续 `--hi` 会作用到错误候选人。
2. **`recommend --inspect` 未传 `verifyName`**：`src/index.ts:234-248` 先 `readRecommendResults` 定位序号 `idx`，再 `openCardDetail(bid, page, idx, ...)` 内部重新 `$$` 取卡片——两步之间列表若重排，`idx` 指向他人；而 `openCardDetail` 明明支持 `verifyName` 交叉校验，这里没传。
3. **回退把列表页当详情页**：`pages/candidate-detail.ts:293-307`，`openDetailByIndex` 未捕获新 tab 时 `detailPage = page`（搜索列表页），`readCandidateDetail` 在其上空等 12s 返回 `{}`，命令继续走（`--hi` 在错误页面上找按钮返回 failed）。空详情无任何失败标记。

## 修复要求

1. `openCardDetail`：错位重试耗尽后**不再返回不符详情**——返回 `null`（或 `{ mismatch: true }` 结果对象），调用方 `fail('详情页与目标候选人不一致（姓名 X ≠ Y），已停止，请人工核对')`。
2. `index.ts` recommend `--inspect` 分支：`openCardDetail(..., { verifyName: hits[idx - 1]?.name })`。
3. `openDetailByIndex` 回退分支：未捕获新 tab 时直接 `return null`（不再拿列表页读详情），调用方（`inspect` 命令、`greetTalent` 详情管线）已有 `!opened → fail` 路径，确认提示文案包含「未捕获详情 tab，可能站点未新开页面」。
4. 输出侧兜底：`inspect` / `recommend --inspect` 输出前校验 `detail.name` 存在；为空且无 viewLimited 标记 → 视为失败（防 T306 之前期间的残余路径）。
5. 同步修正 `greetTalent` 详情管线（search.ts:620-648）对 `openDetailByIndex` 返回 null 的处理（已有 `return 'failed'`，确认文案）。

## 验收标准

- [ ] 代码走查：错位耗尽路径不可能再把他人详情交给调用方
- [ ] `recommend --inspect <姓名>` 输出中 `recommendName` 与详情 `name` 一致（实机 🧪 抽查 ≥3 人）
- [ ] 模拟「无新 tab」场景（如临时禁用卡片点击）→ 命令快速失败且报错明确，不再空等 12s
- [ ] `inspect` 输出永不为空对象 `{}` + 退出 0

## 注意事项

- `openCardDetail` 的 `verifyName` 匹配目前是全等比较（trim 后），站点姓名含空格/中点变体时可能误判错位——保持现状，误判的代价是「失败重试」而非「错误操作」，可接受；如实测出现高频误判再放宽为包含匹配。
- 本任务只修判定语义；捕获机制（URL 过滤、timer 清理、同 URL 二次打开）归 T306。
