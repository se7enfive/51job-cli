# T302：CI 门禁与发布流程修复

| 字段 | 值 |
|---|---|
| 阶段 | Phase 3 — 质量门禁与可靠性加固 |
| 优先级 | P1 |
| 状态 | todo |
| 依赖 | T301（npm test 存在） |
| 验证 | 推送后看 GitHub Actions 实际运行 |

## 问题

1. **发布 Workflow 双触发**（`.github/workflows/tag-publish.yml:3-9, 88-97`）：`on` 同时监听 `push: tags: v*` 和 `release: published`；而 tag push 运行末尾 `gh release create` 又会触发 `release` 事件 → 第二次运行重复 `npm version` + `npm publish` → 版本冲突报错。**每次发版必然留下一个红叉**。
2. **无 PR/推送门禁**：没有任何 workflow 跑 typecheck/test，回归只能靠人工。
3. `permissions` 里 `id-token: write`（16-18 行）未使用（发布走 `NPM_TOKEN`，无 `--provenance`）——凭据面无谓扩大。
4. `workflow_dispatch` 的 `version` 输入未做 semver 校验，误输入会导致发布中途失败。
5. 本地 `npm publish` 无 `prepublishOnly` 门禁，可能发布缺失/陈旧 dist。

## 修复要求

1. **tag-publish.yml**：
   - 删除 `release: types: [published]` 触发（保留 tag push + workflow_dispatch 两条发布路径）；
   - 删除 `id-token: write`（若未来要 provenance 再加回并配套 `--provenance`）；
   - workflow_dispatch 的 version 输入加 semver 校验（不匹配则 fail with 提示）；
   - publish 步骤前增加 `npm run typecheck && npm test`（有 NPM_TOKEN 才跑的既有 gate 保持）。
2. **新增 ci.yml**：`on: push`（main）+ `pull_request`；步骤：checkout → setup-node 22 → `npm ci` → `npm run typecheck` → `npm run build` → `npm test`。
3. **package.json**：增加 `"prepublishOnly": "npm run build && npm run typecheck && npm test"`（本地手发也有门禁；CI 路径会因此重复跑一次 test，可接受，或在 CI 用 `npm publish --ignore-scripts` 规避——二选一并注释）。
4. GitHub Release 创建步骤保留在 tag push 路径。

## 验收标准

- [ ] 推送一个测试 tag → 只有**一次**发布运行，且为绿（用 patch 版本验证后删除）
- [ ] 开 PR / 推 main → ci.yml 跑 typecheck+build+test
- [ ] workflow_dispatch 传非法 version → 快速失败并有明确提示
- [ ] 无 `NPM_TOKEN` secret 的 fork 环境流程不红（现有 npm_gate 保持）

## 注意事项

- 删除 `release` 触发后，已存在的 Release 不会重复触发任何东西；历史红叉运行无需清理。
- 若 CI 中 `npm ci` 因 lockfile 指向 npmmirror 源在美国 runner 上偶发失败，lockfile 官方源重生成归 T404，本任务先观察。
