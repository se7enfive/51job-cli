import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { ensureDirs, cacheDir } from '../utils/store';
import { err, warn } from '../utils/output';
import { defaultUserDataDir, readState, writeState, clearState, isProcessAlive, isPortOpen, BrowserState } from './state';

export const EHIRE_HOME = 'https://ehire.51job.com';

/** 当前 URL 是否属于 ehire 业务域（登录态与业务主壳）；about:blank / 空 / 非法视为否 */
export function isEhireSiteUrl(url: string): boolean {
  if (!url || url === 'about:blank') {
    return false;
  }
  try {
    const u = new URL(url);
    return u.hostname === 'ehire.51job.com' || u.hostname.endsWith('.ehire.51job.com');
  } catch {
    return false;
  }
}

export function findChrome(): string | null {
  const env = process.env['CHROME_PATH'] || process.env['51JOB_CHROME'];
  if (env && fs.existsSync(env)) return env;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Chromium', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function findFreePort(): Promise<number> {
  // T307 备注：listen(0) 关闭后到 Chrome 绑定之间存在 TOCTOU 竞口窗口——
  // 极小概率被其他进程抢占；此时端口就绪检测会失败并走明确的报错路径，可接受。
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port')));
      }
    });
  });
}

/** 无头开关解析。导出供单元测试（T401）。 */
export function getHeadlessFlag(): boolean {
  // T401 变量统一：文档名为 RECRUIT_BROWSER_HEADLESS（原 RECRUIT_BROWSER_HIDDEN
  // 语义反直觉且与文档不符，兼容一个版本并提示迁移）。51JOB 专用名优先。
  const headless = process.env['51JOB_BROWSER_HEADLESS'] || process.env['RECRUIT_BROWSER_HEADLESS'] || '';
  const legacy = process.env['RECRUIT_BROWSER_HIDDEN'] || '';
  if (legacy) {
    warn('RECRUIT_BROWSER_HIDDEN 已更名为 RECRUIT_BROWSER_HEADLESS，请迁移配置（本版本仍兼容）');
    if (!headless) {
      return legacy === 'true' || legacy === '1';
    }
  }
  if (headless) {
    return headless === 'true' || headless === '1';
  }
  // 默认有头模式。无头 Chrome 的 UA 自报 HeadlessChrome 且 Client Hints 仍说 Google Chrome，
  // 自相矛盾会被平台风控识别为工具指纹（boss-cli 实测封号）。
  return false;
}

/**
 * 通过 DevTools HTTP 端点连接常驻浏览器（浏览器级连接）。
 * - defaultViewport: null：继承系统真实分辨率，避免 puppeteer 默认 800×600 的自动化指纹。
 * - 只连接不启动：不下载 Chrome、不新建用户目录，登录态保留在 user-data-dir。
 */
async function connectBrowser(port: number): Promise<Browser> {
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
    // T306 时序加固：SPA 刷新/级联弹窗渲染时主线程长任务可让 evaluate 排队，
    // 30s protocolTimeout 偶发误杀（2026-08-28 实测 residence 级联竞态）；提到 90s。
    protocolTimeout: 90_000,
  });
  return browser;
}

/**
 * 读取 pid 对应进程的命令行（T307）：用于确认该进程确属本工具拉起的 Chrome
 * （命令行包含我们的 user-data-dir），避免 state.json 被篡改/pid 被系统复用时误杀。
 * 读取失败返回空串（保守处理：不 kill）。
 */
function readProcessCommandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // wmic 在新 Windows 已弃用，走 PowerShell CIM
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { timeout: 5000 },
        (err, stdout) => resolve(err ? '' : String(stdout).trim()),
      );
      return;
    }
    execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }, (err, stdout) =>
      resolve(err ? '' : String(stdout).trim()),
    );
  });
}

/**
 * 获取一个已连接的可控浏览器。
 * - 若已有常驻实例（state.json 中 pid 存活 + 端口可连），复用之；
 * - pid 活但端口不通（Chrome 卡死/半死，T307）：确认进程身份后清理重启，避免
 *   同 user-data-dir 二次 spawn 撞 profile 锁导致永久卡死；
 * - 否则启动一个新的有头 Chrome（独立 user-data-dir），记录 state 供跨命令复用。
 */
