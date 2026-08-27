---
name: 51job-frontend-analysis
description: Capture, archive, diff, and assess 51job/ehire frontend JavaScript for 51job-cli safety gates and anti-debug guard updates. Use when Codex needs to re-analyze current 51job frontend scripts, compare online JS with docs/research/51job-online-js baselines, update 51job availability, or recommend code changes after 51job changes ehire2021, gaea micro-frontends, login scripts, eh-crypto, or security scripts.
---

# 51job Frontend Analysis

Use this skill when 51job online frontend assets changed and 51job-cli must decide whether to stay disabled, update the verified baseline, or change page guards.

## Workflow

1. Run the capture script from the repository root:

```bash
node skills/51job-frontend-analysis/scripts/capture_51job_frontend.mjs
```

2. Read the generated files under `docs/research/51job-online-js/<date>/`:

- `manifest.json`: captured URLs, final URLs, byte sizes, SHA-256 hashes, and source category.
- `analysis.md`: version changes, high-risk script notes, and code-change recommendations.
- `raw/`: unmodified script bodies for diffing.

3. Compare against the previous verified baseline, usually the latest dated folder under `docs/research/51job-online-js/`.

4. Inspect these repo files before recommending or changing code:

- `src/core/availability.ts`
- `src/core/pageGuards.ts`
- `src/pages/selectors.ts`
- `docs/anti-detection.md` (create if missing)

5. Keep the policy strict:

- Do not add fallback or bypass switches for availability checks.
- If online entry pages reference unverified 51job JS versions, 51job-cli must remain disabled.
- Only update `src/core/availability.ts` after raw scripts are archived and the risk strategy has been reviewed.
- Puppeteer `page.evaluate` / `page.waitForFunction` additions must use string scripts, not callback functions.

## 51job-Specific Targets

- **ehire 壳页**: `https://ehire.51job.com/`
  - `vue-bundle.js`, `element-ui@*.js`, `eh-crypto.min.js?version=*`
  - gaea micro-frontend chunks: `ehire2021/micro/gaea/js/main-*.js`
- **登录页**: `https://login.51job.com/`
  - `jquery.js`, `pointtrack.js`
  - content-hashed login scripts: `common.*.js`, `login.*.js`
- **High-risk scripts**: `eh-crypto.min.js` (login encryption), `gaea` chunks, any `risk` / `security` / `captcha` assets.

## Analysis Checklist

- [ ] ehire 壳页是否仍返回 Vue/Element-UI/eh-crypto，gaea chunk 数量是否异常。
- [ ] 登录页是否仍返回 jquery/pointtrack/common/login 脚本。
- [ ] `eh-crypto.min.js` 内容是否变化（登录加密逻辑）。
- [ ] 新增的脚本 URL 是否涉及风控、反调试、验证码、安全跳转。
- [ ] `src/core/pageGuards.ts` 的拦截模式是否仍覆盖当前风险脚本。
- [ ] `src/pages/selectors.ts` 中受影响的页面选择器是否仍命中可见元素。

## Output Guidance

When reporting results, include:

- Current online versions and whether they match the verified baseline.
- Whether 51job-cli should remain disabled.
- Exact files or constants that need updates.
- Any selectors, request patterns, or script guards that changed.
- Build and runtime checks performed.
