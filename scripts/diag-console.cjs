// 临时诊断：验证 puppeteer console 事件转发通道（复制 sessionPage 转发逻辑）
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const statePath = path.join(process.env.USERPROFILE || process.env.HOME, '.51job-cli', 'state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

(async () => {
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${state.port}`,
    defaultViewport: null,
  });
  const page = await browser.newPage();

  const seen = [];
  page.on('console', (msg) => {
    seen.push(`[page:${msg.type()}] ${msg.text().slice(0, 120)}`);
  });

  await page.goto('https://ehire.51job.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => console.log('TEST_MARKER_51JOB_CONSOLE', Math.floor(Math.random() * 1e6)));
  await page.evaluate(() => console.warn('TEST_WARN_51JOB'));
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`捕获 ${seen.length} 条页面 console 消息:`);
  seen.forEach((s) => console.log('  ' + s));
  const ok = seen.some((s) => s.includes('TEST_MARKER_51JOB_CONSOLE'));
  console.log(ok ? 'PASS: console 事件通道工作正常' : 'FAIL: 未捕获测试标记');
  await browser.disconnect();
  process.exit(ok ? 0 : 1);
})();
