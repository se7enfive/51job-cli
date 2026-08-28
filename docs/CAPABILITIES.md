# 51job-cli Capabilities 状态说明 (As of v0.1.1)

目前各 CLI 原子调用命令测试覆盖及环境跑真机效能报告状态如列，各能力特性以 `src/index.ts` 源码下实际为最终形态：

### 命令族矩阵集与执行通断状态
共有 **18 个命令**，除 action 带有破坏级对外更改影响不可简单全量高并测，其它全闭环跑通：

| 命令分类 | 指令项 | 测试状态标签 (Tested Status) | 特征及限制边界 (Notes & Restrictions) |
|---|---|---|---|
| 环境与启停级 | `doctor` | ✅ 实测通过 | 查看当前工作系统各项检测判定反馈 |
| 环境与启停级 | `update` | 🟡 仅发工具 | 此库中自身依赖 npm 全局拉取处理，暂未实装代理逻辑 |
| 环境与启停级 | `shutdown` | ✅ 实测通过 | 断掉当前进程，挂回本地 Cache。防浏览器常驻拖垮 |
| 登录流 | `login` | ✅ 实测通过 | 只弹有头模式窗口，供人工扫码（扫码后由后续命令轮巡，不阻塞） |
| 登录流 | `wait-login` | ✅ 实测通过 | 确定 timeout 控制；退出码 0=已登录 / 1=超时（编排层据此区分） |
| 列表查询源 | `list` | ✅ 实测通过 | **工作台投递箱全职位聚合流**（T111 滚动加载全量）；`--json` 导出投递候选人对象，序号与 `chat --index` 一致 |
| 列表查询源 | `search` | ✅ 实测通过 | 十三维筛选全参联动覆盖（`--exp/--age/--gender/--city/--residence/--edu/--school/--status/--industry/--func/--salary/--work-industry/--work-func`） |
| 列表查询源 | `recommend` | ✅ 实测通过 | 人才望远镜推荐池（系统内置规则刷新），拉取最快；`--greet`/`--inspect` 可直连动作 |
| 会话窗口级 | `chat` | ✅ 实测通过 | 依赖 `list`/`search` 取得的 `index` 定位保证同步；不能仅凭姓名跨库乱拉 |
| 会话窗口级 | `send` | ✅ 实测通过 | 防重防抖（一次只发一遍），需先 `chat` 打开目标会话 |
| 会话窗口级 | `action` | ⚠️ 待最终人机结合敲定 | `resume/unsuitable/note/wechat/phone/interview`；部分写操作改动招聘官端台账且不可撤回 |
| 操作执行级 | `greet` | ✅ 实测通过 | 校验流：定位→详情→防错位确认→Hi；额度不足等回 `failed`(Exit 1) 不误报成功；`--dry-run` 只看不发 |
| 详情档案探针 | `inspect` | ✅ 实测通过 | 搜索池定位 → 开详情 → 结构化 JSON；`--hi` 提取后调「立即Hi聊」（耗点数） |
| 详情档案探针 | `talent-detail` | ✅ 实测通过 | **投递/聊天双来源**（人才管理页，非搜索池）提取结构化 JSON；`--hi` 走免费「回复」 |
| 详情档案探针 | `preview` | ✅ 实测通过 | 在线简历截图存档本地；OCR 走云接口是显式 opt-in（`51JOB_RESUME_OCR=1`） |
| 本端配置源 | `positions` | ✅ 实测通过 | 职位目录 + `--candidates <职位名>` 拉取该职位候选人；`--scope <my\|org>` 视图可复现；`--source <auto\|delivery\|search>` 控制来源（search=投递少时人才池扩充，自动注入城市/学历筛选） |
| 本端配置源 | `jd` | ✅ 实测通过 | 抓取职位 JD 长文缓存 `~/.51job-cli/jd/`；`--cat` 直出正文 |
| 开发者调参专用 | `probe` | 🟡 测试用 | DOM选通树结构基线捕捉工具。 |

### 环境依赖参量配置 (Environment Options)
> 读取由系统 ENV 系统变量及 `~/.51job-cli/.env` 文件叠加承接，当前使用项目下工作流 `51JOB_PROJECT_ENV` 设置开启开关作为引入防止项目污染注入。

- `CHROME_PATH` (或 `51JOB_CHROME`): Chrome 路径，兜底层未识别出浏览器前生效。
- `RECRUIT_BROWSER_HEADLESS` (或 `51JOB_BROWSER_HEADLESS`): 是否关闭实体框直接后置纯跑（风控检测极强阻断！非测试和极其确信情况不拉）。
- `51JOB_DELAY`: 定义防重检测执行中间过量挂休与延滞范围长度。
- `51JOB_BAIDU_API_KEY`/`51JOB_BAIDU_SECRET_KEY`: 提供百度 OCR 智能组件挂载调控服务调用密钥。
- `51JOB_RESUME_OCR`: =1 即启动传云接口 OCR。
- `51JOB_BLOCK_REPORT_PATTERNS`: 用户显式传入确保证实可拦截无伤报告流模式时使用。
- `51JOB_RETENTION_DAYS`: `clean` 会话时效存储寿命参数配置，默认30整。
- `51JOB_AVAILABILITY_TIMEOUT_MS`/`51JOB_AVAILABILITY_REFRESH`: 校验 51job 组件前端包改版刷新超时边界判定条件参数。
