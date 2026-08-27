/**
 * 诊断：检查沟通面板输入框/发送按钮的可点击性，定位 send 失败原因。
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
    const desc = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 80),
        text: (el.textContent || '').trim().slice(0, 30),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        display: cs.display,
        visibility: cs.visibility,
        disabled: el.disabled === undefined ? null : el.disabled,
        contentEditable: el.isContentEditable,
        // 从中心点做 elementFromPoint 命中测试
        hitTest: (() => {
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const hit = document.elementFromPoint(cx, cy);
          return hit === el || el.contains(hit) ? 'self' : (hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 50)}` : 'none');
        })(),
      };
    };
    const inputs = [...document.querySelectorAll('.input-textarea_self, textarea')].map(desc);
    const sendBtns = [...document.querySelectorAll('.new-send-button, button')].filter((b) => /发\s*送|发送/.test(b.textContent || '')).map(desc);
    // 输入框附近的所有可点击元素（找真实可交互层）
    const near = [];
    const ta = document.querySelector('.input-textarea_self');
    if (ta) {
      let p = ta;
      for (let i = 0; i < 4 && p.parentElement; i++) {
        p = p.parentElement;
        near.push({ tag: p.tagName.toLowerCase(), cls: String(p.className).slice(0, 60) });
      }
    }
    return { url: location.href, inputs, sendBtns, near };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.disconnect();
  process.exit(0);
})();
