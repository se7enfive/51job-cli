import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'puppeteer-core';
import { assertNoRisk } from '../core/guard';
import { closePage } from '../core/browser';
import { delay, Throttle } from '../core/throttle';
import { out, warn, Row } from '../utils/output';
import { jdDir } from '../utils/store';
import { readSearchResults, type SearchHit } from './search';
import { selectors } from './selectors';

export interface JobPost {
  index: number;
  name: string;
  type?: string;
  status?: string;
  detail?: string;
  applicants?: string;
}

/** 职位管理页（2026-08-26 实测：URL 直达，侧边菜单为 .eh_menu_item「职位管理」）。 */
const JOB_MANAGE_URL = 'https://ehire.51job.com/Revision/job-manage';

/**
 * 职位管理页视图：职位卡分「我的职位」与「组织下职位」两个 tab（.page_tab 内）。
 * 默认进入停在「组织下职位」；页面常驻后 tab 残留会造成 positions 结果随页面漂移，
 * 因此提供显式 scope（my/org）主动切 tab，保证结果可复现。
 */
export type JobScope = 'my' | 'org';
const JOB_SCOPE_TAB: Record<JobScope, string> = { my: '我的职位', org: '组织下职位' };
const JOB_SCOPE_TAB_SEL = '.row.page_tab div, .row.page_tab span, .row.page_tab li';

