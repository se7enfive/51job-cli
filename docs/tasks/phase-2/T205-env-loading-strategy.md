# T205：cwd `.env` 加载策略收敛

| 字段 | 值 |
|---|---|
| 阶段 | Phase 2 — 安全与隐私 |
| 优先级 | P1 |
| 状态 | todo |
| 依赖 | 无 |
| 验证 | 自动 |

## 问题

`src/index.ts:29-31`：CLI 在**任意工作目录**执行都会加载该目录的 `./.env`。全局安装后用户在第三方/恶意项目目录里跑 `51job`，恶意 `.env` 可注入：

- `CHROME_PATH` → `browser.ts` 直接 spawn 该可执行文件（任意本地代码执行）；
- `API_KEY`/`SECRET_KEY` → 简历 OCR 数据导向攻击者的百度应用；
- `51JOB_BLOCK_*` → 关闭风控拦截；
- `51JOB_DELAY=0` → 撤掉节流放大风控风险。

另有一致性问题：`.env.example` 声称「项目级覆盖用户级」，但 dotenv 默认 `override:false` 且用户级先加载，实际用户级优先——文档相反（修正归 T402）。

## 修复要求

1. **默认只加载** `~/.51job-cli/.env` + 系统环境变量，不再自动读 cwd `./.env`。
2. 项目级配置改为显式启用，二选一（推荐 a）：
   - a) 环境变量开关：`51JOB_PROJECT_ENV=1` 时才加载 `./.env`；
   - b) CLI 全局参数：`51job --env <path>` 显式指定（实现为 program 级 option + `loadEnv({ path })`，在命令 action 前生效需用 `program.hook('preAction')` 或加载时机前移）。
3. 加载项目级时 `out()` 一行提示「已加载项目级配置: <路径>」，让来源可感知。
4. `.env.example` 的「用法」注释与 `.env.example:5-8` 的优先级描述同步修正（与 T402 协同，本任务先保证代码行为正确并更新 example 头部注释）。

## 验收标准

- [ ] 在含恶意 `.env` 的目录执行 `51job doctor` → 配置不被加载（doctor 输出可佐证）
- [ ] `51JOB_PROJECT_ENV=1` 时项目级 `.env` 生效且有加载提示
- [ ] 用户级 `~/.51job-cli/.env` 与系统环境变量行为不变
- [ ] 与「系统环境变量优先于 .env」的既有语义不冲突（dotenv override:false 保持）

## 注意事项

- 这是行为变更：已有用户若依赖项目级 `.env` 会突然失效——必须在 T403 的 README/CHANGELOG 标注迁移方式（设 `51JOB_PROJECT_ENV=1` 或迁到用户级）。
- `51job doctor` 顺带输出「当前生效的配置来源」（用户级/项目级/系统），便于排障（可选增强）。
