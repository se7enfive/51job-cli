import type { Page } from 'puppeteer-core';
import { out, warn } from '../utils/output';
import { delay } from '../core/throttle';
import { selectors } from './selectors';

/**
 * 简历详情查看限制检测（2026-08-26 实测）。
 *
 * 背景：51job 人才望远镜推荐池连续查看简历详情会触发**会话级风控**——
 * 手动点第 4 个候选人时弹窗提示「不能查看了，限制了」，且触发后连第 1 个也被拦。
 * 因此批量 inspect 详情必须**识别该弹窗 → 立即熔断**，并把限制信息带回给编排层，
 * 避免盲目重试进一步升级风控。
 *
 * 用法：
 *   const limit = await detectViewLimit(page);
 *   if (limit) { ... 输出限制原因是 view_limit，非零退出，停手 ... }
 */

/** 简历详情查看限制结果 */
export interface ViewLimitInfo {
  /** 是否触发限制 */
  limited: boolean;
  /** 弹窗原文（前 500 字） */
  dialogText: string;
  /** 匹配到的限制特征 */
  matched?: string;
  /** 汇总说明（面向编排层的用户可读信息） */
  summary: string;
}

/** 「不能查看/限制/付费墙」弹窗特征文案（2026-08-26 实测：免费查看额度耗尽后的 Pro 升级引导） */
const VIEW_LIMIT_TEXT_PATTERNS: RegExp[] = [
  /不能查看/i,
  /无法查看/i,
  /查看.*限制/i,
  /限制.*查看/i,
  /不能再查看/,
  /查看次数/,
  /今日.*(查看|浏览).*(已满|已达|超过)/,
  /达到.*(查看|浏览).*上限/,
  /操作过于频繁/,
  /访问受限/,
  /暂不能/,
  /暂无法/,
  // 付费墙：升级/尊享/解锁 + 查看 组合（Pro 引导页文案实测）
  /升级.*(尊享|账号|套餐|会员)/i,
  /尊享.*(解锁|查看|权益)/i,
  /解锁.*无限.*查看/i,
  /无限.*查看.*(人才|简历|详情)/i,
  /¥\s?\d+\s?\/\s?(月|年)/,
  /高级.*账号/i,
  /套餐.*(查看|浏览)/i,
];

/** 探测当前页面是否有可见弹窗及其文案 */
async function probeVisibleDialog(page: Page): Promise<{ hasDialog: boolean; dialogText: string }> {
  return page
    .evaluate((s) => {
      const dls = Array.from(document.querySelectorAll<HTMLElement>(s.dialog)).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (dls.length === 0) return { hasDialog: false, dialogText: '' };
      // 取文本最长的那个弹窗（一般是主体）
      const main = dls.reduce((a, b) => {
        return (b.innerText || '').length > (a.innerText || '').length ? b : a;
      });
      return { hasDialog: true, dialogText: (main.innerText || '').slice(0, 500) };
    }, selectors.hiResult)
    .catch(() => ({ hasDialog: false, dialogText: '' }));
}

/**
 * 检测当前页面是否弹出「简历查看限制」提示。
 * 调用时机：打开详情前/后、或点击无反应时。
 * @returns 命中限制返回 ViewLimitInfo（含总结），否则 null
 */
export async function detectViewLimit(page: Page, opts: { waitMs?: number } = {}): Promise<ViewLimitInfo | null> {
  const waitMs = opts.waitMs ?? 0;
  if (waitMs > 0) await delay(waitMs);

  const p = await probeVisibleDialog(page);
  if (!p.hasDialog || !p.dialogText.trim()) return null;

  for (const re of VIEW_LIMIT_TEXT_PATTERNS) {
    if (re.test(p.dialogText)) {
      const summary = `51job 简历详情查看受限：${p.dialogText.trim().slice(0, 120)}` +
        `（未继续查看，避免风控升级；建议稍后再试或先停止批量 inspect）`;
      warn(summary);
      return {
        limited: true,
        dialogText: p.dialogText,
        matched: re.source,
        summary,
      };
    }
  }
  return null;
}