/** 若 scope 提供，主动点击职位管理页对应 tab 并等待重渲染；否则保持当前。 */
async function ensureJobScope(page: Page, scope?: JobScope): Promise<void> {
  if (!scope) return;
  const tabText = JOB_SCOPE_TAB[scope];
  // 找 textContent 完全匹配、无子元素的「叶子」tab 元素并 click（避免命中「我的职位 组织下职位」容器行）
  await page
    .evaluate((text) => {
      for (const el of Array.from(document.querySelectorAll('div, span, li'))) {
        const t = (el.textContent || '').trim();
        if (t === text && el.children.length === 0) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, tabText)
    .catch(() => {});
  // 等 active 状态生效 + 卡片重渲染
  await delay(1200 + Math.random() * 800);
}

/** 读取职位列表。
 * @param scope  若提供，先切到「我的职位/组织下职位」再收集（结果可复现，不受页面残留影响）
 */
export async function readPositions(page: Page, opts: { throttle?: Throttle; scope?: JobScope } = {}): Promise<JobPost[]> {
  await assertNoRisk(page, { action: '读取职位列表', soft: true });
  if (opts.throttle) await opts.throttle.wait();

  if (!page.url().includes('/Revision/job-manage')) {
    out('正在进入职位管理页…');
    await page.goto(JOB_MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await delay(2500 + Math.random() * 1000);
  }
  // 若指定了 scope，主动切 tab（覆盖可能残留的视图，保证结果可复现）
  await ensureJobScope(page, opts.scope);

  const s = selectors.job;
  // 等职位卡挂载（列表异步加载，最多 10s；无在招职位时返回空）
  const start = Date.now();
  let items = await page.$$(s.jobItem).catch(() => []);
  while (items.length === 0 && Date.now() - start < 10_000) {
    await delay(500 + Math.random() * 300);
    items = await page.$$(s.jobItem).catch(() => []);
  }
  if (items.length === 0) {
    warn('未定位到职位列表（可能没有在招职位）。若页面有数据，请运行 51job probe 校准选择器。');
    return [];
  }

  const jobs: JobPost[] = [];
  for (let i = 0; i < items.length; i++) {
    const info = await items[i]
      .evaluate((el, sels) => {
        const txt = (sel: string) => {
          const f = el.querySelector(sel);
          return f ? (f.textContent || '').trim() : '';
        };
        const tags = Array.from(el.querySelectorAll(sels.jobTag))
          .map((t) => (t.textContent || '').trim())
          .filter(Boolean);
        return {
          name: txt(sels.jobName) || '',
          type: txt(sels.jobTypeTag) || '',
          status: tags.join(' '),
          detail: txt(sels.bottomInfo) || '',
          applicants: txt(sels.cardNum) || '',
        };
      }, {
        jobName: s.jobName,
        jobTypeTag: s.jobTypeTag,
        jobTag: s.jobTag,
        bottomInfo: s.bottomInfo,
        cardNum: s.cardNum,
      })
      .catch(() => ({ name: '', type: '', status: '', detail: '', applicants: '' }));

    if (info.name) jobs.push({ index: i + 1, ...info });
  }
  return jobs;
}

export function jobsToRows(jobs: JobPost[]): Row[] {
  return jobs.map((j) => ({
    '#': j.index,
    职位: j.name,
    类型: j.type || '',
    状态: j.status || '',
    详情: j.detail || '',
    待处理: j.applicants ? `${j.applicants}人` : '',
  }));
}

/**
 * 抓取职位 JD 并缓存到 ~/.51job-cli/jd/<name>.md。
 * 实测链路（2026-08-26）：职位管理页 → 点职位名 → 跳转 /Revision/job?mark=Edit&jobid=…（编辑职位页）
 * → 职位描述 textarea（.el-textarea__inner）即 JD 正文，回退读整页。
 */
export async function fetchJd(page: Page, name: string, opts: { throttle?: Throttle } = {}): Promise<string | null> {
  await assertNoRisk(page, { action: `抓取职位 ${name} 的 JD`, soft: false });
  if (opts.throttle) await opts.throttle.wait();

  const s = selectors.job;

  // 1) 确保在职位管理页
  if (!page.url().includes('/Revision/job-manage')) {
    out('正在进入职位管理页…');
    await page.goto(JOB_MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await delay(2500 + Math.random() * 1000);
  }

  // 2) 定位职位卡片（按名称文本匹配）
  const items = await page.$$(s.jobItem).catch(() => []);
  let found = false;
  for (const item of items) {
    const text = await item.evaluate((el) => el.textContent || '').catch(() => '');
    if (text.includes(name)) {
      found = true;
      // 点职位名（.job_name）跳编辑页——比点卡片更稳
      const nameEl = await item.$(s.jobName).catch(() => null);
      if (nameEl) {
        await nameEl.click();
      } else {
        await item.click();
      }
      await delay(2000 + Math.random() * 1200);
      break;
    }
  }
  if (!found) {
    warn(`未在职位列表中找到「${name}」`);
    return null;
  }

  // 3) 等待跳转到编辑/详情页（URL 含 /Revision/job）
  const ok = await page.waitForFunction(
    () => location.pathname.includes('/Revision/job'),
    { timeout: 15_000 }
  ).catch(() => null);
  if (!ok) {
    warn('点击职位后未跳到职位页，JD 抓取失败');
    return null;
  }
  await delay(1200 + Math.random() * 800);

  // 4) 抓正文：优先职位描述 textarea，其次整页
  const jdText = await page.evaluate(() => {
    const ta = document.querySelector('textarea.el-textarea__inner') as HTMLTextAreaElement | null;
    if (ta && ta.value && ta.value.trim().length > 30) {
      return `【职位描述】\n${ta.value.trim()}\n`;
    }
    // 回退：整个表单内容
    const form = document.querySelector('.job_editor_info, .el-form') as HTMLElement | null;
    const base = form ? form.innerText : document.body.innerText;
    return (base || '').trim();
  }).catch(() => '');

  if (!jdText || jdText.length < 30) {
    warn('JD 正文为空');
    return null;
  }

  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  const file = path.join(jdDir(), `${safe}.md`);
  fs.writeFileSync(file, `# ${name}\n\n${jdText}\n`, 'utf-8');
  out(`JD 已缓存: ${file}`);
  return file;
}

export interface PositionCandidates {
  position: string;
  /** 数据来源：delivery=该职位收到的投递（走人才管理列表）；search=无投递，跳人才搜索按职位匹配 */
  source: 'delivery' | 'search';
  portal: string;
  count: number;
  candidates: Array<{
    index: number;
    name: string;
    age?: string;
    years?: string;
    edu?: string;
    city?: string;
    snippet?: string;
  }>;
}

/** 人才管理行文本 → 画像（结构实测松散，解析失败仅返回空串，不丢弃候选人） */
export function parseMgmtRow(text: string): {
  age?: string;
  years?: string;
  edu?: string;
  city?: string;
  snippet?: string;
} {
  const age = text.match(/(\d+)岁/)?.[1];
  const years = text.match(/(\d+)\s*年(?:经验)?/)?.[1];
  // 学历：本科/硕士/大专/博士/高中/中专/专科 等常见词
  const eduMatch =
    text.match(/(本科|硕士|大专|专科|博士|高中|中专|技校)/)?.[1];
  // 城市：限定在「首段经历时间戳（YYYY.MM）之前」的画像段内匹配，
  // 学历词之后的 2-4 字中文=城市。操作/状态词算子与后续经历都在时间戳后，被自然排除。
  let city = undefined;
  const head = (text.match(/\d{4}\.\d{2}/)?.index ?? text.length);
  const preText = text.slice(0, head);
  const cityM = preText.match(/(?:本科|硕士|大专|专科|博士|高中|中专)\s+([一-龥]{2,})(?:\s|$)/);
  if (cityM) {
    const c = cityM[1];
    if (!/回复|合适|不合适|拨打电话|在线|当前|正在|继续/.test(c)) city = c;
  }
  // snippet：经历首条「公司名 • 职位」（或所有经验段），截断 60 字
  const exp = text
    .replace(/\s+/g, ' ')
    .match(/\d{4}\.\d{2}-\d{4}\.\d{2}[^•]*•[^•]*/g);
  const snippet = exp ? exp[0].trim().slice(0, 60) : undefined;
  const r: { age?: string; years?: string; edu?: string; city?: string; snippet?: string } = {};
  if (age) r.age = `${age}岁`;
  if (years) r.years = `${years}年`;
  if (eduMatch) r.edu = eduMatch;
  if (city) r.city = city;
  if (snippet) r.snippet = snippet;
  return r;
}

/** 是否「人才管理投递列表」URL（该职位投递候选人） */
function isMgmtPortal(u: string): boolean {
  return u.includes('/Revision/talent/management');
}

/**
 * 把人才管理页当前职位候选人行收集为结构化列表（含滚动加载 .main_container）。
 * 行以「回复」按钮 `.button.tm_button` 为锚，向上找含 `.name` 的行容器（同 talent-insight 的 collectTalentRows）。
 */
async function collectMgmtRows(pageToScrape: Page): Promise<Array<{ index: number; name: string; [k: string]: string | number | undefined }>> {
  // 滚动 .内层容器到最底，触发懒加载（探测：.main_container scrollHeight>clientHeight）
  for (let i = 0; i < 10; i++) {
    await pageToScrape
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('div'))) {
          if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
            el.scrollTop = el.scrollHeight;
          }
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
      })
      .catch(() => {});
    await delay(700 + Math.random() * 500);
  }
  const rows = await pageToScrape.evaluate((nameSel, btnSel) => {
    const out: Array<{ name: string; text: string }> = [];
    for (const b of Array.from(document.querySelectorAll(btnSel))) {
      let row: HTMLElement | null = b.parentElement;
      for (let k = 0; k < 8 && row; k++) {
        if (row.querySelector(nameSel)) break;
        row = row.parentElement;
      }
      const nameEl = row ? row.querySelector(nameSel) : null;
      const name = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!name) continue;
      // 去重（同一行可能多次命中）
      if (out.some((o) => o.name === name)) continue;
      out.push({ name, text: row ? (row.innerText || '') : '' });
    }
    return out;
  }, selectors.talentMgmt.name, 'button.tm_button').catch(() => [] as Array<{ name: string; text: string }>);

  return rows.map((r, i) => {
    const meta = parseMgmtRow(r.text);
    return { index: i + 1, name: r.name, text: r.text, ...meta };
  });
}

