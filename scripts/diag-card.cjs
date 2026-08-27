/**
 * 诊断脚本：连接常驻浏览器，抓取 ehire 页面第一张 resume-card 的真实 DOM。
 * 用于校准 selectors.ts（工作台卡片结构探查）。
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
  await new Promise((r) => setTimeout(r, 800));

  const info = await target.evaluate(() => {
    const cards = document.querySelectorAll('.resume-card');
    if (!cards.length) return { url: location.href, count: 0 };
    const first = cards[0];
    // 抽取第一张卡的骨架：层级 + class + 关键文本
    const skeleton = [];
    const walk = (el, depth) => {
      if (depth > 4 || skeleton.length > 60) return;
      const cls = typeof el.className === 'string' ? el.className : '';
      const text = (el.childElementCount === 0 ? (el.textContent || '').trim().slice(0, 30) : '').trim();
      if (cls || text) {
        skeleton.push('  '.repeat(depth) + `<${el.tagName.toLowerCase()}${cls ? ' class="' + cls.slice(0, 90) + '"' : ''}>` + (text ? ` "${text}"` : ''));
      }
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(first, 0);
    return {
      url: location.href,
      count: cards.length,
      firstCardClass: typeof first.className === 'string' ? first.className : String(first.className || ''),
      skeleton,
      firstCardHTML: first.outerHTML.slice(0, 1600),
    };
  });

  console.log('URL:', info.url);
  console.log('卡片数量:', info.count);
  console.log('首卡 class:', info.firstCardClass);
  console.log('--- 骨架 ---');
  console.log(info.skeleton.join('\n'));
  console.log('--- outerHTML(前1600) ---');
  console.log(info.firstCardHTML);

  await browser.disconnect();
  process.exit(0);
})();
