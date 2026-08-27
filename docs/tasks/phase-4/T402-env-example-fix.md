# T402：`.env.example` 修正

| 字段 | 值 |
|---|---|
| 阶段 | Phase 4 — 文档与配置对齐 |
| 优先级 | P2 |
| 状态 | done（2026-08-27） |
| 依赖 | T202（OCR opt-in）、T205（env 加载策略）、T401（变量统一）、T308（拦截默认值） |
| 验证 | 人工逐变量走查 |

## 问题

`.env.example` 多处与代码行为相反或格式错误：

1. **`51JOB_DELAY=800-2000` 格式错误**（:47-48）：解析器（throttle.ts:48-57）只按逗号分隔，`parseInt('800-2000')` → 800 → 固定 800ms，**随机节流静默失效**（对风控不利）。正确示例 `800,2000`。
2. **加载优先级声明相反**（:5-8）：声称「项目级覆盖用户级」，实际 dotenv `override:false` 且用户级先加载 → 用户级获胜（T205 改造后行为又变，需按最终行为重写）。
3. OCR 默认开启的表述（:19-20）、`RECRUIT_BROWSER_HEADLESS` 缺失、拦截默认值的描述（:37-38）——均随对应任务最终行为更新。

## 修复要求

1. `#51JOB_DELAY=800,2000`，注释注明「两个值=随机区间，一个值=固定」；可选：在 `parseThrottleEnv` 里同时支持 `800-2000` 写法（正则拆分），若做则示例可两者兼容并补 T301 用例——实施时二选一。
2. 重写头部「用法/优先级」块，准确描述 T205 后的加载策略（用户级 + 系统变量默认；项目级显式开关）。
3. `51JOB_RESUME_OCR` 注释改为「默认关闭；=1 显式开启（截图将上传百度云）」。
4. 补充缺失变量（按 T401/T303/T203 最终清单）：
   - `RECRUIT_BROWSER_HEADLESS`（注明旧名已弃）
   - `51JOB_BAIDU_API_KEY` / `51JOB_BAIDU_SECRET_KEY` 提升为首选示例，通用名降级为兼容说明
   - `51JOB_BLOCK_REPORT_PATTERNS` 注释改为「默认不拦截（观察模式日志）」
   - `51JOB_STATE_FILE` / `51JOB_USER_DATA_DIR`（smoke 隔离用）
   - `51JOB_RETENTION_DAYS`（clean 保留期）
   - `51JOB_AVAILABILITY_TIMEOUT_MS`（T305）
   - `51JOB_CONFIRM_TIMEOUT_MS`（T109，若实现）
5. 每个变量注释一句话说明默认值，与代码一一对应。

## 验收标准

- [ ] 逐变量走查：example 中每个变量复制到 `~/.51job-cli/.env` 后行为与注释一致
- [ ] `51JOB_DELAY` 示例复制后节流为随机区间（日志/单测可证）
- [ ] 头部优先级描述与实际加载顺序一致
- [ ] 无「文档有、代码无」的变量残留

## 实施记录（2026-08-27）

- 头部**用法/优先级**：更新为反映 T205 收敛后的逻辑（需要 51JOB_PROJECT_ENV=1 显示开启项目级；dotenv 不覆盖机制）。
- **参数示例修正**：`51JOB_DELAY` 改为逗号分隔 `800,2000` 并加注（防 `-` 写法导致固定随机失效）；`51JOB_BAIDU_*` 提为首选示例，通用改兜底（防 T401 的串扰）；无头加上 `RECRUIT_BROWSER_HEADLESS`。
- **默认行为/合规注释更新**：OCR 改默认关闭及数据传百度说明（T202）、拦截改默认不拦（T308）。
- **新增变量补充**：补入隔离测试的 STATE_FILE/USER_DATA_DIR、清理保留期的 RETENTION_DAYS、以及超时相关的 AVAILABILITY_TIMEOUT / CONFIRM_TIMEOUT。
- **全变量检验**：通过 `grep` 验证 `.env.example` 中提及的 24 个环境变量都在 TypeScript 源码中被真实引用，无挂空名。

## 注意事项

- 本任务依赖多，安排在 Phase 4 最前（T401 之后、T403 之前）。
- 走查建议写成 checklist 附在实施记录里，后续改 env 相关代码时可复用。