/**
 * 拉取「某个职位」的候选人：
 * - 有投递人（职位卡 .jcc_num）→ 点它新 tab 到人才管理页（投递语义），滚动收集全量，source=delivery
 * - 无投递人（.jcc_num 空）→ 点 .jcc_to_talent_content 新 tab 到人才搜索页（自动预填+搜），source=search
 * closeCode 收尾关掉新 tab，不影响原 page 上下文。
 */
export async function readPositionCandidates(
  browser: Browser,
  page: Page,
  position: string,
  opts: { throttle?: Throttle; scope?: JobScope } = {},
): Promise<PositionCandidates | null> {
  await assertNoRisk(page, { action: `读取职位「${position}」候选人`, soft: true });
  if (opts.throttle) await opts.throttle.wait();

  // 1. 进入职位管理页并按名定位职位卡（复用 readPositions 导航，但需拿到卡片 DOM）
  if (!page.url().includes('/Revision/job-manage')) {
    out('正在进入职位管理页…');
    await page.goto('https://ehire.51job.com/Revision/job-manage', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await delay(2500 + Math.random() * 1000);
  }
  // 若指定 scope：先切到该职位视图再定位，避免残留 tab 导致定位不到
  await ensureJobScope(page, opts.scope);
  const items = await page.$$(selectors.job.jobItem).catch(() => []);
  let target: import('puppeteer-core').ElementHandle<Element> | null = null;
  for (const item of items) {
    const text = await item.evaluate((el) => el.textContent || '').catch(() => '');
    if (text.includes(position)) { target = item; break; }
  }
  if (!target) { warn(`未在职位列表中找到「${position}」`); return null; }

  // 2. 判定入口：优先「待处理人才数」(.cardNum)，无则「去人才」(.jobToTalent)
  const hasNum = (await target.$(selectors.job.cardNum).catch(() => null)) !== null;
  const entrySel = hasNum ? selectors.job.cardNum : selectors.job.jobToTalent;
  if (opts.throttle) await opts.throttle.wait();

  // 记录点击前页面对象集合（T306 同法：按对象身份判新 tab）
  const beforePages = new Set<import('puppeteer-core').Page>(
    (await browser.pages().catch(() => [] as Page[])).filter((p) => !p.isClosed()),
  );

  // 实际点击：卡片内部的入口元素（cardNum / jobToTalent）
  const entryHandle = await target.$(entrySel).catch(() => null);
  if (!entryHandle) { warn('未定位到该职位入口元素'); return null; }
  await entryHandle.evaluate((el) => {
    (el as HTMLElement).scrollIntoView({ block: 'center' });
  }).catch(() => {});
  await delay(300 + Math.random() * 200);
  await entryHandle.click().catch(() => {});
  out(`已点击职位「${position}」${hasNum ? '待处理人才' : '去人才'}入口，等待新 tab…`);

  // 3. 捕获新 tab（轮询 browser.pages()，T306 同法：按事情对象身份判新）
  const deadline = Date.now() + 15_000;
  let portal: Page | null = null;
  while (Date.now() < deadline) {
    const pages = await browser.pages().catch(() => [] as Page[]);
    for (const p of pages) {
      if (p.isClosed() || beforePages.has(p)) continue;
      let u = ''; try { u = await p.url(); } catch { /* ignore */ }
      if (u.includes('/Revision/talent/')) { portal = p; break; }
    }
    if (portal) break;
    await delay(500 + Math.random() * 300);
  }
  if (!portal) { warn(`未捕获到「${position}」候选人 tab（15s）`); return null; }

  // 4. 按落地 URL 分支收集 + 5. 统一结构化
  let source: 'delivery' | 'search';
  let raw: Array<{ name: string; text?: string }> | SearchHit[] = [];
  let portalUrl = '';
  try { portalUrl = await portal.url(); } catch { /* ignore */ }
  if (isMgmtPortal(portalUrl)) {
    source = 'delivery';
    await delay(1200 + Math.random() * 800);
    raw = await collectMgmtRows(portal);
  } else {
    source = 'search';
    await delay(1800 + Math.random() * 800);
    raw = await readSearchResults(portal, { throttle: opts.throttle });
  }

  const candidates = raw.map((r, i) =>
    'text' in r
      ? { index: i + 1, name: r.name, ...parseMgmtRow(r.text || '') }
      : {
          index: i + 1,
          name: (r as SearchHit).name,
          age: (r as SearchHit).age ? `${(r as SearchHit).age}岁` : undefined,
          years: (r as SearchHit).exp ? `${(r as SearchHit).exp}年` : undefined,
          edu: (r as SearchHit).edu,
          city: (r as SearchHit).city,
          snippet: (r as SearchHit).company
            ? `${(r as SearchHit).company}${(r as SearchHit).job ? ` • ${(r as SearchHit).job}` : ''}`
            : undefined,
        },
  ).filter((c) => c.name);

  // 关掉新 tab，保持原 page 上下文（positions 卡仍在原 tab）
  try { await portal.close(); } catch { /* ignore */ }

  return { position, source, portal: portalUrl, count: candidates.length, candidates };
}
