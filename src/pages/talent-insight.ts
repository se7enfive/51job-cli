import type { Browser, Page, Target } from 'puppeteer-core';
import { assertNoRisk } from '../core/guard';
import { delay, Throttle } from '../core/throttle';
import { out, warn } from '../utils/output';
import { selectors } from './selectors';
import { readCandidateDetail, CandidateDetail } from './candidate-detail';
import { humanPauseBeforeDetail, mouseMoveHuman } from '../browser/human_delay';
import { detectViewLimit, ViewLimitInfo } from './view-limit';

/**
 * 人才管理页候选人详情提取（投递/聊天来源候选人的「在线简历」正门）。
 *
 * 背景（2026-08-26 皇帝拍板）：inspect/greet 走「人才搜索池」定位，只覆盖主动搜索到的候选人；
 * 而 **主动投递 / 聊天来** 的候选人（工作台投递卡 + 人才管理页行）不在搜索池里，inspect 找不到。
 * 人才管理页（/Revision/talent/management）的候选人行 = 唯一覆盖双来源的入口：
 *   人才管理页 → 定位行（.name 匹配）→ 点名卡片区域 → 新开 tab 详情页（/Revision/talent/resume/detail）
 *   → readCandidateDetail 提取结构化简历（技能/经历/教育）→ 可直接 --hi。
 *
 * DOM 结构（2026-08-26 实测）：行内以「回复」按钮（button.tm_button）为锚，向上找含 .name 的行容器；
 * 点行内 .name（或行容器任意可点区域）即新开详情 tab（与搜索卡片行为一致）。
 */

interface TalentRow {
  name: string;
}

/** 人机模拟：开详情前随机 5-15 秒停留（含随机滚动）。 */
async function sleepRandomInspect(page: Page): Promise<void> {
  await humanPauseBeforeDetail(page);
}

/** 人才管理页 URL（与 chat.ts 相同） */
const TALENT_MANAGEMENT_URL = 'https://ehire.51job.com/Revision/talent/management';

/** 收集人才管理页候选人行（以「回复」按钮为锚，向上找含 .name 的行容器）。 */
export async function collectTalentRows(page: Page): Promise<TalentRow[]> {
  return page
    .evaluate((btnSel, nameSel) => {
      const rows: { name: string }[] = [];
      for (const btn of Array.from(document.querySelectorAll(btnSel))) {
        let row: HTMLElement | null = btn.parentElement;
        for (let k = 0; k < 8 && row; k++) {
          if (row.querySelector(nameSel)) break;
          row = row.parentElement;
        }
        const nameEl = row ? row.querySelector(nameSel) : null;
        rows.push({ name: nameEl ? (nameEl.textContent || '').trim() : '' });
      }
      return rows;
    }, selectors.talentMgmt.replyBtn, selectors.talentMgmt.name)
    .catch(() => [] as TalentRow[]);
}

/** 姓名匹配（非严格 = 包含即算；严格 = 精确相等） */
function matchRowIndex(rows: TalentRow[], name: string, strict?: boolean): number {
  for (let i = 0; i < rows.length; i++) {
    const n = rows[i].name;
    if (!n) continue;
    if (strict ? n === name : n.includes(name)) return i;
  }
  return -1;
}

/** 确保当前页面在人才管理页（不在则导航过去）。返回是否就绪。 */
export async function ensureTalentMgmt(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes('/talent/management')) {
    out('导航到人才管理页…');
    await page.goto(TALENT_MANAGEMENT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await delay(1500 + Math.random() * 1000);
  } else {
    out('已在人才管理页');
  }
  return true;
}

/**
 * 在人才管理页按姓名定位候选人行（含懒加载滚动，最多 10 轮）。
 * @returns 行序号（0-based）或 -1
 */
