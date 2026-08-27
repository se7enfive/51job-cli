/* 一次性冒烟测试：验证 puppeteer-core/CDP 全链路（无头模式，测试后自动关闭） */
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
  }
})().catch((e) => {
  console.error('SMOKE-FAIL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
