# T401：环境变量统一（命名与优先级）

| 字段 | 值 |
|---|---|
| 阶段 | Phase 4 — 文档与配置对齐 |
| 优先级 | P2 |
| 状态 | todo |
| 依赖 | 无（先行，T402/T403 文档以本任务结果为准） |
| 验证 | 自动 + 单测 |

## 问题

三处「文档说的变量」与「代码读的变量」不一致，按文档配置**完全不生效**：

1. **无头开关**：AGENTS.md:48 写 `RECRUIT_BROWSER_HEADLESS`，代码 `browser.ts:82` 实际读 `RECRUIT_BROWSER_HIDDEN`（名字语义也反了：HIDDEN ≠ HEADLESS）。
2. **百度 OCR 凭证优先级**：`.env.example:16-17` 声称 51JOB 专用变量「优先级高于通用名」，代码 `baidu_ocr.ts:12,16` 实际是 `API_KEY || 51JOB_BAIDU_API_KEY`——通用名优先。用户机器上有其他工具的 `API_KEY`（OpenAI 等）时，51job 会拿错凭证、简历发往错误百度应用。
3. **CAPABILITIES.md:55** 提到 `51JOB_THROTTLE_*`，代码只认 `51JOB_DELAY`。

## 修复要求

1. **无头开关**：`getHeadlessFlag` 改为读 `RECRUIT_BROWSER_HEADLESS`；兼容一个版本：旧名 `RECRUIT_BROWSER_HIDDEN` 仍被识别但打 `warn('RECRUIT_BROWSER_HIDDEN 已更名 RECRUIT_BROWSER_HEADLESS，请迁移')`；`51JOB_BROWSER_HEADLESS` 优先级不变。
2. **百度凭证**：`apiKey()`/`secretKey()` 反转为 `51JOB_BAIDU_*` 优先、通用 `API_KEY`/`SECRET_KEY` 兜底；使用通用名时 `warn` 提示建议迁移专用名（与 `.env.example:16-17` 声明对齐）。
3. `doctor` 命令的「默认浏览器模式」文案（browser.ts:81-89 附近）同步列出实际支持的全部相关变量。
4. 为凭证优先级与无头开关解析补单测（T301 框架就绪后；未就绪先写用例文件占位）。

## 验收标准

- [ ] 设 `RECRUIT_BROWSER_HEADLESS=true` 实际生效（🧪，doctor 可观测）
- [ ] 同时设 `51JOB_BAIDU_API_KEY` 与 `API_KEY` → 用 51JOB 专用值，且有 warn
- [ ] 只设旧名 `RECRUIT_BROWSER_HIDDEN` → 仍生效 + 迁移 warn
- [ ] 相关单测通过（或占位用例随 T301 转绿）

## 注意事项

- 「兼容旧名一个版本」的删除时间记入 CHANGELOG（T404），下个 minor 移除。
- 本任务只动变量读取层，不改任何依赖这些变量的业务逻辑。
