import type { Page } from 'puppeteer-core';
import { EHIRE_HOME } from '../core/browser';
import { assertNoRisk } from '../core/guard';
import { delay, Throttle } from '../core/throttle';
import { LIST_POLL_MS, LIST_MIN_BEFORE_EMPTY_OK_MS } from '../browser/human_delay';
import { sleepRandom } from '../browser/timing';
import { out, warn, Row } from '../utils/output';
import { selectors } from './selectors';

export interface Candidate {
  index: number;
  name: string;
  time?: string;
  unread?: boolean;
  snippet?: string;
  /** 画像：年龄/年限/学历/城市（.secondline .info-item，按序） */
  age?: string;
  years?: string;
  edu?: string;
  city?: string;
}

/**
 * 列表稳定轮询（移植 boss-cli waitForCandidateListSettled）：
 * 候选人卡片数量连续 2 次相同视为渲染稳定；空列表需等待
 * LIST_MIN_BEFORE_EMPTY_OK_MS（5s）才放行，避免抓半截。
 */
async function waitForListSettled(page: Page, itemSel: string, timeoutMs = 18_000): Promise<number> {
  const start = Date.now();
  let prev = -1;
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    const n = (await page.$$(itemSel).catch(() => [])).length;
    const elapsed = Date.now() - start;
    if (n === prev) {
      stable++;
    } else {
      prev = n;
      stable = 1;
    }
    if (stable >= 2) {
      if (n > 0) return n;
      if (elapsed >= LIST_MIN_BEFORE_EMPTY_OK_MS) return 0;
    }
    await sleepRandom(LIST_POLL_MS.min, LIST_POLL_MS.max);
  }
  return prev >= 0 ? prev : 0;
}

/** 等待候选人卡片稳定渲染后返回当前全部卡片。 */
async function collectCards(page: Page, itemSel: string) {
  await waitForListSettled(page, itemSel);
  return page.$$(itemSel).catch(() => []);
}

/**
 * 确保投递视图并返回投递卡片。
 * 视图兜底：若当前页面卡片不是投递卡（摘要无「投递了」），自动切回工作台首页
 * （EHIRE_HOME 重定向到 /Revision/navigate/ 投递列表）后重读。
 * list / chat 共用。
 */
export async function collectDeliveryCards(page: Page) {
  const s = selectors.inbox;
  let items = await collectCards(page, s.item);

  if (items.length > 0) {
    const firstText = await items[0]
      .evaluate((el) => (el.textContent || '').trim().slice(0, 40))
      .catch(() => '');
    if (firstText && !/投递了/.test(firstText)) {
      warn('当前不在投递视图，自动切回工作台首页…');
      await page.goto(EHIRE_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      items = await collectCards(page, s.item);
    }
  } else {
    // 0 卡兜底：上一条命令可能把页面停在人才管理等非工作台页面（如 chat 后）。
    // 回工作台首页重读一次；若仍为空则视为真空列表。
    const url = page.url();
    if (!/\/Revision\/navigate/.test(url)) {
      warn('当前页面无投递卡片，切回工作台首页重读…');
      await page.goto(EHIRE_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      items = await collectCards(page, s.item);
    }
  }
  return items;
}

/**
 * 收集「与 list 输出完全一致」的候选人序列（T105）：
 * 过滤非投递卡（摘要含「投递了」）+ 统一 1-based 编号。
 * readInbox（list 命令）与 openChat（chat --index）共用同一实现，
 * 保证 `list` 输出的 # 列与 `chat --index N` 定位的是同一个人。
 */
export async function collectInboxCandidates(
  page: Page,
  opts: { throttle?: Throttle } = {}
): Promise<Candidate[]> {
  await assertNoRisk(page, { action: '读取候选人列表', soft: true });

  if (opts.throttle) await opts.throttle.wait();

  const s = selectors.inbox;

  const items = await collectDeliveryCards(page);

  if (items.length === 0) {
    warn('未定位到候选人列表。请先确认已进入「收到简历/投递列表」页面，或运行 51job probe 校准选择器。');
    return [];
  }

  const candidates: Candidate[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const info = await item
      .evaluate((el, sel) => {
        const q = (s: string) => {
          const found = el.querySelector(s);
          return found ? (found.textContent || '').trim() : '';
        };
        return {
          name: q(sel.name) || q('[class*="name"]') || '',
          time: q(sel.time) || '',
          snippet: q(sel.snippet || '[class*="content"], [class*="msg"]') || '',
          attrs: Array.from(el.querySelectorAll(sel.infoItem))
            .map((e) => (e.textContent || '').trim())
            .filter(Boolean),
        };
      }, s)
      .catch(() => ({ name: '', time: '', snippet: '', attrs: [] }));

    const unread = await item
      .evaluate((el, sel) => {
        return !!el.querySelector(sel.unreadBadge) || (el.textContent || '').includes('未读');
      }, s)
      .catch(() => false);

    if (info.name) {
      // 只保留投递卡（投递视图摘要含「投递了」），过滤下方推荐人才/求职意向卡
      if (info.snippet && !/投递了/.test(info.snippet)) continue;
      const [age, years, edu, city] = info.attrs;
      candidates.push({
        index: candidates.length + 1,
        name: info.name,
        time: info.time,
        snippet: info.snippet,
        unread,
        age,
        years,
        edu,
        city,
      });
    }
  }
  return candidates;
}

/**
 * 读取候选人/投递列表（我的工作台投递视图）。
 * 序号口径见 collectInboxCandidates；--unread 在其结果上再过滤（编号保持原序号）。
 */
export async function readInbox(
  page: Page,
  opts: { unreadOnly?: boolean; throttle?: Throttle } = {}
): Promise<Candidate[]> {
  const candidates = await collectInboxCandidates(page, { throttle: opts.throttle });
  if (opts.unreadOnly) {
    return candidates.filter((c) => c.unread);
  }
  return candidates;
}

export function candidatesToRows(candidates: Candidate[]): Row[] {
  return candidates.map((c) => ({
    '#': c.index,
    姓名: c.name,
    时间: c.time || '',
    未读: c.unread ? '●' : '',
    画像: [c.age, c.years, c.edu, c.city].filter(Boolean).join('·') || '',
    摘要: (c.snippet || '').slice(0, 40),
  }));
}
