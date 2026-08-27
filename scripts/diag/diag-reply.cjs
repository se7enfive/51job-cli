/**
 * 验证：人才管理页点「回复」→ 抓聊天面板结构（输入框/发送按钮）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // 1. 找到包含「回复」按钮的候选人区块，记录候选人姓名，点击回复
  const who = await target.evaluate(() => {
    const btn = document.querySelector('button.tm_button');
    if (!btn) return null;
    // 找所在行的姓名（向上找容器）
    let row = btn.closest('[class*="item"], [class*="card"], [class*="row"], li, tr');
    const name = row ? (row.textContent || '').trim().slice(0, 60) : '';
    btn.click();
    return name;
  });
  console.log('点击回复，所在行:', who);
  await sleep(3500);

  // 2. 抓聊天面板状态
  const info = await target.evaluate(() => {
    const brief = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        cls: String(el.className).slice(0, 50),
        rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        visible: r.width > 0 && r.height > 0,
      };
    };
    // 可见输入框
    const input = [...document.querySelectorAll('.input-textarea_self, [contenteditable="true"], textarea')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0;
    });
    const inputInfo = input
      ? {
          tag: input.tagName.toLowerCase(),
          cls: String(input.className).slice(0, 50),
          ph: (input.getAttribute('placeholder') || '').slice(0, 40),
          rect: (() => { const r = input.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
        }
      : null;
    // 可见发送按钮
    const sendBtn = [...document.querySelectorAll('.new-send-button, button')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && /发送/.test((el.textContent || '').trim());
    });
    const sendInfo = sendBtn
      ? {
          tag: sendBtn.tagName.toLowerCase(),
          cls: String(sendBtn.className).slice(0, 60),
          rect: (() => { const r = sendBtn.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
        }
      : null;
    return {
      wrapper: brief('.im-sdk-box .wrapper'),
      chatArea: brief('.chatting-area'),
      convSection: brief('.conversation-list-section'),
      visibleDialog: [...document.querySelectorAll('.el-dialog__wrapper')].filter((d) => d.getBoundingClientRect().width > 0).map((d) => String(d.className).slice(0, 50)),
      input: inputInfo,
      sendBtn: sendInfo,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.disconnect();
  process.exit(0);
})();