export async function locateTalentRow(page: Page, name: string, opts: { strict?: boolean; throttle?: Throttle } = {}): Promise<number> {
  let rows = await collectTalentRows(page);
  let idx = matchRowIndex(rows, name, opts.strict);
  let round = 0;
  // 列表为内层容器懒加载——window 滚动无效，需滚动 main_container
  while (idx < 0 && round < 10) {
    await page
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('div, section, main'))) {
          if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
            el.scrollTop = el.scrollHeight;
          }
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
      })
      .catch(() => {});
    await delay(1000 + Math.random() * 700);
    rows = await collectTalentRows(page);
    idx = matchRowIndex(rows, name, opts.strict);
    round++;
  }
  if (idx < 0) {
    warn(`未在人才管理列表中找到「${name}」（共 ${rows.length} 行）。可能需要翻页或调整筛选。`);
    return -1;
  }
  return idx;
}

/**
 * 打开人才管理页候选人的详情（新 tab）并提取结构化简历。
 * @returns { page: 详情页, detail: CandidateDetail }，失败返回 null
 */
export async function openTalentMgmtDetail(
  browser: Browser,
  page: Page,
  name: string,
  opts: { strict?: boolean; throttle?: Throttle } = {}
): Promise<{ page: Page; detail: CandidateDetail } | null> {
  await assertNoRisk(page, { action: `打开人才管理页「${name}」详情`, soft: false });
  if (opts.throttle) await opts.throttle.wait();

  // 1. 确保在人才管理页
  await ensureTalentMgmt(page);

  // 2. 定位行（懒加载滚动定位）
  const idx = await locateTalentRow(page, name, opts);
  if (idx < 0) return null;

  // 3. 取该行「回复」按钮所在的完整行容器，点击行内姓名区域打开详情
  const buttons = await page.$$(selectors.talentMgmt.replyBtn).catch(() => []);
  const replyBtn = buttons[idx];
  if (!replyBtn) {
    warn('回复按钮定位失败，页面可能已刷新。');
    return null;
  }
  // 行容器 = 按钮向上第 2 层（避免 .name 祖先层级差异，直接取按钮行）
  const rowH = await replyBtn.evaluate((btn) => {
    let el: HTMLElement | null = btn as HTMLElement;
    for (let k = 0; k < 8 && el; k++) {
      if (el.querySelector('.name')) break;
      el = el.parentElement;
    }
    return el;
  }).catch(() => null);

  // 4. 监听新 tab（先挂监听再点击）
  const newTargetP = new Promise<Target | null>((resolve) => {
    const handler = (t: Target) => {
      if (t.type() === 'page') {
        browser.off('targetcreated', handler);
        resolve(t);
      }
    };
    browser.on('targetcreated', handler);
    setTimeout(() => {
      browser.off('targetcreated', handler);
      resolve(null);
    }, 10000);
  });

  // 5. 点击行内姓名（详情入口；同搜索卡片行为：点击新开 tab 到简历详情）
  const clicked = await replyBtn
    .evaluate((el, nameSel) => {
      const row = el.parentElement;
      let target: HTMLElement | null = null;
      if (row) {
        const nm = row.querySelector<HTMLElement>(nameSel);
        target = nm || (row as HTMLElement);
      }
      if (target) {
        target.click();
        return true;
      }
      return false;
    }, selectors.talentMgmt.name)
    .catch(() => false);
  if (!clicked) {
    warn('人才管理行点击失败，无法打开详情。');
    return null;
  }
  out(`已点击「${name}」行，等待简历详情页…`);

  // 6. 等新 tab 并读取
  const target = await newTargetP;
  if (!target) {
    // T107：与 openDetailByIndex 同语义——无新 tab 判失败，不把人才管理页当详情页空读
    warn('未捕获到新 tab（10s）：站点可能未新开详情页，详情提取失败');
    return null;
  }
  const detailPage = (await target.page()) || page;
  if (detailPage === page) {
    warn('新 tab 目标无效，详情提取失败');
    return null;
  }
  await detailPage.bringToFront().catch(() => {});
  await delay(1800 + Math.random() * 800);

  if (opts.throttle) await opts.throttle.wait();
  const detail = await readCandidateDetail(detailPage, { throttle: opts.throttle });
  return { page: detailPage, detail };
}

