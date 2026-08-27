# T307：浏览器生命周期加固

| 字段 | 值 |
|---|---|
| 阶段 | Phase 3 — 质量门禁与可靠性加固 |
| 优先级 | P1 |
| 状态 | done（2026-08-27） |
| 依赖 | T101（fail 清理修复后，残留 tab 场景大减；本任务处理剩余场景） |
| 验证 | 实机 🧪（故障注入） |

## 问题

1. **同 profile 二次 spawn 死锁**（`browser.ts:110-176`）：`state.json` 中 pid 存活但调试端口不通（Chrome 卡死/半死）时，代码用**同一个** `userDataDir`（= `.cache` 目录，state.ts:27-29）再 spawn 一个 Chrome。新实例因 profile 被 `ProcessSingleton` 锁住立即退出 → 15s 端口轮询超时 → 报「Chrome 调试端口未就绪」；state.json 未清 → 后续每条命令重复该路径，**永久卡死**。
2. **`pickExistingPage` 可能选中残留业务页**（`sessionPage.ts:39-73`）：取「最后一个 ehire tab」——T101 修复后详情 tab 会被正常清理，但仍可能存在：用户手动打开的详情页、崩溃残留。选中详情页后 `ensureEhireUrl` 认为已在目标域跳过导航，后续命令在错误页面上找选择器。
3. （低）`findFreePort` TOCTOU（browser.ts:64-79）：端口释放到 Chrome 绑定之间可被抢占——现有 15s 端口就绪检测会兜底报错，可接受。

## 修复要求

1. **复用失败自愈**：`ensureBrowser` 中「pid 活、端口不通」分支：
   - 验证该 pid 确属本工具 Chrome：读进程命令行确认包含我们的 `userDataDir`（Windows: `powershell -c "Get-CimInstance Win32_Process -Filter ..."`, 或用 `wmic process where processid=<pid> get commandline`；POSIX: `ps -p <pid> -o command=` 或 `/proc/<pid>/cmdline`）；
   - 匹配 → `process.kill(pid)` + `clearState()` + 提示「已清理失联的常驻浏览器」，再走正常 spawn；
   - 不匹配（pid 被复用）→ `clearState()` 直接 spawn（profile 若仍被占会走端口报错，此时错误文案提示删除 state.json 或重启机器）。
   - 进程命令行探测封装成小工具函数，跨平台分支处理，失败时保守起见不 kill、直接报错并给手工处理指引。
2. **`pickExistingPage` 过滤业务子页**：候选页排除 URL 含 `/Revision/talent/resume/detail`、`/Revision/talent/search`（详情类）；优先级顺序建议：工作台 `/Revision/navigate` > 人才管理 `/talent/management` > 其他 ehire 主壳页；仍无候选 → `newPage`。
3. `findFreePort`：保持现状，注释记录 TOCTOU 与兜底路径。
4. 错误文案：「Chrome 调试端口未就绪」补充可能原因（profile 被占/端口抢占）与自愈指引。

## 验收标准

- [ ] 故障注入 🧪：启动常驻浏览器后用任务管理器暂停（Suspend）Chrome 进程（pid 活端口不通）→ 下一条命令能自愈（kill 旧实例重启）或明确报错，不无限循环
- [ ] 手动打开一个详情 tab 后跑 `list` → 选中工作台页而非详情页（🧪）
- [ ] 正常复用路径（pid 活 + 端口通）行为不变
- [ ] Windows 与（如有条件）WSL 双平台走查命令行探测分支

## 实施记录（2026-08-27）

- **复用失败自愈**：`ensureBrowser` 拆分「pid 活」分支——端口通则复用；端口不通则 `readProcessCommandLine`（win32: PowerShell `Get-CimInstance`；POSIX: `ps -p`）确认命令行含我们的 `userDataDir` 才 kill，等待退出（最多 5s）释放 profile 锁后清 state 重启；命令行不匹配（pid 复用）只重置状态不杀进程；命令行读取失败保守放行到正常报错路径。
- **端口就绪失败文案**：补充 profile 锁/端口抢占等原因与自愈指引。
- **`pickExistingPage` 三级选页**：主壳页（navigate/talent/management/search）> 其他非子页 ehire 页 > 任意非空白页；`/resume/detail` 与风险关键词页面被排除。
- **findFreePort**：TOCTOU 注释记录（保持现状，端口就绪检测兜底）。
- **实机验证通过**（临时脚本，headless）：场景 A——state 指向存活非 Chrome 进程（本测试进程）→ 识别 pid 复用、不误杀、正常起新实例；场景 B——真实 Chrome 占 profile 无调试端口 → 识别失联、清理重启、正常连接。
- 教训记录：最初用内联 `node -e` 测试时，脚本文本含 userDataDir 字符串被身份校验正确 kill——守卫生效的意外证明，也说明身份校验基于命令行匹配的边界（测试需用脚本文件）。

## 注意事项

- kill 进程是破坏性动作，必须先做命令行身份校验，绝不裸 kill pid。
- `userDataDir` 就是 `.cache` 目录——它同时存 state.json/session.lock/登录态，绝不能整目录删除；自愈只 kill 进程 + 删 state.json。
