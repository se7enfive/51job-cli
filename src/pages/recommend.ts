import type { Page } from 'puppeteer-core';
import { assertNoRisk } from '../core/guard';
import { delay, Throttle } from '../core/throttle';
import { out, warn, Row } from '../utils/output';
import { selectors } from './selectors';
import { detectHiResult, HiOutcome } from './hi-result';

/** 推荐候选人（人才望远镜卡片） */
export interface RecommendHit {
  index: number;
  name: string;
  job?: string;
  salary?: string;
  company?: string;
  meta: string;
  city?: string;
  active?: string;
  flag?: string;
  age?: number;
  exp?: number;
  edu?: string;
  /** 推荐的岗位（左侧选中的岗位名） */
  forJob?: string;
}

function parseProfile(text: string): { age?: number; exp?: number; edu?: string } {
  const age = text.match(/(\d+)岁/);
  const exp = text.match(/(\d+)年/);
  const eduMap: Record<string, string> = {
    博士: '博士',
    硕士: '硕士',
    研究生: '硕士',
    本科: '本科',
    大专: '大专',
    高中: '高中',
    中专: '中专',
  };
  let edu: string | undefined;
  for (const [k, v] of Object.entries(eduMap)) {
    if (text.includes(k)) { edu = v; break; }
  }
  return {
    age: age ? parseInt(age[1], 10) : undefined,
    exp: exp ? parseInt(exp[1], 10) : undefined,
    edu,
  };
}

/**
 * 进入人才望远镜推荐页（不在则导航）。
 */
export async function navToRecommend(page: Page, opts: { throttle?: Throttle } = {}): Promise<boolean> {
  await assertNoRisk(page, { action: '进入人才推荐页', soft: true });
  if (opts.throttle) await opts.throttle.wait();
  const s = selectors.recommend;
  if (!page.url().includes('/Revision/talent/search-recommend')) {
    out('正在进入人才望远镜推荐页…');
    await page.goto(s.url, { waitUntil: 'networkidle2', timeout: 60_000 });
    await delay(1500 + Math.random() * 1000);
  }
  return page.url().includes('/Revision/talent/search-recommend');
}

/**
 * 按岗位切换推荐列表（左侧岗位菜单）。
 * @param jobName 岗位名（模糊匹配，如「三维扫描工程师」）
 */
export async function switchRecommendJob(page: Page, jobName: string, opts: { throttle?: Throttle } = {}): Promise<boolean> {
  const s = selectors.recommend;
  const items = await page.$$(s.jobMenuItem).catch(() => []);
  for (const item of items) {
    const t = await item.evaluate((el) => (el.textContent || '').trim()).catch(() => '');
    if (t.includes(jobName)) {
      await item.click();
      await delay(1000 + Math.random() * 800);
      out(`已切换到推荐岗位「${jobName}」`);
      return true;
    }
  }
  warn(`未在推荐页找到岗位「${jobName}」，继续当前岗位`);
  return false;
}

