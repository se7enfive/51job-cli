# T404：仓库卫生（LICENSE / lockfile / main / CHANGELOG）

| 字段 | 值 |
|---|---|
| 阶段 | Phase 4 — 文档与配置对齐 |
| 优先级 | P2 |
| 状态 | todo |
| 依赖 | 无（随时可做） |
| 验证 | 自动（npm pack / npm ci） |

## 问题

1. **LICENSE 不完整**：`LICENSE` 仅 20 行引言，非完整 GPL-3.0 文本——`package.json:5` 声明 GPL-3.0 但包内无有效许可证文本，合规风险。
2. **lockfile 指向 npmmirror**：`package-lock.json` 的 `resolved` 全部为 `registry.npmmirror.com`——GitHub Actions（海外 runner）`npm ci` 依赖第三方镜像可达性，偶发拉包失败。
3. **`main: dist/index.js` 无意义且有害**（package.json:9）：纯 CLI 包被 `require('51job-cli')` 时会直接 `program.outputHelp()` + `process.exit(0)`（index.ts 顶层执行），程序化使用行为怪异。
4. 无 CHANGELOG：0.1.x 起的修复（尤其 T205 等行为变更）无迁移记录载体。

## 修复要求

1. `LICENSE` 替换为 GPL-3.0 完整官方文本（https://www.gnu.org/licenses/gpl-3.0.txt）。
2. `package-lock.json` 基于官方源重生成：临时 `npm install --registry=https://registry.npmmirror.com=false` 不行——正确做法：删除 lockfile 后 `npm install --registry=https://registry.npmjs.org` 重新生成，diff 确认仅 resolved/URL 变化、版本树不变。
3. 移除 `package.json` 的 `main` 字段（bin 已足够）；确认 `files` 列表：`dist` + `AGENTS.md` + `README.md`（保持；如 T402 后希望 npm 用户拿到 env 模板，可加 `.env.example`——可选）。
4. 新建 `CHANGELOG.md`（Keep a Changelog 格式），起始条目 `0.1.1 (Unreleased)`，汇总 Phase 1-4 已完成任务的**行为变更**（重点：项目级 .env 显式开关、OCR opt-in、`--no-confirm` 语义、环境变量更名迁移、JSON 单文档协议）。
5. `npm pack` 产物走查：内容 = dist + 两份 md（+ 可选 .env.example），无多余文件。

## 验收标准

- [ ] LICENSE 为完整 GPL-3.0 文本
- [ ] `npm ci` 在干净环境 + 官方源成功；lockfile diff 仅 registry URL 变化
- [ ] `require('51job-cli')` 不再执行 CLI（无 main 或 main 指向无害入口）
- [ ] `npm pack --dry-run` 内容清单符合预期
- [ ] CHANGELOG 记录截至当前所有已完成任务的行为变更

## 注意事项

- lockfile 重生成必须在依赖版本完全一致的前提下做（只换 registry，不升级）；生成后跑 `npm run build && npm test` 确认。
- 移除 `main` 前确认无文档/脚本引用 `require('51job-cli')`（grep 全仓 + README）。
