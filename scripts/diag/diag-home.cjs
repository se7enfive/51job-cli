/**
 * 诊断：导航到工作台首页，抓默认视图 + tab 切换元素，然后恢复原页面。
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
  const origUrl = target.url();
  await target.bringToFront();

  // 导航到工作台首页
  await target.goto('https://ehire.51job.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 4000));

  const info = await target.evaluate(() => {
    const cards = document.querySelectorAll('.resume-card');
    const firstCard = cards.length ? (cards[0].textContent || '').trim().slice(0, 60) : '(无卡片)';
    // tab 候选：class 含 tab/menu/switch 且文本含 投递/推荐/简历
    const tabs = [];
    for (const el of document.querySelectorAll('[class*="tab"], [class*="menu"], [class*="switch"], [class*="nav"], li')) {
      const t = (el.textContent || '').trim();
      const cls = typeof el.className === 'string' ? el.className : '';
      if (t.length > 0 && t.length <= 10 && /投递|推荐|简历|收到|全部/.test(t) && cls.length < 60) {
        tabs.push({ tag: el.tagName.toLowerCase(), cls, text: t });
      }
    }
    const seen = new Set();
    const uniq = tabs.filter((c) => {
      const k = `${c.tag}|${c.cls}|${c.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { url: location.href, cardCount: cards.length, firstCard, tabs: uniq.slice(0, 25) };
  });

  console.log('首页 URL:', info.url);
  console.log('卡片数:', info.cardCount, '| 首卡:', info.firstCard);
  console.log('--- 视图切换候选 ---');
  for (const t of info.tabs) console.log(`  <${t.tag} class="${t.cls}"> ${t.text}`);

  // 恢复原页面
  await target.goto(origUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('已恢复原页面:', origUrl);
  await browser.disconnect();
  process.exit(0);
})();