/** 读取推荐候选人列表（人才望远镜卡片） */
export async function readRecommendResults(page: Page, opts: { throttle?: Throttle } = {}): Promise<RecommendHit[]> {
  await assertNoRisk(page, { action: '读取推荐人才', soft: true });
  if (opts.throttle) await opts.throttle.wait();
  const s = selectors.recommend;

  // 当前选中的岗位名（左侧菜单激活项）
  let forJob = '';
  try {
    const active = await page.$(`${s.jobMenuItem}.is-active`).catch(() => null);
    if (active) forJob = (await active.evaluate((el) => (el.textContent || '').trim())).split(/\s+/)[0] || '';
  } catch { /* ignore */ }

  const items = await page.$$(s.resultItem).catch(() => []);
  if (items.length === 0) {
    warn('未定位到推荐人才卡片。请确认已进入人才望远镜推荐页，或运行 51job probe 校准选择器。');
    return [];
  }

  const hits: RecommendHit[] = [];
  for (let i = 0; i < items.length; i++) {
    const info = await items[i]
      .evaluate((el, sel) => {
        const txt = (selector: string) => {
          const f = el.querySelector(selector);
          return f ? (f.textContent || '').trim().replace(/\s+/g, ' ') : '';
        };
        const expectRaw0 = txt(sel.expect).replace(/^求职意向[:：]?\s*/, '');
        const flag = txt(sel.expectGray).trim();
        let expectRaw = flag ? expectRaw0.replace(flag, '') : expectRaw0;
        expectRaw = expectRaw
          .replace(/（距离[^）]*）/g, '')
          .replace(/(已转发|来源于推荐|推荐|已聊)$/g, '')
          .trim();
        const salaryMatch = expectRaw.match(/(\d+(?:\.\d+)?(?:千|万)?-\d+(?:\.\d+)?(?:千|万)?\/月|面议)/);
        const salary = salaryMatch ? salaryMatch[1] : '';
        const jobPart = salary ? expectRaw.replace(salary, '').trim() : expectRaw.trim();
        const job = jobPart.replace(/^[\u4e00-\u9fa5·,，、\s]+/, '').trim() || jobPart.trim();
        return {
          name: txt(sel.name),
          expect: expectRaw,
          salary,
          job,
          company: txt(sel.company),
          active: txt(sel.active),
          address: txt(sel.address),
          flag: txt(sel.expectGray),
          desc: txt(sel.desc),
          userinfo: txt('.userinfo'),
        };
      }, {
        expect: s.expect,
        name: s.name,
        company: s.company,
        active: s.active,
        address: s.address,
        expectGray: s.expectGray,
        desc: s.desc,
      })
      .catch(() => null);
    if (!info || !info.name) continue;

    const prof = parseProfile(info.userinfo);
    const meta = [
      info.address || '',
      prof.age ? `${prof.age}岁` : '',
      prof.exp ? `${prof.exp}年` : '',
      prof.edu || '',
      info.active || '',
      info.flag || '',
      info.salary || '',
    ]
      .filter(Boolean)
      .join(' | ');

    hits.push({
      index: i + 1,
      name: info.name,
      job: info.job || undefined,
      company: info.company || undefined,
      meta,
      salary: info.salary || undefined,
      city: info.address || undefined,
      active: info.active || undefined,
      flag: info.flag || undefined,
      age: prof.age,
      exp: prof.exp,
      edu: prof.edu,
      forJob,
    });
  }
  return hits;
}

export function recommendToRows(hits: RecommendHit[]): Row[] {
  return hits.map((h) => ({
    '#': h.index,
    姓名: h.name,
    意向: `${h.city || ''} ${h.job || ''} ${h.salary || ''}`.trim(),
    // T304：移除原 replace(/\|/g,'|') 无操作；meta 本身以 | 连接，姓名已在前列不再剔除
    画像: h.meta.trim(),
    公司: h.company || '',
    状态: h.flag || h.active || '',
  }));
}

/**
 * 在当前推荐页对指定候选人打招呼（列表内点「立即Hi聊」，复用推荐卡按钮）。
 * @param name 候选人姓名（文本匹配）或 index 序号
 * @returns HiOutcome（success / quota_exhausted / failed / unknown）
 */
export async function greetRecommend(page: Page, nameOrIndex: string, opts: { throttle?: Throttle } = {}): Promise<HiOutcome> {
  await assertNoRisk(page, { action: `对推荐候选人 ${nameOrIndex} 打招呼`, soft: false });
  if (opts.throttle) await opts.throttle.wait();
  const s = selectors.recommend;
  const items = await page.$$(s.resultItem).catch(() => []);

  let idx = -1;
  const asNum = parseInt(nameOrIndex, 10);
  if (!Number.isNaN(asNum)) {
    idx = asNum - 1;
  } else {
    for (let i = 0; i < items.length; i++) {
      const t = await items[i].evaluate((el) => (el.textContent || '')).catch(() => '');
      if (t.includes(nameOrIndex)) { idx = i; break; }
    }
  }
  if (idx < 0 || idx >= items.length) {
    warn(`未在推荐列表定位到「${nameOrIndex}」`);
    return 'failed';
  }

  const card = items[idx];
  const clicked = await card
    .evaluate((el) => {
      const btn = Array.from(el.querySelectorAll('button'))
        .find((b) => (b.textContent || '').trim() === '立即Hi聊');
      if (btn instanceof HTMLElement) { btn.click(); return true; }
      return false;
    })
    .catch(() => false);
  if (clicked) {
    out(`已点击推荐候选人「${nameOrIndex}」的「立即Hi聊」，校验结果…`);
    // 弹出额度/失败弹窗或按钮文案变化 = 真实结果
    // T106：成功判定只看被点击的这张卡（idx 为 0-based），其他卡的初始文案不再遮蔽信号
    return detectHiResult(page, {
      cardSelector: s.resultItem,
      targetIndex: idx,
      btnText: `${s.resultItem} button.tm_button`,
    });
  }
  warn(`已在推荐列表定位到「${nameOrIndex}」，但未找到「立即Hi聊」按钮（可能已转发）`);
  return 'failed';
}