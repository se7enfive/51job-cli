/**
 * 诊断：检查各标签页 URL / 标题 / 登录态特征，用于 wait-login 判定校准。
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
  for (const p of pages) {
    let url = '';
    let title = '';
    let markers = {};
    try {
      url = p.url();
      title = await p.title();
      markers = await p.evaluate(() => {
        const dash = document.querySelector('[class*="dashboard"], [class*="home"], [class*="index"]');
        const resumeCard = document.querySelector('.resume-card');
        const loginForm = document.querySelector('[class*="qrcode"], [class*="qr-code"], [class*="login"]');
        return {
          hasDashboard: !!dash,
          dashboardCls: dash ? String(dash.className).slice(0, 60) : null,
          hasResumeCard: !!resumeCard,
          hasLoginForm: !!loginForm,
          loginFormCls: loginForm ? String(loginForm.className).slice(0, 60) : null,
        };
      });
    } catch (e) {
      markers = { error: String(e).slice(0, 120) };
    }
    console.log(JSON.stringify({ url, title, ...markers }, null, 2));
    console.log('---');
  }
  await browser.disconnect();
  process.exit(0);
})();
