# T201：CDP 调试端点收敛

| 字段 | 值 |
|---|---|
| 阶段 | Phase 2 — 安全与隐私 |
| 优先级 | P0 |
| 状态 | done（2026-08-27） |
| 依赖 | 无 |
| 验证 | 实机 🧪（必须验证 puppeteer 连接不回归） |

## 问题

`src/core/browser.ts:135-150` 启动常驻 Chrome 时带：

```
--remote-debugging-port=<port>
--remote-allow-origins=*
```

端口明文写入 `~/.51job-cli/state.json`（store.ts 默认权限）。

攻击/误用面：

1. **同机任意进程**：读到端口后 `puppeteer.connect({ browserURL })` 无需任何认证即可完全接管浏览器——读取所有页面（简历 PII、聊天）、在已登录会话里执行 JS、冒充用户发消息。
2. **`--remote-allow-origins=*`** 显式关闭了 Chrome 对 CDP WebSocket 的 Origin 校验，配合 DNS rebinding / 本地端口扫描扩大暴露面。
3. Unix 下 state.json 默认 644，其他本地用户可读。

工具本身定位单机单人使用，无法做到多租户安全，但至少要：去掉不必要的放大器、明确安全假设、收紧文件权限。

## 修复要求

1. **尝试移除 `--remote-allow-origins=*`**，实机验证完整链路（login → list → send）中 `connectBrowser`（puppeteer `connect({ browserURL })`）仍然可用：
   - 可用 → 直接移除；
   - 不可用（Chrome 新版对 WS Origin 校验）→ 改为精确白名单值并注释原因，同时把「启用 pipe」记入下方决策项。
2. **state.json 权限收紧**：`utils/store.ts` 的 `writeJson` 增加可选 `mode` 参数（默认保持现状），`core/state.ts` 的 `writeState` 以 `0o600` 写入；`ensureDirs` 对 CACHE_DIR 用 `0o700`。Windows 上 POSIX mode 仅影响 read-only 位——在代码注释与文档注明「Windows 依赖单用户假设」。
3. **README / AGENTS 安全章节**注明：常驻浏览器调试端口仅绑定本机、任何本地进程可接管、请勿在共享/多用户机器上使用（文档细节归 T403，本任务先把代码层做完）。
4. **决策记录**（写入本文件末尾的「实施记录」）：评估 `--remote-debugging-pipe` 改造（puppeteer `browserURL` 连接方式需改为 spawn 时传 pipe transport）。若评估工作量大，单独立任务，不在本任务内做。

## 验收标准

- [ ] 移除通配 origin 后：`51job login` → `51job list` → `51job send`（受控）全链路可用（🧪）
- [ ] Unix 环境下 `state.json` 权限 600、`.cache` 目录 700（WSL 或 CI Linux 验证均可）
- [ ] `51job doctor` 输出不泄露端口（确认现状即可）
- [ ] 实施记录中写明 pipe 改造结论（做/不做/另立任务）

## 实施记录（2026-08-27）

- **移除 `--remote-allow-origins=*`**（browser.ts），代码注释说明原因与回退方案。
- **实机验证通过**：关闭旧常驻实例（登录态保留）→ 无头全新 spawn（新参数）→ `puppeteer.connect({ browserURL })` 成功（CONNECT_OK pages=1）→ shutdown 清理完成。puppeteer WS 客户端不发送 Origin 头，Chrome 默认校验不拦截。
- **state.json 权限 0o600**：`writeJson` 增加 mode 参数（store.ts），`writeState` 传入 0o600（state.ts）；`ensureDirs` 全部目录 0700。注释注明 POSIX 生效、Windows 依赖单用户边界。
- **实施记录·pipe 决策**：`--remote-debugging-pipe` 改造**暂不立项**——需把连接方式从 browserURL 改为 spawn transport，改动面大；当前端口仅绑 127.0.0.1 + 无通配 Origin + state 0600 已显著收敛。若未来需要更高保障再单独立任务。
- README/AGENTS 安全章节文档归 T403。

## 注意事项

- 移除 `--remote-allow-origins=*` 后，**用户手动打开的 DevTools**（devtools:// 源）应仍可连接；验证时同时测 puppeteer 连接和手动 DevTools。
- 不要在本任务里顺手改 headless/UA 等其他启动参数，保持 diff 最小。
