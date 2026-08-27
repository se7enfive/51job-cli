/**
 * 诊断：从投递列表点开候选人卡片，抓沟通/聊天面板的 DOM 结构。
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

  // 确保在投递视图
  await target.goto('https://ehire.51job.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3000));

  // 点第一张投递卡（简历区）
  const clicked = await target.evaluate(() => {
    const card = document.querySelector('.resume-card');
    if (!card) return false;
    card.click();
    return true;
  });
  console.log('点击卡片:', clicked ? '是' : '否');
  await new Promise((r) => setTimeout(r, 3500));

  const info = await target.evaluate(() => {
    const res = { url: location.href, title: document.title };
    // 输入框
    res.inputs = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]'))
      .slice(0, 8)
      .map((el) => {
        const cls = typeof el.className === 'string' ? el.className : '';
        return `<${el.tagName.toLowerCase()}${cls ? ' class="' + cls.slice(0, 60) + '"' : ''} ph="${(el.getAttribute('placeholder') || '').slice(0, 20)}">`;
      });
    // 发送按钮
    res.sendBtns = Array.from(document.querySelectorAll('button, [class*="send"]'))
      .filter((el) => {
        const t = (el.textContent || '').trim();
        return t === '发送' || (typeof el.className === 'string' && /send/i.test(el.className));
      })
      .slice(0, 5)
      .map((el) => `<${el.tagName.toLowerCase()} class="${(typeof el.className === 'string' ? el.className : '').slice(0, 60)}"> ${(el.textContent || '').trim().slice(0, 10)}`);
    // 会话/消息元素
    res.msgEls = Array.from(document.querySelectorAll('[class*="message"], [class*="chat"], [class*="dialog"], [class*="detail"]'))
      .slice(0, 10)
      .map((el) => {
        const cls = typeof el.className === 'string' ? el.className : '';
        return `<${el.tagName.toLowerCase()} class="${cls.slice(0, 70)}">`;
      });
    return res;
  });

  console.log('URL:', info.url);
  console.log('标题:', info.title);
  console.log('--- 输入框 ---');
  info.inputs.forEach((i) => console.log(' ', i));
  console.log('--- 发送按钮 ---');
  info.sendBtns.forEach((i) => console.log(' ', i));
  console.log('--- 消息/会话容器 ---');
  info.msgEls.forEach((i) => console.log(' ', i));

  await target.goto(origUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('已恢复:', origUrl);
  await browser.disconnect();
  process.exit(0);
})();
