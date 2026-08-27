#!/usr/bin/env node
/** 诊断：连常驻浏览器，展开第一个「回复」面板，dump 可见按钮/可点击元素文本 */
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
  console.log('page:', page.url());

  const info = await page.evaluate(() => {
    const out = { buttons: [], panelVisible: false, iframeCount: 0 };
    // 面板是否可见
    const panels = Array.from(document.querySelectorAll('.chatting-area, [class*="chatting"]'));
    out.panelVisible = panels.some((p) => {
      const r = p.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    // 所有可见按钮类元素
    const els = Array.from(document.querySelectorAll('button, [class*="btn"], [role="button"], a[class*="action"], [class*="toolbar"] *'));
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      if (!t) continue;
      const cls = (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 60);
      out.buttons.push({ t, cls });
    }
    out.iframeCount = document.querySelectorAll('iframe').length;
    return out;
  });
  console.log('panelVisible:', info.panelVisible, 'iframes:', info.iframeCount);
  const seen = new Set();
  for (const b of info.buttons) {
    const k = b.t + '|' + b.cls;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  [${b.t}]  (${b.cls})`);
  }
  await browser.disconnect();
}
main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
