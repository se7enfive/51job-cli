# AGENTS.md — AI Agent 集成指南

51job-cli 是纯 CLI，每条命令输出结构化纯文本（`--json` 可选），适合 LLM 通过子进程编排招聘流水线。

> **🧭 本仓库是 CLI 源码仓（原子能力）。要跑「一条龙招聘流水线」，请去
> `skills/recruit-daily-51job/`（在 recruiting-copilot 仓库）——那是外层编排，
> 管「查未读→寻源→初筛→打招呼→台账→日报」的完整工作流；本文件只管命令怎么用。

## 安全红线（Agent 必须遵守）

1. **不要并发批量操作**。所有写操作（send/action/greet）之间有随机节流（800–2500ms），外层脚本不要再叠加高频循环。批量沟通请控制节奏：`--text` 内容可变、间隔至少 3–5 秒。
2. **风控熔断优先**。命令检测到风控/验证页面会立即停止并输出 `风控熔断` 警告。此时**不要重试**，应停止并向用户报告。
3. **禁止无头模式**。`51JOB_BROWSER_HEADLESS=true` 会被平台风控识别（UA 自报 HeadlessChrome 与 Client Hints 矛盾），有封号风险。默认有头，勿覆盖。
4. **登录态敏感**。Cookie 仅存于 `~/.51job-cli/.cache/`，不要读取、导出或转发该目录内容。
5. **简历预览每日次数有限**，不要循环调用 `preview`。

## 典型招聘流程编排

```
1. 51job login                  → 首次使用：用户扫码登录（一次性）
2. 51job list --unread --json   → 获取未读候选人（解析 JSON）
3. 51job chat <姓名> --index N   → 打开会话（同名用序号）
4. 51job action resume          → 索要简历
5. 51job send --text "您好，请问方便发一下简历吗？"
6. 51job search <关键词> --json → 人才搜索（13 维筛选取值见 skills/recruit-daily-51job/references/channels-51job.md）
7. 51job greet <姓名> --job <岗位> → 对候选人打招呼（补搜池后再确认）
8. 51job recommend <岗位> --json → 人才望远镜推荐（姓名·点名）
9. 51job inspect <姓名> --json   → 候选详情结构化（初筛打分用）
10. 51job positions --json       → 职位列表
11. 51job jd <职位名> --cat      → 直接输出 JD 正文
```

## 输出约定

- 纯文本模式：人类可读表格，行数 = 结果数
- `--json` 模式：`[{index, name, ...}]`，直接可被 LLM 解析
- 错误输出到 stderr，成功数据输出到 stdout（`✖` = 致命错误，`⚠` = 警告）

## 页面适配

ehire.51job.com 页面改版时，先运行 `51job probe` 探查页面结构，将 probe 输出的 class 更新到 `src/pages/selectors.ts` 对应分组即可。不要写死页内文本。

## 环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `51JOB_BROWSER_HEADLESS` | true=无头（不推荐） | false |
| `RECRUIT_BROWSER_HEADLESS` | 招聘工具链共读开关（同上） | false |
| `51JOB_DELAY` | 节流毫秒，如 `800,2500` | `800,2500` |
| `CHROME_PATH` / `51JOB_CHROME` | 指定浏览器可执行文件 | 自动探测 |
