/**
 * 诊断：检查聊天容器链可见性 + 弹窗层级，确认可见面板与输入框实例。
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
    const brief = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        cls: String(el.className).slice(0, 60),
        rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        display: cs.display,
        visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
      };
    };
    // 1. 所有 input-textarea_self 实例
    const inputs = [...document.querySelectorAll('.input-textarea_self')].map(brief);
    // 2. 所有 new-send-button 实例
    const sends = [...document.querySelectorAll('.new-send-button')].map(brief);
    // 3. 容器链
    const chain = [...document.querySelectorAll('.chatting-area, .im-chat-panel, .chat-send, .chat-edit')].map(brief);
    // 4. 弹窗
    const dialogs = [...document.querySelectorAll('.el-dialog__wrapper')].map((d) => {
      const b = brief(d);
      b.zIndex = getComputedStyle(d).zIndex;
      b.dialogCls = d.querySelector('.el-dialog') ? String(d.querySelector('.el-dialog').className).slice(0, 60) : null;
      b.title = (d.querySelector('.el-dialog__title, .el-dialog__header') || {}).textContent || '';
      return b;
    });
    // 5. iframe 列表
    const iframes = [...document.querySelectorAll('iframe')].map((f) => ({ src: (f.src || '').slice(0, 100), ...brief(f) }));
    return { url: location.href, inputs, sends, chain, dialogs, iframes };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.disconnect();
  process.exit(0);
})();
