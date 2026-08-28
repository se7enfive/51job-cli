import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'puppeteer-core';
import { assertNoRisk } from '../core/guard';
import { closePage } from '../core/browser';
import { delay, Throttle } from '../core/throttle';
import { out, warn, Row } from '../utils/output';
import { jdDir } from '../utils/store';
import { readSearchResults, searchTalents, type SearchFilters } from './search';
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

/** 候选人来源：auto=按有无投递分派（默认，改前行为）；delivery=强制仅投递；search=强制人才池搜索 */
export type JobSource = 'auto' | 'delivery' | 'search';

/**
 * 搜索页「期望工作地」实测（2026-08-28）：输入框 readonly/disabled 不能直填，
 * 但**点击容器会弹出级联选择器**（.eh_cascader_dialog：省→市 两级，热门城市/省级列表）。
 * 因此 city 注入需带省名（`广东省,湛江`），靠以下市→省映射补全；未收录城市跳过。
 */
const CITY_TO_PROVINCE: Record<string, string> = {
  广州: '广东省', 深圳: '广东省', 珠海: '广东省', 汕头: '广东省', 佛山: '广东省',
  韶关: '广东省', 湛江: '广东省', 肇庆: '广东省', 江门: '广东省', 茂名: '广东省',
  惠州: '广东省', 梅州: '广东省', 汕尾: '广东省', 河源: '广东省', 阳江: '广东省',
  清远: '广东省', 东莞: '广东省', 中山: '广东省', 潮州: '广东省', 揭阳: '广东省',
  云浮: '广东省', 南沙: '广东省',
  北京: '北京市', 上海: '上海市', 天津: '天津市', 重庆: '重庆市', 杭州: '浙江省',
  南京: '江苏省', 苏州: '江苏省', 武汉: '湖北省', 长沙: '湖南省', 南昌: '江西省',
  成都: '四川省', 昆明: '云南省', 南宁: '广西', 桂林: '广西', 柳州: '广西',
  海口: '海南省', 三亚: '海南省', 福州: '福建省', 厦门: '福建省', 泉州: '福建省',
};

/**
 * 把职位卡 detail（`城市 | 学历 | 年限 | 薪资`，如「湛江-霞山区 | 本科 | 3年及以上 | 7-12万/年」）
 * 转成人才搜索 SearchFilters，用于 `--source search` 自动注入。
 * 转换原则（grilling 决议）：**能稳定 1:1 转才转，若对不上直接跳过**。
 * - 城市：取市级（去 `-区` 后缀，`湛江-霞山区`→`湛江`），经市→省映射补全为「省,市」注入 city
 *   ——期望工作地控件是点击容器弹级联选择器（readonly 输入框不能直填，实测 2026-08-28）
 * - 学历：上取为页面枚举（`本科`→`本科及以上`，用户确认向上取扩大合适），注入 edu
 * - 年限：卡上 `3年及以上` 与页面枚举「3-5年/5-10年」槽不符 → 跳过
 * - 薪资：卡上按年 `7-12万/年`，页面按月档位 → 跳过
 */
