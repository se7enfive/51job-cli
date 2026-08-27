# T306：异步超时与详情 tab 捕获加固

| 字段 | 值 |
|---|---|
| 阶段 | Phase 3 — 质量门禁与可靠性加固 |
| 优先级 | P1 |
| 状态 | todo |
| 依赖 | T107（身份校验语义先行） |
| 验证 | 自动（可注入部分）+ 实机 🧪 |

## 问题

1. **百度 OCR 无超时**：`src/ocr/baidu_ocr.ts:50-56`（token）与 `:91-98`（识别）两处 `fetch` 均无 `AbortSignal` → 半开连接时 `preview` 无限期挂起。
2. **新 tab 捕获脆弱**：
   - `candidate-detail.ts:262-274` / `talent-insight.ts:147-159`：`targetcreated` 只判断 `t.type() === 'page'`，页面自弹的统计/广告 tab 会被误当详情页；10s `setTimeout` 返回值未保存，handler resolve 后 timer 仍挂着（不清理）；
   - 无新 tab 时 fallback 把列表页/人才管理页当详情页读（T107 已改语义为快速失败，本任务修捕获本身）。
3. **同 URL 二次查看必然超时**：`talent-insight.ts:354, 396` 用「打开前 URL 集合」判新页——同一候选人第二次 inspect（编排重跑常见）URL 已在基线里 → 12s 轮询必然失败。
4. **风控反弹导航无串行化**：`pageGuards.ts:530, 537` 的 `void page.goto(...)` fire-and-forget，可能与后续导航并发，顺序未定义。

## 修复要求

1. **OCR 超时**：两处 fetch 加 `signal: AbortSignal.timeout(30_000)`；超时/失败时降级——`preview` 保留截图、warn「OCR 未完成（原因）」、整体命令不算失败（截图本身是主要产物）。错误分类：`TimeoutError` → 「OCR 服务超时」；其他 → 原样透传。
2. **详情 tab 捕获统一**（两个文件同一模式）：
   - `targetcreated` handler 内校验 `t.url()` 含 `/resume/detail`（或等待 `target.page()` 后校验 URL）才 resolve；
   - `setTimeout` 返回值保存，resolve 时 `clearTimeout`；
   - 超时后不 fallback 读错页（T107 已定），直接返回失败。
3. **`openCardDetail` 基线改对象身份**：`beforeUrls` 换成「打开前 `browser.pages()` 的 Page 对象集合」，轮询时找「不在旧集合中且 URL 含 /resume/detail」的**新 Page 对象**——天然兼容同 URL 二次打开。
4. **导航串行化**：nav guard 内加简单串行（`let navBusy = false`，busy 时丢弃新反弹导航并记 page console 日志），避免并发 goto。

## 验收标准

- [ ] OCR：mock fetch 永不响应 → 30s 超时、截图保留、命令不挂起（单测注入）
- [ ] 同一候选人连续两次 `recommend --inspect` → 两次都成功（🧪）
- [ ] 捕获超时路径 < 12s 快速失败（T107 语义 + 本任务 timer 清理）
- [ ] 触发一次风控反弹（或代码走查）确认无并发 goto

## 注意事项

- `browser.pages()` 每次 CDP 调用有开销，轮询间隔保持现有 400-700ms 即可。
- targetcreated 校验 URL 时页面可能还在 about:blank（早期 target）——需要 `target.page()` 后等 URL 变化或轮询其 URL，参考 `openCardDetail` 现有轮询写法。
