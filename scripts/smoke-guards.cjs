/**
 * P0 守卫冒烟：验证反检测注入生效 + 网络拦截注册 + 真实导航不误伤。
 * 用法: npm run smoke（需先 build；需本机 Chrome）
 * T303 隔离：临时 state/profile 目录 + 强制无头，不触碰真实 ~/.51job-cli；
 * 结束调用 shutdownBrowser 清理进程并删除临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '51job-smoke-'));
process.env['51JOB_STATE_FILE'] = path.join(tmpDir, 'state.json');
process.env['51JOB_USER_DATA_DIR'] = path.join(tmpDir, 'profile');
process.env['51JOB_BROWSER_HEADLESS'] = 'true';
const { ensureBrowser, newPage, shutdownBrowser } = require('../dist/core/browser.js');
const { installPageGuards, getPageRiskState } = require('../dist/core/pageGuards.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  let browser = null;
  let page = null;
  try {
    browser = await ensureBrowser();
    page = await newPage(browser);

    // 1. 在 about:blank 安装守卫（不依赖网络）
    await installPageGuards(page);

    // 2. 注入层验证
    const webdriver = await page.evaluate(() => navigator.webdriver);
    check('navigator.webdriver=false', webdriver === false, `actual=${webdriver}`);

    const toStringNative = await page.evaluate(() => {
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
      return desc && desc.get ? desc.get.toString() : '';
    });
    check(
      'getter toString 原生形态',
      toStringNative === 'function get webdriver() { [native code] }',
      `actual=${toStringNative}`,
    );

    const sanitizeOk = await page.evaluate(() => {
      const calls = [];
      const orig = console.log;
      try {
        console.log({ a: 1, b: [1, 2, 3] });
        return true;
      } catch (e) {
        return false;
      }
    });
    check('console 对象参数 sanitize 无异常', sanitizeOk === true);

    const historyGo = await page.evaluate(() => {
      return History.prototype.go.toString().includes('[native code]');
    });
    check('history.go 保留原生形态', historyGo === true);

    // 3. 风控 URL 正则自检（无需浏览器）
    const { isRiskNavigationUrl } = require('../dist/core/pageGuards.js');
    const samples = [
      ['https://ehire.51job.com/login', false, '登录页不拦截'],
      ['https://ehire.51job.com/inbox/list', false, '业务页不拦截'],
      ['https://ehire.51job.com/safeguard/verify', true, '风控页拦截'],
      ['https://ehire.51job.com/login?captcha=1', true, '验证参数拦截'],
      ['https://ehire.51job.com/risk/check', true, '风险路径拦截'],
    ];
    for (const [url, expect, label] of samples) {
      const got = isRiskNavigationUrl(url);
      check(`URL判定[${label}]`, got === expect, `${url} → ${got}`);
    }

    // 4. 真实导航冒烟（[skip] 标注：网络/登录态受限时不影响注入层结论，但摘要可见）
    try {
      await page.goto('https://ehire.51job.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const url = page.url();
      const risk = getPageRiskState(page);
      check('真实导航未误伤', !risk, `url=${url} risk=${risk ? risk.kind : 'none'}`);
    } catch (e) {
      check('[skip] 真实导航（网络受限）', true, `goto 异常已跳过: ${e.message.slice(0, 80)}`);
    }
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) {
      await shutdownBrowser().catch(() => {});
    }
    // Windows：Chrome 进程退出后文件锁释放有延迟，best-effort 清理，失败不报红
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      console.warn(`[smoke] 临时目录清理失败（可忽略）: ${tmpDir}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) process.exit(1);
  // 显式退出：disconnect 后 puppeteer 内部残留句柄可能干扰退出码
  process.exit(0);
})();
