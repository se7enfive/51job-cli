import type { Browser, Page } from 'puppeteer-core';
import { EHIRE_HOME, ensureBrowser, newPage, isEhireSiteUrl } from './browser.js';
import {
  getPageRiskState,
  installBrowserPageGuards,
  installPageGuards,
} from './pageGuards.js';
import { withSessionLock } from './sessionLock.js';
import { CONTEXT_DESTROY_RETRY_MS } from '../browser/human_delay.js';
import { sleepRandom } from '../browser/timing.js';
import { out } from '../utils/output.js';

/**
 * 51job 主壳会话：选页（复用 ehire 页或新建）、安装守卫、确保落在 ehire 域、
 * 熔断检查，再执行回调。统一命令入口——所有业务命令都从这里过，
 * 保证每一条命令都自带完整反检测与风控熔断。
 *
 * 移植自 boss-cli 的 withBossSessionPage，站点判定由 `.menu-list` 主壳改为 ehire 域。
 */

/** 页面守卫熔断（风控页反弹 / 自刷新循环）导致的中止，与普通页面异常区分开。 */
export class PageRiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRiskError';
  }
}

/** 熔断后立刻停下：继续自动操作既拿不到正确页面，也会让风控进一步升级。 */
function assertNoPageRisk(page: Page): void {
  const risk = getPageRiskState(page);
  if (!risk) return;
  throw new PageRiskError(
    `${risk.message}\n处理方式：在浏览器中完成验证/重新登录，确认能正常停留在 51job 页面后再重试；` +
      `若确认无需拦截，可设 51JOB_BROWSER_ALLOW_RISK_NAV=1 让验证页直接渲染。`,
  );
}

async function pickExistingPage(browser: Browser): Promise<Page | null> {
  const pages = (await browser.pages()).filter((p) => !p.isClosed());
  if (pages.length === 0) return null;

  const urls = await Promise.all(
    pages.map((p) => {
      try {
        return p.url();
      } catch {
        return '';
      }
    }),
  );

  // 选最后一个 ehire tab（最新的，保留上次命令的操作状态如搜索结果）
  let ehire: Page | undefined;
  for (let i = pages.length - 1; i >= 0; i--) {
    const u = urls[i] ?? '';
    if (u.length > 0 && u !== 'about:blank' && isEhireSiteUrl(u)) {
      ehire = pages[i];
      break;
    }
  }
  if (ehire) return ehire;

  let nonBlank: Page | undefined;
  for (let i = pages.length - 1; i >= 0; i--) {
    const u = urls[i] ?? '';
    if (u.length > 0 && u !== 'about:blank') {
      nonBlank = pages[i];
      break;
    }
  }
  return nonBlank ?? null;
}

