# T303：smoke 冒烟测试隔离化

| 字段 | 值 |
|---|---|
| 阶段 | Phase 3 — 质量门禁与可靠性加固 |
| 优先级 | P2 |
| 状态 | todo |
| 依赖 | 无（T203 若改 store.ts，注意冲突组 G6） |
| 验证 | 实机（本机 Chrome 环境） |

## 问题

1. **未 build 直接挂**：`package.json:23` 的 smoke 直接 `node scripts/smoke-*.cjs`，两脚本 `require('../dist/...')`，而 dist 被 gitignore——全新 clone 上 `npm run smoke` 必失败。
2. **污染真实环境**（smoke-guards.cjs:15-17, 77-84）：
   - `ensureBrowser()` 读写真实 `~/.51job-cli/.cache/state.json`，可能复用用户正在用的有头 Chrome；
   - 未设 headless → 开发机上弹可见 Chrome 窗口并导航到 ehire；
   - 结束只 `browser.disconnect()`，**不关浏览器进程**，残留 Chrome + state.json 指向它，干扰后续真实命令。
3. smoke-guards 的真实导航检查失败也判 pass（74 行附近），检查偏弱。

## 修复要求

1. `package.json`：`"smoke": "npm run build && node scripts/smoke-puppeteer.cjs && node scripts/smoke-guards.cjs"`。
2. **环境隔离钩子**（小量代码改动，归本任务）：
   - `utils/store.ts` / `core/state.ts` 支持 `51JOB_STATE_FILE`（覆盖 state.json 路径）与 `51JOB_USER_DATA_DIR`（覆盖默认 profile 目录）环境变量；
   - 两个 smoke 脚本开头设置：临时目录（`os.tmpdir()` + 随机子目录）+ `51JOB_BROWSER_HEADLESS=true`（smoke 场景允许无头，与 AGENTS「业务禁无头」不冲突，脚本注释说明）；
   - smoke-guards 结束调用 `shutdownBrowser()` 清理进程与临时 state，并删除临时目录。
3. smoke-guards 的真实导航断言：失败时明确标注「网络受限跳过」并输出到摘要，不再静默计 pass（保持不阻塞 CI，但报告可见）。
4. README 补一句「smoke 需本机 Chrome，会启动无头实例」（细节归 T403）。

## 验收标准

- [ ] 全新 clone：`npm install && npm run smoke` 一次通过
- [ ] 运行前后真实 `~/.51job-cli/` 无任何变化（state.json mtime/内容不变）
- [ ] 运行结束后无残留 Chrome 进程（任务管理器/`tasklist` 确认）
- [ ] 本机无 Chrome 时（可用改 CHROME_PATH 指向不存在路径模拟）smoke 明确报错而非挂起

## 注意事项

- 无头冒烟只是**连通性检查**，不代表业务可用性（业务禁无头）——README/AGENTS 保持这一区分，避免误导。
- 临时目录清理失败不应导致 smoke 报红（best-effort + warn）。
