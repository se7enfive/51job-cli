import type { Page } from 'puppeteer-core';
import { EHIRE_HOME } from '../core/browser';
import { checkRisk } from '../core/guard';
import { delay } from '../core/throttle';
import { out, err, warn } from '../utils/output';
import { selectors } from './selectors';

// 登录页域名：停留在此域 = 未登录。注意 ehire.51job.com 本身就是登录后的工作台域，
// 登录成功后 URL 仍停留在 ehire 域，因此不能把 ehire 前缀整体视为未登录。
const LOGIN_URL_PREFIX = 'https://login.51job.com/';
const EHIRE_ROOT = 'https://ehire.51job.com';

/**
 * 检测当前会话是否已登录 ehire。
 * 依据：URL 不在登录域 + 页面出现工作台特征（dashboard 标志 / 投递卡 / 工作台标题）。
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.startsWith(LOGIN_URL_PREFIX)) return false;
  // 停在 ehire 根路径（无任何路由），通常是登录跳转前的中转态
  if (url === EHIRE_ROOT || url === `${EHIRE_ROOT}/`) return false;
  if (!url.startsWith(EHIRE_ROOT)) return false;

  try {
    if (await page.$(selectors.loginSuccess.dashboard)) return true;
    // 工作台特征：投递候选人卡片
    if (await page.$(selectors.inbox.item)) return true;
    const title = await page.title();
    if (/工作台|首页/.test(title)) return true;
  } catch {
    // ignore
  }
  return false;
}

export interface LoginResult {
  ok: boolean;
  url: string;
  waitedSeconds: number;
}

/**
 * 打开 ehire 首页（未登录会自动跳转登录域）。
 * 只负责开页，不等待/不轮询登录结果——登录分离模式：
 * login 命令立即返回，由 wait-login 命令（或 Agent 调用方自行判断）负责等待。
 */
export async function openLoginPage(page: Page): Promise<void> {
  await page.goto(EHIRE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
  out(`已打开 ${EHIRE_HOME}`);
  out('请在浏览器窗口中完成登录（微信扫码 / 手机验证码）。');
}

/**
 * 轮询等待登录完成（配合 login 的分离模式使用）。
 * 超时（默认 300s）后仍失败则提示手动确认。
 */
export async function waitForLogin(page: Page, opts: { timeoutSec?: number } = {}): Promise<LoginResult> {
  const timeoutSec = opts.timeoutSec ?? 300;
  const start = Date.now();
  out('等待登录完成…');

  while (Date.now() - start < timeoutSec * 1000) {
    const risk = await checkRisk(page);
    if (risk.isRisk) {
      warn('登录页出现风控/验证特征，请手动完成验证。');
    }

    if (await isLoggedIn(page)) {
      const waited = Math.round((Date.now() - start) / 1000);
      out(`登录成功（等待 ${waited}s），当前页面: ${page.url()}`);
      return { ok: true, url: page.url(), waitedSeconds: waited };
    }
    await delay(2000);
  }

  err(`等待登录超时（${timeoutSec}s）。请确认浏览器中已完成登录后重新运行命令。`);
  return { ok: false, url: page.url(), waitedSeconds: Math.round((Date.now() - start) / 1000) };
}

/**
 * 完整登录流程（兼容旧调用）：开页 + 等待。
 * 新命令入口建议用 login（分离）+ wait-login（轮询）两步。
 */
export async function doLogin(page: Page, opts: { timeoutSec?: number } = {}): Promise<LoginResult> {
  await openLoginPage(page);
  return waitForLogin(page, opts);
}
