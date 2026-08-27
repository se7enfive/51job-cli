# T403：README / CAPABILITIES / AGENTS / RELEASE 同步

| 字段 | 值 |
|---|---|
| 阶段 | Phase 4 — 文档与配置对齐 |
| 优先级 | P2 |
| 状态 | todo |
| 依赖 | T102/T103（退出码协议）、T109（确认语义）、T202/T205（行为变更）、T402（env 清单）、T203（clean 命令） |
| 验证 | 人工对照 `51job --help` 逐条走查 |

## 问题

文档与实现漂移严重，直接误导用户与 AI 编排者：

1. **README**（12-38 行）：只列 5 个命令（实际 18 个，缺 `inspect`/`talent-detail`/`positions`/`jd`/`preview`/`action`/`probe`/`shutdown`/`doctor`/`update` 等）；无前置条件（Node ≥20、本机 Chrome/`CHROME_PATH`）；无环境变量说明；`:10` 提到「定时任务：每日候选人人选自动筛查」但该功能在外层 `recruiting-copilot` 仓库，本仓没有。
2. **CAPABILITIES.md**：`:5,:84` 称 17 个命令，实际 18 个——漏 `talent-detail`；`:55` 引用不存在的 `51JOB_THROTTLE_*`；availability/拦截描述随 T305/T308 需更新。
3. **AGENTS.md**：`RECRUIT_BROWSER_HEADLESS` 命名（T401 修正后需复核）；缺 T103 的 JSON 单文档协议、退出码约定（0 成功 / 1 失败 / 2 可用性禁用）、T109 的「非交互环境必须 `--no-confirm`」、T108 的 send 幂等性说明。
4. **RELEASE.md:5**：声称「当前项目目录不是 git 仓库」——早已初始化。

## 修复要求

1. **README** 重写「使用」节：
   - 前置条件清单（Node 版本、Chrome、可选 CHROME_PATH、百度 OCR 明示 opt-in）；
   - 18 命令全表（一句话 + 常用参数，与 `--help` 文案同源核对）；
   - 典型流水线示例更新（对齐 AGENTS 的 11 步）；
   - 「定时任务」标注归属 `recruiting-copilot/skills/recruit-daily-51job`（或删除该行）；
   - 安全提示节：本地调试端口单用户假设、简历数据 OCR opt-in、PII 本地存储与 `51job clean`。
2. **CAPABILITIES.md**：命令数 17→18、补 `talent-detail` 行；`51JOB_THROTTLE_*` → `51JOB_DELAY`；availability 网络/基线双轨描述（T305）；拦截默认关闭（T308）；clean 命令、退出码协议补入。
3. **AGENTS.md**：
   - 「输出约定」节补 JSON 单文档协议与 `error` 字段；
   - 新增「退出码」小节（0/1/2 语义表）；
   - 「安全红线」补两条：非交互必须 `--no-confirm`；`send` 失败时不要盲目重发（T108 语义）；
   - 环境变量表与 T402 产物对齐。
4. **RELEASE.md**：更新前置状态（git 已初始化、tag 流程以 T302 后的 workflow 为准）。
5. 走查方法：`51job --help` 与各子命令 `--help` 逐条对照 README 表格；每个文档中的环境变量 grep 代码确认存在。

## 验收标准

- [ ] README 命令表与 `--help` 输出逐条一致（18/18）
- [ ] CAPABILITIES 命令数与实际一致，无幽灵环境变量
- [ ] AGENTS 退出码/JSON 协议/确认语义与实现一致
- [ ] 四份文档中环境变量名全部能在代码中找到
- [ ] 无「本仓库不存在」的功能描述（定时任务等已标注归属）

## 注意事项

- 文档命令描述以**代码 `--help` 文案为唯一事实源**；若写文档时发现 help 文案本身错（如 `action` 描述漏 `interviewed/accept/reject`，index.ts:184），顺手修 help 文案并在实施记录注明。
- 本任务完成后，INDEX.md 的「全局验收」节可启动。