/**
 * 人才管理详情页的「回复」动作（投递/聊天来源候选人的联系入口，免费不耗点数）。
 *
 * 与搜索来源的「立即Hi聊」不同：详情页 `.btn_item_chat`/`.chat_btn` 的按钮文本是「回复」，
 * 点击后在人才管理页右侧展开沟通面板（chat.ts openChat 同款），不是 Hi 点数动作。
 * 因此这里的「点击成功」判定不能套 hi-result 的「按钮文案 ≠ 立即Hi聊」逻辑——
 * 「回复」永远 ≠ 「立即Hi聊」。正确判定：点击后沟通面板输入框出现（可见输入框）。
 *
 * @param page 当前页（详情页）
 * @returns 'success' | 'failed' | 'already'（无回复按钮）
 */
export async function replyOnDetail(page: Page, opts: { throttle?: Throttle } = {}): Promise<'success' | 'failed' | 'none'> {
  await assertNoRisk(page, { action: '人才管理详情页回复', soft: false });
  if (opts.throttle) await opts.throttle.wait();

  // 1. 找「回复」按钮（.btn_item_chat 含「回复 0」徽标；.chat_btn 是 tooltip 包裹）
  const btnSel = selectors.candidateDetail.hiChatBtn; // .chat_btn, .btn_item_chat —— 在人才详情页是「回复」
  const btns = await page.$$(btnSel).catch(() => []);
  // 过滤可见
  let target: import('puppeteer-core').ElementHandle<Element> | null = null;
  for (const b of btns) {
    const box = await b.boundingBox().catch(() => null);
    if (box && box.width > 8 && box.height > 8) {
      const t = await b.evaluate((el) => (el.textContent || '').trim()).catch(() => '');
      // 投递来源详情页按钮文本是「回复」；搜索来源是「立即Hi聊」——本函数只服务前者
      if (t.includes('回复')) { target = b; break; }
    }
  }
  if (!target) {
    warn('未找到「回复」按钮（可能已回复过或详情页结构变化）');
    return 'none';
  }

  // 2. 点击
  const h = target as import('puppeteer-core').ElementHandle<Element>;
  await h.scrollIntoView().catch(() => {});
  await delay(300 + Math.random() * 300);
  await h.click().catch(() => {});
  out('已点击详情页「回复」，等待沟通面板…');

  // 3. 校验：详情页点击回复后，右侧/下方应出现可见输入框（.input-textarea_self）
  await delay(1200 + Math.random() * 600);
  const input = await page.evaluate((sel) => {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }, selectors.chat.messageInput).catch(() => false);

  if (input) {
    out('「回复」面板已展开（可见输入框）');
    return 'success';
  }
  warn('点击「回复」后未见沟通面板输入框，可能已打开或需人工确认');
  return 'failed';
}

/**
 * 通用：点击卡片列表第 index 张卡片 → 捕获新 tab → 提取结构化简历。
 * 支持任意卡片选择器（搜索池 .list-box .resume-card / 推荐池 .item.resume-card），
 *
 * 2026-08-26 修复（皇帝拍板 A+B）：
 *   1. 点击前随机 5-15 秒停留 + 随机鼠标轨迹 + 查看受限弹窗熔断（view_limit）。
 *   2. 新详情页用「轮询 browser.pages() + URL 基线」找，不依赖 targetcreated 事件。
 *   3. 打开后与卡片姓名交叉校验；**错位重试有上限（_retry，默认 0 即不重试）**，
 *      避免「详情页姓名读空 → 误判错位 → 无限递归」死锁（2026-08-26 实测卡死 5 分钟）。
 *
 * @param cardSelector 卡片列表选择器（如 '.item.resume-card'）
 * @param opts.verifyName  期望的卡片姓名（用于校验与重定位）
 * @param opts._retry      内部重试计数（外部勿传）
 */