/** 确保当前页落在 ehire 域（登录态与业务都在此域；login.51job.com 不算主壳）。 */
async function ensureEhireUrl(page: Page): Promise<void> {
  let url = '';
  try {
    url = page.url();
  } catch {
    url = '';
  }
  if (url && url !== 'about:blank' && isEhireSiteUrl(url)) {
    return;
  }
  await page.goto(EHIRE_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

type SessionPageOptions = {
  /** 是否确保落在 ehire 域（login 命令传 false，由 openLoginPage 自己导航） */
  ensureEhireUrl?: boolean;
};

let browserRef: Browser | null = null;
let pageRef: Page | null = null;

export function getBrowserRef(): Browser | null {
  return browserRef;
}

export function getPageRef(): Page | null {
  return pageRef;
}

/** 当前会话中的额外打开的 tab（新开详情页等），不在主 pageRef 上。 */
let extraPages = new Set<Page>();

export function getExtraPages(): Page[] {
  return Array.from(extraPages).filter((p) => !p.isClosed());
}

/** 记录一个由业务代码打开的额外 tab（用于统一清理）。 */
export function trackExtraPage(page: Page): void {
  extraPages.add(page);
}

/** 从当前浏览器按 URL 关键字找一个已打开的 tab（跨 tab 切换上下文）。 */
export function findPageByUrl(browser: Browser, keyword: string): Promise<Page | null> {
  return browser
    .pages()
    .then((pages) => {
      for (const p of pages) {
        if (p.isClosed()) continue;
        try {
          if (p.url().includes(keyword)) return p;
        } catch {
          /* ignore */
        }
      }
      return null;
    })
    .catch(() => null);
}

/** 页面级监听器防重（withSessionPage 每次命令都会调用，避免重复挂载） */
const pageConsoleHandlers = new WeakSet<Page>();
const pageDialogHandlers = new WeakSet<Page>();

/**
 * 页面控制台日志转发：51JOB_PAGE_CONSOLE=1 开启后，把页面 console 消息
 * 转发到 CLI 输出（带 [page] 前缀），用于排查站点行为/守卫拦截效果。
 */
function installPageConsoleForward(page: Page): void {
  const enabled = process.env['51JOB_PAGE_CONSOLE'];
  if (enabled !== '1' && enabled !== 'true') return;
  if (pageConsoleHandlers.has(page)) return;
  pageConsoleHandlers.add(page);
  page.on('console', (msg) => {
    const text = msg.text();
    if (!text) return;
    out(`[page:${msg.type()}] ${text.slice(0, 300)}`);
  });
}

/**
 * 模态框自动处理：页面 confirm/alert 弹窗默认接受（51JOB_DIALOG_ACCEPT=false 改关闭）。
 * 防止弹窗挂起导致 puppeteer 操作永久阻塞。
 */
function installPageDialogAuto(page: Page): void {
  if (pageDialogHandlers.has(page)) return;
  pageDialogHandlers.add(page);
  page.on('dialog', async (d) => {
    const accept =
      process.env['51JOB_DIALOG_ACCEPT'] !== 'false' && process.env['51JOB_DIALOG_ACCEPT'] !== '0';
    const verb = accept ? '接受' : '关闭';
    out(`[dialog] 已自动${verb}: ${d.type()} ${d.message().slice(0, 80)}`);
    try {
      if (accept) {
        await d.accept();
      } else {
        await d.dismiss();
      }
    } catch {
      // 弹窗已被页面关闭，忽略
    }
  });
}

/**
 * 在已连接浏览器、且当前页处于 ehire 域的前提下执行回调。
 * 默认先按 URL 确保落在 ehire.51job.com，再装守卫、做熔断检查；
 * 页面执行上下文被销毁（跳转/重渲染）时短暂等待后重试一次。
 */
export async function withSessionPage<T>(
  callback: (page: Page) => Promise<T>,
  options: SessionPageOptions = {},
): Promise<T> {
  const shouldEnsureEhireUrl = options.ensureEhireUrl !== false;

  return withSessionLock(async () => {
    const isContextDestroyed = (e: unknown): boolean => {
      const msg = e instanceof Error ? e.message : String(e);
      return (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Cannot find context with specified id') ||
        msg.includes('Most likely because of a navigation')
      );
    };

    // T108 重试边界：只有「进入回调之前」的 setup 阶段（起浏览器/选页/装守卫/导航/
    // 熔断检查）才允许因 context destroyed 重试。回调可能已执行对外写操作
    // （send/greet/action），整体重跑 = 重复发消息/重复点击，绝不自动重试。
    const maxAttempts = 2;
    let page: Page | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        browserRef = await ensureBrowser();
        page = pageRef;
        if (!page || page.isClosed()) {
          page = (await pickExistingPage(browserRef)) ?? (await newPage(browserRef));
        }
        pageRef = page;
        await page.bringToFront();

        await installBrowserPageGuards(browserRef);
        await installPageGuards(page);
        installPageConsoleForward(page);
        installPageDialogAuto(page);

        if (shouldEnsureEhireUrl) {
          await ensureEhireUrl(page);
        }
        assertNoPageRisk(page);
        break;
      } catch (e) {
        // 守卫熔断时，把「上下文被销毁」这类次生错误换成风控原因，并且不再重试。
        if (page && !(e instanceof PageRiskError)) {
          assertNoPageRisk(page);
        }
        if (attempt < maxAttempts - 1 && isContextDestroyed(e)) {
          await sleepRandom(CONTEXT_DESTROY_RETRY_MS.min, CONTEXT_DESTROY_RETRY_MS.max);
          continue;
        }
        throw e;
      }
    }

    // 回调错误不重试（T108）：写操作可能已生效。仍做一次风控检查，
    // 把「回调期间跳到风控页」的次生错误换成风控原因后抛出。
    try {
      return await callback(page!);
    } catch (e) {
      if (page && !(e instanceof PageRiskError)) {
        assertNoPageRisk(page);
      }
      throw e;
    }
  });
}

/**
 * 命令结束：断开与浏览器的连接（浏览器进程与登录态保留，供下一条命令复用）。
 * 与 shutdown 的「真关闭」语义区分。
 */
export async function detachBrowserSession(): Promise<void> {
  // 清理业务打开的额外 tab（不影响主 pageRef）
  for (const p of getExtraPages()) {
    try {
      if (!p.isClosed()) await p.close();
    } catch {
      // ignore
    }
  }
  extraPages.clear();
  if (browserRef) {
    try {
      browserRef.disconnect();
    } catch {
      // ignore
    }
    browserRef = null;
    pageRef = null;
  }
}
