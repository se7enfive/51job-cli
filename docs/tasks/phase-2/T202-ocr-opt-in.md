# T202：简历 OCR 改显式 opt-in

| 字段 | 值 |
|---|---|
| 阶段 | Phase 2 — 安全与隐私 |
| 优先级 | P0 |
| 状态 | todo |
| 依赖 | 无 |
| 验证 | 实机 🧪（preview 链路） |

## 问题

`src/ocr/resume_ocr.ts:10-13`：

```ts
return v !== '0' && v !== 'false' && v !== 'no';
```

**OCR 默认开启**（opt-out）。配置了百度密钥后，`51job preview` 会把含手机号/住址/完整经历的简历整框截图 base64 上传百度智能云（`baidu_ocr.ts:91-98`），无任何事前提示。

这是向第三方传输候选人个人信息（个税法/个保法语境下的合规风险），默认开启违背最小化原则；且未配置密钥时每次 preview 都抛错（resume_ocr.ts:22-26），体验也差。

## 修复要求

1. `isResumeOcrEnabled` 反转为**默认关闭**：仅 `51JOB_RESUME_OCR` 为 `1/true/yes`（大小写不敏感）时开启。
2. 开启且实际上传前，`previewResume`（chat.ts）通过 `out()` 明确提示「简历截图将上传百度云 OCR 识别」。
3. `ocrResumePngToTextFile` 的「未配置密钥」报错路径调整为：默认关闭后正常不可达；显式开启但无密钥 → 保留明确报错（这是配置错误）。
4. preview 在 OCR 关闭时的输出要说明：「截图已保存至 <路径>；OCR 未开启（51JOB_RESUME_OCR=1 开启）」——路径信息本就存在，确保不因关闭 OCR 而丢失。
5. `.env.example` / README / AGENTS 的说明同步归 T402/T403，本任务先把代码行为与 `chat.ts` 注释（chat.ts:347 附近的 OCR 说明）改对。

## 验收标准

- [ ] 全新环境（无 51JOB_RESUME_OCR、有百度密钥）`preview <姓名>` → 仅截图保存，无网络上传，正常退出并提示如何开启（🧪）
- [ ] `51JOB_RESUME_OCR=1` + 密钥 → OCR 正常产出 .txt（🧪）
- [ ] `51JOB_RESUME_OCR=1` 无密钥 → 明确报错指向配置项
- [ ] 截图保存逻辑不受影响

## 注意事项

- 已有用户的 `.env` 里若写了 `51JOB_RESUME_OCR=0`，反转后行为不变（仍关闭）；只影响「从未设置」的用户——这正是要保护的对象。
- 本任务不改百度 OCR 调用本身（超时问题归 T306）。
