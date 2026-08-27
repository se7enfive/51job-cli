#!/usr/bin/env node
/** 诊断：dump 面板头部按钮的 title/aria/alt 属性 + 点击 file-style.online 观察结果 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

async function main() {
  const stateFile = path.join(os.homedir(), '.51job-cli', 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${state.port}`, defaultViewport: null });
  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes('ehire.51job.com'));
  if (!page) page = pages[pages.length - 1];

  // 1) 属性 dump
  const attrs = await page.evaluate(() => {
    const out = [];
    const els = Array.from(document.querySelectorAll('.chat-user-operate [class*="operate"], .chat-user-operate .file-style, .chat-user-operate img, .chat-user-operate svg'));
    for (const el of els) {
      const r = el.getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 50),
        title: el.getAttribute('title'),
        aria: el.getAttribute('aria-label'),
        alt: el.getAttribute('alt'),
        w: Math.round(r.width),
      });
    }
    // message-types 工具栏图标
    for (const el of Array.from(document.querySelectorAll('.message-types .icon-hover-wrap, .message-types .el-popover__reference'))) {
      const t = (el.textContent || '').trim().slice(0, 20);
      out.push({ tag: 'toolbar', cls: 'message-types', title: el.getAttribute('title') || t, aria: el.getAttribute('aria-label'), alt: null, w: 0 });
    }
    return out;
  });
  for (const a of attrs) console.log(JSON.stringify(a));

  // 2) 点击 file-style.online
  const p = await page.evaluate(() => {
    const el = document.querySelector('.chat-user-operate .file-style.online, .chat-user-operate .el-tooltip.file-style');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!p) {
    console.log('(未找到 file-style 按钮)');
    return browser.disconnect();
  }
  await page.mouse.click(p.x, p.y);
  await new Promise((r) => setTimeout(r, 4000));

  const after = await page.evaluate(() => {
    const out = { dialogs: [], iframes: [], newPanels: [] };
    for (const w of Array.from(document.querySelectorAll('[class*="dialog"], [class*="drawer"], [class*="resume"], [class*="cv"]'))) {
      const r = w.getBoundingClientRect();
      if (r.width > 200 && r.height > 200) {
        out.dialogs.push(`${typeof w.className === 'string' ? w.className : ''} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    for (const f of document.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect();
      if (r.width > 0) out.iframes.push(`${(f.getAttribute('src') || '').slice(0, 100)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
  console.log('=== 点击后 ===');
  console.log('dialogs:', JSON.stringify(after.dialogs));
  console.log('iframes:', JSON.stringify(after.iframes));
  await browser.disconnect();
}
main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
