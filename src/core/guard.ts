import type { Page } from 'puppeteer-core';
import { warn, fail } from '../utils/output';
const RISK_URL_PATTERNS: RegExp[] = [
  /verify/i,
  /captcha/i,
  /risk/i,
  /security/i,
  /checkcode/i,
  /safeguard/i,
  /blocked/i,
];

const RISK_TEXT_PATTERNS: RegExp[] = [
  /安全验证/i,
  /验证码/i,
  /滑动验证/i,
  /异常行为/i,
  /访问受限/i,
  /账号异常/i,
  /风控/i,
  /操作过于频繁/i,
  /检测到.*辅助工具/i,
  /第三方.*软件.*检测/i,
  /请稍后再试/i,
];

export interface RiskCheckResult {
  isRisk: boolean;
  url: string;
  matchedUrl?: string;
  matchedText?: string;
}

/**
 * 检测当前页面是否命中风控/验证码特征。
 * 只读检查，不做任何页面操作。
 */
export async function checkRisk(page: Page): Promise<RiskCheckResult> {
  const url = page.url();

  for (const pattern of RISK_URL_PATTERNS) {
    if (pattern.test(url)) {
      return { isRisk: true, url, matchedUrl: pattern.source };
    }
  }

  try {
    const bodyText = await page.evaluate(() => {
      const el = document.body;
      return el ? el.innerText.slice(0, 3000) : '';
    });
    for (const pattern of RISK_TEXT_PATTERNS) {
      if (pattern.test(bodyText)) {
        return { isRisk: true, url, matchedText: pattern.source };
      }
    }
  } catch {
    // 页面可能正在跳转，忽略读取失败
  }

  return { isRisk: false, url };
}

/**
 * 在执行关键操作前调用：命中风控立即熔断（输出警告并退出），防止账号受损。
 * soft=true 时只输出警告不退出（供只读命令使用）。
 */
export async function assertNoRisk(page: Page, opts: { soft?: boolean; action?: string } = {}): Promise<void> {
  const result = await checkRisk(page);
  if (!result.isRisk) return;

  const action = opts.action || '当前操作';
  const why = result.matchedUrl ? `URL 特征: ${result.matchedUrl}` : `页面特征: ${result.matchedText}`;
  warn(`检测到风控/验证页面（${why}），${action}已中止`);
  warn(`页面地址: ${result.url}`);
  warn('建议: 停止批量操作，手动在浏览器中完成验证后再继续。');

  if (!opts.soft) {
    fail('风控熔断: 为避免账号风险，命令已停止');
  }
}
