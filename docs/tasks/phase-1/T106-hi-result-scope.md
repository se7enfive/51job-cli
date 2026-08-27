# T106：Hi 结果判定收敛到被点击卡片

| 字段 | 值 |
|---|---|
| 阶段 | Phase 1 — 正确性与退出码契约 |
| 优先级 | P0 |
| 状态 | todo |
| 依赖 | 无（与 T102/T103 协同） |
| 验证 | 自动（纯逻辑部分）+ 实机 🧪 |

## 问题

`detectHiResult` 的「按钮文案变化 = 成功」判定扫描的是**整个列表**，不是被点击的那张卡：

- `pages/hi-result.ts:92-104`：`btnTexts(page, selector)` 用 `$$eval` 收集选择器下**所有**按钮文本；`stillInitial`（102-104）只要任一按钮仍含「立即Hi聊」初始文案就返回 true。
- `pages/recommend.ts:227`：传入 `${s.resultItem} button.tm_button`（列表级选择器）。
- `pages/search.ts:666`：传入 `${s.resultList} ${s.resultItem} button`（列表级选择器）。

后果（多卡列表下必然出现）：

1. **false negative**：目标卡 Hi 成功、按钮文案已变，但其他卡仍是「立即Hi聊」→ `!stillInitial(texts)` 恒 false → 返回 `unknown`，成功被误报为失败。
2. **false positive**：目标卡未成功，但任何一张其他卡的按钮状态变化 → 被误判为成功。

详情页路径 `hiChatOnDetail`（candidate-detail.ts:328）只作用于单按钮，不受影响。

## 修复要求

1. `detectHiResult` 增加目标限定能力（保持向后兼容的函数签名，新增可选参数）：
   - 方案 A（推荐）：调用方在**点击前**记录目标卡在 `$$` 结果中的下标，`detectHiResult` 增加 `targetIndex` 参数，按钮文本只取 `$$(...)[targetIndex]`（或该卡片元素内查询按钮）；
   - 方案 B：调用方传入点击的 `ElementHandle`，判定时对该 handle 重新 `evaluate` 取文案。
2. `greetRecommend`（recommend.ts:194-231）：点击前已持有 `items[idx]`，把下标/元素传入 `detectHiResult`。
3. `greetTalent` 旧路径（search.ts:650-667）：同样在 `locateCandidate` 后已持有卡片下标 `idx`，传入。
4. 弹窗判定（额度/失败/未识别）保持页面级，不改。
5. `stillInitial` 的纯逻辑补单元用例（T301 联动）：给定混合文案数组，验证「仅目标变化」与「仅他卡变化」两种输入的判定。

## 验收标准

- [ ] 单元：`stillInitial` 与目标限定提取逻辑的用例通过
- [ ] 实机 🧪：推荐列表 ≥3 人，Hi 第 2 人成功 → 结果为 `success`（修复前为 unknown）
- [ ] 实机 🧪：目标未成功（如弹未识别弹窗或断网模拟）→ 不误报 success
- [ ] 详情页 Hi 路径行为不回归（🧪，可复用 T102 的实机批次）

## 注意事项

- 按钮下标在点击后可能因 SPA 重排漂移：判定时优先「点击前保存的按钮元素」；元素已 detach 时降级为「卡片内查询按钮」，再降级为现全列表判定并 warn 降级原因。
- Hi 是真实消耗点数的动作，实机验证前确认额度，失败用例优先用「额度不足」路径（不消耗）。