export async function ensureBrowser(): Promise<Browser> {
  ensureDirs();

  const existing = readState();
  if (existing && isProcessAlive(existing.pid)) {
    if (await isPortOpen(existing.port)) {
      try {
        return await connectBrowser(existing.port);
      } catch {
        clearState();
      }
    } else {
      // T307 自愈：仅当命令行确认是我们拉起的浏览器时才 kill（防 pid 复用误杀），
      // 然后清 state 走正常 spawn；等待退出以释放 profile 锁。
      const cmdline = await readProcessCommandLine(existing.pid);
      if (cmdline && cmdline.includes(existing.userDataDir)) {
        warn(`常驻浏览器进程失联（pid ${existing.pid} 调试端口不通），正在清理后重启…`);
        try {
          process.kill(existing.pid);
        } catch {
          /* ignore */
        }
        for (let i = 0; i < 25 && isProcessAlive(existing.pid); i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
      } else if (cmdline) {
        warn(`state.json 中的 pid ${existing.pid} 非本工具的浏览器进程（疑似 pid 复用），已重置状态`);
      }
      clearState();
    }
  }

  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error(
      '未找到本机 Chrome/Chromium。请安装 Chrome 或通过环境变量 CHROME_PATH 指定浏览器可执行文件路径。'
    );
  }

  const userDataDir = defaultUserDataDir();
  const port = await findFreePort();
  const headless = getHeadlessFlag();

  // 启动参数层反检测（P0）：手动 spawn 天然不带 --enable-automation；
  // 补上禁用自动化控制特性 + 最大化窗口（有头模式避免 800×600 默认视口指纹）。
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    // 安全（T201）：不再带 --remote-allow-origins=* —— 该参数关闭 CDP WebSocket 的
    // Origin 校验，等于允许任意网页/进程接管已登录浏览器。puppeteer 的 WS 客户端
    // 不发送 Origin 头，Chrome 默认校验下仍可正常连接（实施记录已实测）。
    // 若未来某 Chrome 版本导致连接失败，回退方案是精确白名单而非通配符。
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--disable-blink-features=AutomationControlled',
  ];
  if (headless) {
    args.push('--headless=new');
  } else {
    args.push('--start-maximized');
  }

  // T307 归属问题，此处一并修正：浏览器是「常驻复用」设计（命令结束只断开连接不关进程）。
  // detached: true 让 Chrome 脱离当前进程组成为独立会话——命令结束后 CLI 进程退出不会连带
  // 把 Chrome 一并回收；否则 login 这类「人机分离」场景窗口会随命令返回瞬间关闭，
  // 用户来不及扫码。child.unref() 让 Chrome 不再持有本进程事件循环，CLI 命令可自然结束。
  const child = spawn(chromePath, args, { stdio: 'ignore', detached: true });
  child.unref();
  const pid = child.pid;

  if (!pid) {
    throw new Error('Chrome 启动失败');
  }

  // 等待调试端口就绪（最多 15s）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!(await isPortOpen(port))) {
    throw new Error(
      'Chrome 调试端口未就绪，启动失败。可能原因：user-data-dir 被其他 Chrome 实例锁定（profile 锁）、' +
        '调试端口被抢占，或浏览器可执行文件异常。可删除 ~/.51job-cli/state.json 及 .cache 目录后重试（登录态会丢失，需重新扫码）。',
    );
  }

  writeState({ pid, port, userDataDir, startedAt: new Date().toISOString() } as BrowserState);

  const browser = await connectBrowser(port);

  if (headless) {
    warn('当前以无头模式运行（51JOB_BROWSER_HEADLESS=true）。无头浏览器可能被平台风控识别，有封号风险，请谨慎使用。');
  }
  return browser;
}

/** 新开一个空白页并设置工作视口（1440×900） */
export async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  return page;
}

/** 关闭单个页面（不影响浏览器进程与登录态） */
export async function closePage(page: Page): Promise<void> {
  try {
    await page.close();
  } catch {
    // ignore
  }
}

/**
 * 断开与常驻浏览器的连接（浏览器进程保留，登录态保留）。
 * 命令结束调用；进程退出时连接也会自动断开，此函数用于显式释放。
 */
export async function detachBrowser(browser: Browser): Promise<void> {
  try {
    browser.disconnect();
  } catch {
    // ignore
  }
}

/**
 * 探测常驻浏览器是否以无头模式运行（读进程外真实状态：/json/version 的 UA）。
 * 不能依赖模块级变量——CLI 命令是独立一次性进程，刚起时引用必为空。
 */
export async function probeRemoteHeadless(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) return false;
    const data = (await res.json()) as { 'User-Agent'?: string };
    return /HeadlessChrome/i.test(data['User-Agent'] || '');
  } catch {
    return false;
  }
}

/**
 * login 必须可见（扫码/验证码）：若已有常驻实例是无头模式，先关闭，
 * 让下一条命令以有头重启（登录态在 user-data-dir，关掉不丢）。
 */
export async function ensureHeadfulForLogin(): Promise<void> {
  process.env['51JOB_BROWSER_HEADLESS'] = 'false';
  const state = readState();
  if (!state) return;
  if (isProcessAlive(state.pid) && (await isPortOpen(state.port))) {
    if (await probeRemoteHeadless(state.port)) {
      warn('检测到常驻浏览器为无头模式，登录需要可见窗口，正在关闭并以有头重启…');
      await shutdownBrowser();
    }
  }
}

/**
 * 优雅关闭常驻浏览器（仅 shutdown 命令调用；登录态保留在 user-data-dir）。
 */
export async function shutdownBrowser(): Promise<void> {
  const state = readState();
  if (!state) {
    err('没有正在运行的常驻浏览器实例');
    return;
  }
  if (isProcessAlive(state.pid)) {
    try {
      const browser = await connectBrowser(state.port);
      await browser.close();
    } catch {
      try {
        process.kill(state.pid);
      } catch {
        // ignore
      }
    }
  }
  clearState();
}
