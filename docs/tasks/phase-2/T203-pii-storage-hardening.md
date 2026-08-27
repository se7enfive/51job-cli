# T203：本地 PII 权限收紧与保留期清理

| 字段 | 值 |
|---|---|
| 阶段 | Phase 2 — 安全与隐私 |
| 优先级 | P1 |
| 状态 | done（2026-08-27） |
| 依赖 | 无（与 T201 同改 utils/store.ts，注意串行） |
| 验证 | 自动 + Unix 环境抽查 |

## 问题

本地静默沉淀候选人 PII，无权限收紧、无保留期：

- 简历截图 `~/.51job-cli/ocr/<姓名>-<日期>.png`（chat.ts:433）、OCR 文本 `<姓名>.txt`（resume_ocr.ts:30-35）、probe DOM 快照（probe.ts）、JD 缓存（job.ts）；
- `store.ts` 的 `mkdirSync`/`writeFileSync` 全部用系统默认权限（Unix 755/644，多用户机器其他账号可读）；
- 文件永久保留，无清理命令，长跑磁盘无限增长。

## 修复要求

1. **权限**（`utils/store.ts`）：
   - `ensureDirs` 对所有子目录 `mkdirSync(..., { recursive: true, mode: 0o700 })`；
   - `writeJson` 支持 mode 参数并以 `0o600` 写敏感文件（调用方逐个标注：state.json 归 T201，OCR 文本归本任务）；
   - `ocrResumePngToTextFile` 写 .txt 用 `0o600`；截图写入点（chat.ts）同步；
   - 注释说明 Windows 上 POSIX mode 仅 read-only 位，多用户隔离依赖系统账户边界。
2. **保留期**：新增 `51job clean` 命令：
   - 清理 `ocr/`、`probe/` 中早于保留期的文件（默认 30 天，`51JOB_RETENTION_DAYS` 可配，`0` = 全部）；
   - `--dry-run` 只列出将删除的文件；
   - **不触碰** `.cache/`（登录态、state、锁）、`jd/`（默认保留；`--jd` 显式清理）；
   - 文件年龄按 mtime。
3. README 安全提示（位置、保留期、清理方式）归 T403。
4. 可选：`ocr` 目录内按天建子目录（`ocr/2026-08-27/`）让清理更简单——若做，同步改 chat.ts/resume_ocr.ts 路径与 T403 文档。

## 验收标准

- [ ] Unix 下新建的 ocr/probe 文件权限 600、目录 700
- [ ] `51job clean --dry-run` 列出过期文件且不删除；去掉 --dry-run 后按期清理
- [ ] `51job clean` 后登录态完好（`.cache` 未动），下一条命令免登录可用（🧪）
- [ ] `51JOB_RETENTION_DAYS=0` 全清 ocr/probe；默认 30 天

## 实施记录（2026-08-27）

- **权限**（目录/JSON 部分随 T201 已落）：OCR 文本（resume_ocr.ts writeFile mode 0600）、probe 快照（probe.ts writeFileSync mode 0600）、截图（chat.ts screenshot 后 chmodSync 0600，失败不阻断）；注释注明 Windows 仅 read-only 位。jd 缓存（公开职位信息）未加 chmod。
- **`51job clean` 命令**：`src/utils/clean.ts` 提供 `collectExpiredFiles(retentionDays, includeJd)`（按 mtime，仅平铺文件）；命令支持 `--dry-run` / `--jd`（默认不清理 jd） / `--all`；保留期默认 30 天，`51JOB_RETENTION_DAYS` 可配（0=全部）。不走 runCommand（无需浏览器、离线可用、不做可用性校验）。
- **端到端验证通过**（本机）：旧文件（603 天）被 dry-run 列出并清理，新文件保留，`.cache` 内植入的哨兵文件未触碰。
- 「按天建子目录」可选项未做（平铺 + mtime 已满足），后续文件量大了再议。
- README 安全提示归 T403。

## 注意事项

- 「按天建子目录」是结构性改动，会让旧文件散在根目录——clean 需同时兼容根目录文件与子目录结构。
- 保留期清理只对**生成物**（ocr/probe/jd），绝不碰登录态与 state，这点在 clean 命令帮助里写明。
