/* 一次性冒烟测试：验证 puppeteer-core/CDP 全链路（无头模式，测试后自动关闭） */
// T303 隔离：临时 state/profile 目录，不触碰真实 ~/.51job-cli（不读写真实 state.json、
// 不复用真实常驻浏览器）；测试结束清理临时目录与浏览器进程。
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '51job-smoke-'));
process.env['51JOB_STATE_FILE'] = path.join(tmpDir, 'state.json');
process.env['51JOB_USER_DATA_DIR'] = path.join(tmpDir, 'profile');
process.env['51JOB_BROWSER_HEADLESS'] = 'true';
const { ensureBrowser, newPage, closePage, shutdownBrowser } = require('../dist/core/browser');

(async () => {
  let browser = null;
  try {
    browser = await ensureBrowser();
    const page = await newPage(browser);
    await page.goto(
      'data:text/html,<html><head><title>smoke</title></head><body><h1 id="t">你好51job</h1><button id="b" onclick="this.textContent=\'clicked\'">按钮</button></body></html>',
      { waitUntil: 'load', timeout: 10000 }
    );
    const title = await page.evaluate(() => document.title);
    const h1 = await page.$('h1#t');
    const h1text = h1 ? await h1.evaluate((el) => (el.textContent || '').trim()) : null;
    const btn = await page.$('button#b');
    await btn.click();
    await new Promise((r) => setTimeout(r, 300));
    const btnText = await btn.evaluate((el) => (el.textContent || '').trim());
    const url = page.url();
    const viewportProbe = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    console.log(JSON.stringify({ title, h1text, btnText, url, viewportProbe }, null, 2));
    await closePage(page);
  } finally {
    if (browser) await shutdownBrowser().catch(() => {});
    // Windows：Chrome 进程退出后文件锁释放有延迟，best-effort 清理，失败不报红
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      console.warn(`[smoke] 临时目录清理失败（可忽略）: ${tmpDir}`);
    }
  }
})().catch((e) => {
  console.error('SMOKE-FAIL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
