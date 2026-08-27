/**
 * 诊断：抓工作台首页的 tab/菜单结构，定位「投递」视图入口。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

(async () => {
  const statePath = path.join(os.homedir(), '.51job-cli', 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${state.port}`,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const target = pages.find((p) => p.url().includes('ehire.51job.com')) || pages[0];
  await target.bringToFront();

  const info = await target.evaluate(() => {
    // 1. 找含「投递/简历/推荐」关键词的可点击元素（tab 候选）
    const candidates = [];
    const all = document.querySelectorAll('div, span, a, li, button');
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (t.length > 0 && t.length <= 12 && /投递|简历|推荐|收到/.test(t)) {
        const cls = typeof el.className === 'string' ? el.className : '';
        // 只记录叶子或 class 短的可点击元素，避免重复
        if (el.childElementCount <= 3 && cls.length < 80) {
          candidates.push({ tag: el.tagName.toLowerCase(), cls: cls.slice(0, 70), text: t });
        }
      }
    }
    // 去重
    const seen = new Set();
    const uniq = candidates.filter((c) => {
      const k = `${c.tag}|${c.cls}|${c.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { url: location.href, candidates: uniq.slice(0, 30) };
  });

  console.log('URL:', info.url);
  console.log('--- 投递/简历/推荐 相关元素 ---');
  for (const c of info.candidates) {
    console.log(`  <${c.tag} class="${c.cls}"> ${c.text}`);
  }
  await browser.disconnect();
  process.exit(0);
})();