export type OpenCardResult =
  | { page: Page; detail: CandidateDetail }
  | { page: null; detail: null; viewLimited: ViewLimitInfo };

export async function openCardDetail(
  browser: Browser,
  page: Page,
  index: number,
  cardSelector: string,
  opts: { throttle?: Throttle; verifyName?: string; _retry?: number } = {}
): Promise<OpenCardResult | null> {
  await assertNoRisk(page, { action: `打开第 ${index} 张卡片详情`, soft: false });
  if (opts.throttle) await opts.throttle.wait();

  // 关键修复（2026-08-26）：每次打开前确保当前页是推荐列表页。
  // 如果上一个详情页关闭后列表页被 SPA 重渲染/失效，必须回到推荐页重读，否则点卡无效。
  if (!page.url().includes('/Revision/talent/search-recommend')) {
    out('列表页已失效，重新导航到推荐页…');
    await page.goto(selectors.recommend.url, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
    await delay(1500 + Math.random() * 1000);
  }

  // 等到卡片 DOM 就绪（SPA 重渲染后可能暂时为空）
  let cards = await page.$$(cardSelector).catch(() => []);
  let waitRound = 0;
  while ((cards.length < index || (opts.verifyName && cards.length === 0)) && waitRound < 8) {
    await delay(600 + Math.random() * 400);
    await page.bringToFront().catch(() => {});
    cards = await page.$$(cardSelector).catch(() => []);
    waitRound++;
  }
  if (cards.length === 0) {
    warn(`推荐列表为空（等待重试 ${waitRound} 轮仍无卡片）`);
    return null;
  }

  // 目标卡片：优先按姓名锁定（verifyName），否则序号
  let cardIndex = index - 1;
  if (opts.verifyName) {
    let found = -1;
    for (let i = 0; i < cards.length; i++) {
      const t = await cards[i]
        .evaluate((el, sel) => {
          const f = el.querySelector(sel.name);
          return f ? (f.textContent || '').trim().replace(/\s+/g, ' ') : '';
        }, { name: selectors.recommend.name })
        .catch(() => '');
      if (t.includes(opts.verifyName)) { found = i; break; }
    }
    if (found >= 0) cardIndex = found;
    else warn(`未在当前列表找到「${opts.verifyName}」，退回落序号 ${index}`);
  }
  if (cardIndex < 0 || cardIndex >= cards.length) {
    warn(`卡片序号 ${index} 超出列表范围（共 ${cards.length} 个）`);
    return null;
  }

  // 点击前：捕获这张卡片的姓名（用于校验）
  const cardName = await cards[cardIndex]
    .evaluate((el, sel) => {
      const f = el.querySelector(sel.name);
      return f ? (f.textContent || '').trim().replace(/\s+/g, ' ') : '';
    }, { name: selectors.recommend.name })
    .catch(() => '');

  // 人机模拟（2026-08-26 皇帝拍板 A+B）：
  //   1) 开详情前随机 5-15 秒停留（含随机轻微滚动），拉开操作节拍
  //   2) 点击前用随机轨迹把鼠标移动到卡片目标点（非直线）
  //   3) 若触发「查看受限」弹窗，立即熔断返回（不重试）
  await sleepRandomInspect(page);
  const box = await cards[cardIndex].boundingBox().catch(() => null);
  if (box) {
    await mouseMoveHuman(page, { x: box.x + 30, y: box.y + 30 }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }

  // 点击前：检测是否已有「查看受限」弹窗（可能上一轮已触发）
  const limitPre = await detectViewLimit(page);
  if (limitPre) {
    return { page: null, detail: null, viewLimited: limitPre };
  }

  // 记录打开前的活动 tab URL（鉴别新开的详情 tab）
  const beforeUrls = new Set<string>(
    await browser
      .pages()
      .then((ps) => Promise.all(ps.map(async (p) => {
        try { return await p.url(); } catch { return ''; }
      })))
      .then((urls) => urls.filter(Boolean)),
  );

  // 点击卡片 .detail 区域（跳详情）
  const clicked = await cards[cardIndex]
    .evaluate((el) => {
      const d = el.querySelector('.detail') || el;
      if (d instanceof HTMLElement) {
        d.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (!clicked) {
    warn('卡片点击失败，无法打开详情');
    return null;
  }
  out(`已点击第 ${index} 张卡片（${cardName}），等待详情页…`);

  // 改：轮询 browser.pages() 找新出现的 /resume/detail 页（不依赖 targetcreated 事件，更稳）
  // 同时检测列表页是否弹出「查看受限」弹窗（点击后可能立刻弹）
  const deadline = Date.now() + 12000;
  let detailPage: Page | null = null;
  while (Date.now() < deadline) {
    // 列表页弹窗检测（命中即熔断）
    const limitMid = await detectViewLimit(page);
    if (limitMid) {
      return { page: null, detail: null, viewLimited: limitMid };
    }
    const pages = await browser.pages().catch(() => [] as Page[]);
    for (const p of pages) {
      if (p.isClosed()) continue;
      let u = '';
      try { u = await p.url(); } catch { /* ignore */ }
      // 详情页 URL 含 /resume/detail，且不在打开前基线里（新开的）
      if (u.includes('/resume/detail') && !beforeUrls.has(u)) {
        detailPage = p;
        break;
      }
    }
    if (detailPage) break;
    await delay(400 + Math.random() * 300);
  }

  if (!detailPage) {
    warn('轮询未发现新详情 tab（12s），回退到列表页');
    await page.bringToFront().catch(() => {});
    return null;
  }
  await detailPage.bringToFront().catch(() => {});
  await delay(1800 + Math.random() * 800);

  // 详情页弹窗检测（详情页也可能弹「查看受限」）
  const limitPost = await detectViewLimit(detailPage);
  if (limitPost) {
    try { await detailPage.close(); } catch { /* ignore */ }
    return { page: null, detail: null, viewLimited: limitPost };
  }

  if (opts.throttle) await opts.throttle.wait();
  const detail = await readCandidateDetail(detailPage, { throttle: opts.throttle });

  // 校验：详情页姓名 vs 卡片姓名（错位则有限重试；耗尽即失败，T107）
  const detailName = (detail.name || '').trim();
  const verify = opts.verifyName || cardName || '';
  const retry = opts._retry ?? 0;
  if (verify && detailName && detailName !== verify) {
    if (retry < 2) {
      warn(`详情页姓名「${detailName}」与卡片「${verify}」不一致（疑似错位/竞态），关闭详情重试（第 ${retry + 1} 次）…`);
      try { await detailPage.close(); } catch { /* ignore */ }
      await delay(1500 + Math.random() * 800);
      return openCardDetail(browser, page, index, cardSelector, { throttle: opts.throttle, verifyName: opts.verifyName, _retry: retry + 1 });
    }
    // T107：错位重试耗尽——绝不能把他人详情交给调用方（后续 --hi 会作用到错误候选人）
    warn(`详情页姓名「${detailName}」与卡片「${verify}」不一致（重试 2 次仍错位），放弃本次详情`);
    try { await detailPage.close(); } catch { /* ignore */ }
    return null;
  }
  // 详情页未读到姓名（readCandidateDetail 失败/渲染慢）→ 不递归，直接返回当前结果（避免死锁）
  if (!detailName && verify) {
    warn(`详情页未能读到姓名（可能详情未渲染或受限），返回当前提取结果`);
    return { page: detailPage, detail };
  }

  return { page: detailPage, detail };
}