export function detailToSearchFilters(detail: string): SearchFilters {
  const f: SearchFilters = {};
  const segs = (detail || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return f;

  // 城市：首段「市-区」（或纯市），去区级后缀取市级 → 「省,市」
  const city = segs[0].split('-')[0]?.trim();
  if (city && CITY_TO_PROVINCE[city]) {
    f.city = `${CITY_TO_PROVINCE[city]},${city}`;
  }

  // 学历：首段后的精确学历词 → 上取枚举；非已知词跳过
  const eduMap: Record<string, string> = {
    大专: '大专及以上',
    本科: '本科及以上',
    硕士: '硕士及以上',
    博士: '博士',
  };
  const eduSeg = segs[1];
  if (eduSeg) {
    const hit = ['博士', '硕士', '本科', '大专'].find((k) => eduSeg.includes(k));
    if (hit && eduMap[hit]) f.edu = eduMap[hit];
  }

  return f;
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
 * 收集人才管理页「当前职位」候选人，返回按出现顺序、跨页去重后的结构化行。
 *
 * 实测（2026-08-28）：人才管理页是**分页列表**（底部 .eh-pagination，total「共 N 条」，每页约 10 人）。
 * 懒加载跟不上时**快速滚动会出空白卡片**；进页面直接开滚也拿不全。
 *
 * 稳定策略（真机验证）：
 * 1. 进页面**先随机停几秒**，等首屏懒加载稳定；
 * 2. 把底部**每页条数切到 50**（.el-select--mini 下拉 → “50条/页”），单页最大化、**减少翻页**；
 * 3. **缓慢渐进滚动**到底：每步小段增量 + 每步 pause 等渲染，杜绝一次性跳底导致的空白卡；
 * 4. 滚动到底且读数稳定后再**兜底翻页**（数量可能>50，仍需翻）。
 *
 * 行以「回复」按钮 `.button.tm_button` 为锚，向上找含 `.name` 的行容器。
 * 返回 { index, name, text, ...parseMgmtRow }。
 */
async function collectMgmtRows(pageToScrape: Page): Promise<Array<{ index: number; name: string; [k: string]: string | number | undefined }>> {
  const seen = new Map<string, { name: string; text: string }>();

  const readPage = () =>
    pageToScrape
      .evaluate((nameSel, btnSel) => {
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
          if (out.some((o) => o.name === name)) continue;
          out.push({ name, text: row ? (row.innerText || '') : '' });
        }
        return out;
      }, selectors.talentMgmt.name, 'button.tm_button')
      .catch(() => [] as Array<{ name: string; text: string }>);

  const hasNext = () =>
    pageToScrape
      .evaluate(() => {
        const next = document.querySelector('.eh-pagination__btn-next, .eh-pagination__next, button.btn-next') as HTMLElement | null;
        if (!next) return false;
        const cls = (next.className || '').toString();
        return !/(is-disabled|disabled)/.test(cls);
      })
      .catch(() => false);

  const clickNext = () =>
    pageToScrape
      .evaluate(() => {
        const next = document.querySelector('.eh-pagination__btn-next, .eh-pagination__next, button.btn-next') as HTMLElement | null;
        if (next) { (next as HTMLElement).click(); return true; }
        return false;
      })
      .catch(() => false);

  const scrollTopAll = () =>
    pageToScrape
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('div,section'))) {
          if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) el.scrollTop = 0;
        }
        window.scrollTo(0, 0);
      })
      .catch(() => {});

  // 1) 进页面先随机停几秒，等首屏懒加载稳定（太快会出空白卡）
  await delay(3000 + Math.random() * 3000);

  // 2) 每页条数切到 50：点每页下拉 → 弹层选「50条/页」。切失败静默降级（仍走缓慢滚动 + 兜底翻页）。
  await pageToScrape.evaluate(() => {
    const sel = document.querySelector('.job_pagination .el-input.el-select, .el-pagination .el-select, .el-select') as HTMLElement | null;
    if (sel) (sel as HTMLElement).click();
  }).catch(() => {});
  await delay(800 + Math.random() * 400);
  const pickedFifty = await pageToScrape.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown li, .el-select-dropdown__item'));
    const fifty = items.find((li) => (li.textContent || '').replace(/\s+/g, '').includes('50条'));
    if (fifty) { (fifty as HTMLElement).click(); return true; }
    return false;
  }).catch(() => false);
  if (pickedFifty) await delay(1500 + Math.random() * 500);

  // 3) 缓慢渐进滚动到底：小步增量 + 每步 pause 等渲染，避免一次性跳底的空白卡
  await scrollTopAll();
  await delay(600 + Math.random() * 400);
  const STEP = 600, MAX_STEPS = 120;
  let lastLen = -1;
  for (let step = 0; step < MAX_STEPS; step++) {
    const pageRows = await readPage();
    for (const r of pageRows) if (!seen.has(r.name)) seen.set(r.name, r);

    const canScroll = await pageToScrape
      .evaluate((inc) => {
        let moved = false;
        for (const el of Array.from(document.querySelectorAll('div,section'))) {
          if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
            const before = el.scrollTop;
            el.scrollTop += inc;
            if (el.scrollTop !== before) moved = true;
          }
        }
        const wb = window.scrollY;
        window.scrollBy(0, inc);
        if (window.scrollY !== wb) moved = true;
        return moved;
      }, STEP)
      .catch(() => false);

    if (!canScroll && seen.size === lastLen) break;
    lastLen = seen.size;
    await delay(900 + Math.random() * 500);
  }

  // 4) 兜底翻页（数量可能 >50）：每页滚回顶部再读 + 翻页
  for (let page = 0; page < 40; page++) {
    const pageRows = await readPage();
    for (const r of pageRows) if (!seen.has(r.name)) seen.set(r.name, r);
    if (!(await hasNext())) break;
    await scrollTopAll();
    await clickNext();
    await delay(1200 + Math.random() * 600);
  }

  return Array.from(seen.values()).map((r, i) => {
    const meta = parseMgmtRow(r.text);
    return { index: i + 1, name: r.name, text: r.text, ...meta };
  });
}

