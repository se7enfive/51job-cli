# 51job-cli

基于 puppeteer-core / CDP（Chrome DevTools Protocol）驱动本机浏览器的前程无忧（51job）企业招聘端自动化 CLI。
适合被 AI Agent 引擎、shell 脚本或其他无人值守工具直接拉起做管线编排。

## 核心特性
- **真实浏览器驱动**：直接外接本机的 Chrome 进程，登录态持久化本地，规避无头封号墙。
- **Agent/编排友好**：全流程命令独立拆分并带有明确的退出码（0 成功 / 1 业务失败 / 2 可用机制墙）；支持 `--json` 单文件结构化流式吐出。
- **三段式反检测防御**：浏览器启动参数伪装 + DOM 原型链修复 + HTTP CDP 网络层阻断，内置风控反弹和 15s 级强力跳转自恢复。

> 注：本仓库为原子能力调用 CLI。
> 你可能在寻找的「定时循环、基于画像初发筛选、简历日报整理」等调度侧工作流位于下游仓库的 `skills/recruit-daily-51job/`。

---

## 快速上手

### 1. 前置环境
- **Node.js**: >= 20.0
- **浏览器**: 本机需已安装 [Google Chrome](https://www.google.com/chrome) 或 Microsoft Edge（均可自动探测到；自定义指定可用环境变量 `CHROME_PATH` 控制）。

### 2. 工具安装
> 全局直接安装为可执行命令（推荐）
```bash
npm install -g 51job-cli
```
> 或 Clone 源码编译调试：
```bash
git clone https://github.com/se7enfive/51job-cli.git && cd 51job-cli
npm install && npm run build
npm link
```

### 3. 配置（环境变量可选）
用户级复制一份预设的环境变量模板即可（可根据机器性能、使用习惯进行调整）：
```bash
cp .env.example ~/.51job-cli/.env
```

---

## CLI 命令集全览

共有 18 项主要可用动作模块（可随时键入 `51job --help` 查看全参数帮助）：

### 基础验证类
| 命令 | 描述 |
|---|---|
| `login` | 打开并聚焦至 51job eHire 登录页面并立刻返回（登录态由后续 `wait-login` 或首个业务命令检测）。 |
| `wait-login [--timeout <秒>]` | 轮询探测登录态；成功退出 0、超时退出 1（默认 300s）。 |
| `shutdown` | 关闭常驻浏览器进程（Cookie / 会话资料仍保留在本地 Profile 目录）。 |
| `doctor` | 环境自检（Chrome 路径、Node 版本、数据目录、浏览器模式）。只读。 |
| `update` | 打印升级指引（实际执行 `npm install -g 51job-cli@latest`）。 |
| `probe` | 开发调试：DOM 选择器校准快照（普通场景无用）。 |

### 工具箱（查询寻源流）
| 命令 | 描述 |
|---|---|
| `list [--unread]` | **工作台投递箱**全职位聚合候选人流（不分职位；每人 index/姓名/时间/画像/未读）。序号与 `chat --index` 一致。按职位筛选请用 `positions --candidates`。 |
| `search <关键词>` | **人才搜索池**查询，支持十三维筛选（`--exp/--age/--gender/--city/--residence/--edu/--school/--status/--industry/--func/--salary/--work-industry/--work-func`），`--json` 输出结构化画像。 |
| `recommend [岗位]` | **人才望远镜**推荐池（按岗位的系统推荐，不耗点数）。`--greet`/`--inspect` 可直接打招呼/查详情。 |
| `positions [--candidates <职位名>]` | **职位管理页**在招职位目录；`--candidates` 拉取该职位候选人，`--source <auto\|delivery\|search>` 控制来源（auto=按有无投递分派 / delivery=仅投递 / search=人才池搜索扩充），`--scope <my\|org>` 切视图。 |
| `jd <名称> [--cat]` | 抓取职位 JD 长文缓存到 `~/.51job-cli/jd/`，`--cat` 直出正文。 |

### 执行管线（原子级会话动作）
| 命令 | 描述 |
|---|---|
| `inspect <姓名> [--job <岗位>] [--index <序号>] [--hi]` | **搜索池**候选人简历详情（只读不耗点数）；`--hi` 提取后调「立即Hi聊」（耗点数）。 |
| `talent-detail <姓名> [--strict] [--hi]` | **投递/聊天来源**候选人详情（非搜索池，定位方式为人才管理行）；`--hi` 走免费「回复」动作。 |
| `preview <姓名>` | 在线简历截图存档到 `~/.51job-cli/ocr/`（每日次数有限；`51JOB_RESUME_OCR=1` 才上传云端 OCR，opt-in）。 |
| `greet [姓名] [--job <岗位>] [--by-index <序号>] [--dry-run] [--no-confirm]` | **Hi聊**一站式：搜索筛选 → 定位 → 详情摘要 → 人机确认 → 发出。写操作耗点数；`--dry-run` 只看不发。成功 0 / 点数不足或失败 1。 |
| `chat [姓名] [--index <序号>] [--unread] [--strict]` | 打开候选人的聊天会话（会话窗口，供后续 send/action 用）。不发送消息。 |
| `send --text <文案>` | 向【已打开的 chat 会话】发送一条文本（防重防抖，一次一遍）。 |
| `action <操作> [--no-confirm]` | 会话业务动作：`resume`(索要简历)/`unsuitable`(不合适)/`note`(备注)/`wechat`(换微信)/`phone`(换电话)/`interview`(约面试)。写操作默认人机确认。 |

---

## 隐私、数据与安全指引

为保证跨平台多环境与个人信息规范体系防泄露：
* **数据出境同意事项（OCR Opt-in）**：`preview` 对于人选全记录抓取的默认保存格式只提供本机纯位图 PNG 镜像快照（默认保存在 `~/.51job-cli/ocr/`）。它**不会执行跨网上传云打码**，除非用户清晰配置环境变量 `51JOB_RESUME_OCR=1` 声明 opt-in（采用百度智能云组件）。
* **清理历史隐私数据**：所有的留档缓存快照（如截屏照片、JSON）、调试缓存都统一支持并应规范定期实施：
  ```bash
  51job clean
  ```
* **单环境浏览器（端口占用）**：系统在驱动 Chrome 会以远程 CDP （Websocket）建立端口连接通道。这要求系统只被受控使用（切忌在多进程高危权限的合租服务器不经虚拟化跑该软件，有通过端口跳层控制用户 51job 控制后台账户的操作权限风险）。