/**
 * 拉取「某个职位」的候选人。
 * 来源由 opts.source 控制（JobSource）：
 * - 'search'：**强制走人才池搜索**，投递少时扩充候选。直接 goto 搜索页 + 职位名作关键词，
 *   并把职位卡 detail（城市/学历）注入 SearchFilters 自动收敛范围。
 * - 'delivery'：强制只读投递（该职位收到的候选人投递列表；若无投递入口则 warn 返回 null）
 * - undefined/'auto'（默认）：按职位卡有无投递人自动分派 —— 有投递点「待处理数」走投递，
 *   无投递点「去人才」走搜索（原有行为不变）。
 * 临时 tab 收尾关闭，不影响原 page 上下文。
 */
export async function readPositionCandidates(
  browser: Browser,
  page: Page,
  position: string,
  opts: { throttle?: Throttle; scope?: JobScope; source?: JobSource; all?: boolean } = {},
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

  // 读职位卡 detail（`城市 | 学历 | 年限 | 薪资`），供 --source search 注入筛选
  const detail = await target
    .evaluate((el, sel) => {
      const f = el.querySelector(sel) as HTMLElement | null;
      return f ? (f.textContent || '').trim() : '';
    }, selectors.job.bottomInfo)
    .catch(() => '');

  const src = opts.source === 'auto' || opts.source === undefined ? undefined : opts.source;

  // ==================== 强制搜索分支 ====================
  // 不管有无投递，直接 goto 搜索页，以职位名为关键词 + 读卡 detail 自动注入筛选
  if (src === 'search') {
    const s = selectors.search;
    if (!page.url().includes('/Revision/talent/search')) {
      out('正在进入人才搜索页…');
      await page.goto(s.url, { waitUntil: 'networkidle2', timeout: 60_000 });
      await delay(1500 + Math.random() * 800);
    }
    const filters = detailToSearchFilters(detail);
    const injected = [filters.city && `期望工作地=${filters.city}`, filters.edu && `学历≥${filters.edu.replace('及以上', '')}`]
      .filter(Boolean)
      .join('、');
    out(`搜索结果关键词「${position}」${injected ? `（自动注入：${injected}）` : '（无可用筛选注入）'}`);
    await searchTalents(page, position, { filters, throttle: opts.throttle });
    const hits = await readSearchResults(page, { throttle: opts.throttle, all: opts.all });
    const candidates = hits
      .map((h, i) => ({
        index: i + 1,
        name: h.name,
        age: h.age ? `${h.age}岁` : undefined,
        years: h.exp ? `${h.exp}年` : undefined,
        edu: h.edu,
        city: h.city,
        snippet: h.company ? `${h.company}${h.job ? ` • ${h.job}` : ''}` : undefined,
      }))
      .filter((c) => c.name);
    return { position, source: 'search', portal: page.url(), count: candidates.length, candidates };
  }

  // ==================== 投递分支（auto 有投递 / 强制 delivery） ====================
  // 确认入口：优先「待处理人才数」(.cardNum)，无则当无投递处理（强制 delivery 时 warn）
  const hasNum = (await target.$(selectors.job.cardNum).catch(() => null)) !== null;
  if (!hasNum && src === 'delivery') {
    warn(`职位「${position}」无投递入口（.job_card_num 不存在），强制 delivery 无候选人可读`);
    return null;
  }
  const entrySel = selectors.job.cardNum;
  if (opts.throttle) await opts.throttle.wait();

  // 记录点击前页面对象集合（T306 同法：按对象身份判新 tab）
  const beforePages = new Set<import('puppeteer-core').Page>(
    (await browser.pages().catch(() => [] as Page[])).filter((p) => !p.isClosed()),
  );

  // 实际点击：卡片内部的「待处理人数」入口
  const entryHandle = await target.$(entrySel).catch(() => null);
  if (!entryHandle) {
    // auto 且无投递 → 改走搜索（保持原有「去人才」语义）
    warn(`职位「${position}」无待处理入口，改走搜索…`);
    return readPositionCandidates(browser, page, position, { throttle: opts.throttle, scope: opts.scope, source: 'search' });
  }
  await entryHandle.evaluate((el) => {
    (el as HTMLElement).scrollIntoView({ block: 'center' });
  }).catch(() => {});
  await delay(300 + Math.random() * 200);
  await entryHandle.click().catch(() => {});
  out(`已点击职位「${position}」待处理人才入口，等待新 tab…`);

  // 3. 捕获新 tab（轮询 browser.pages() + CDP target，按对象身份判新，T306 同法）
  //    稳：点击瞬间 URL 可能是 about:blank，因此先按「新出现的 page 对象」判定，
  //    拿到对象后再等它 URL 落到 /Revision/talent/，避免仅按 URL 轮询漏掉空 URL 帧。
  const deadline = Date.now() + 15_000;
  let portal: Page | null = null;
  while (Date.now() < deadline) {
    const pages = await browser.pages().catch(() => [] as Page[]);
    for (const p of pages) {
      if (p.isClosed() || beforePages.has(p)) continue;
      portal = p;
      break;
    }
    if (portal) break;
    await delay(500 + Math.random() * 300);
  }
  // 等待 portal URL 落到人才页（若已 >15s 对象仍在 about:blank，多给它余量）
  if (portal) {
    const settled = await portal
      .waitForFunction(() => location.pathname.includes('/Revision/talent/'), { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!settled) { warn(`新 tab 未跳到人才页（URL: ${portal.url()}）`); portal = null; }
  }
  if (!portal) { warn(`未捕获到「${position}」候选人 tab（15s）`); return null; }

  // 4. 按落地 URL 分支收集 + 5. 统一结构化
  const portalUrl = portal.url();
  if (isMgmtPortal(portalUrl)) {
    await delay(1200 + Math.random() * 800);
    const raw = await collectMgmtRows(portal);
    const candidates = raw
      .map((r, i) => ({ index: i + 1, name: String(r.name), ...parseMgmtRow(String(r.text || '')) }))
      .filter((c) => c.name);
    try { await portal.close(); } catch { /* ignore */ }
    return { position, source: 'delivery', portal: portalUrl, count: candidates.length, candidates };
  }

  // 落到非人才管理页（理论上不会到这）：回退用原 page 搜索
  try { await portal.close(); } catch { /* ignore */ }
  return await readPositionCandidates(browser, page, position, { throttle: opts.throttle, scope: opts.scope, source: 'search' });
}
