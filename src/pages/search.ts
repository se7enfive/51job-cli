import type { Browser, Page } from 'puppeteer-core';
import { assertNoRisk } from '../core/guard';
import { delay, Throttle } from '../core/throttle';
import { out, warn, Row, getFormat } from '../utils/output';
import { confirmAction } from '../utils/confirm';
import { trackExtraPage } from '../core/sessionPage';
import { openDetailByIndex, detailToSummary, hiChatOnDetail, CandidateDetail } from './candidate-detail';
import { detectHiResult, HiOutcome } from './hi-result';
import { selectors } from './selectors';

export interface SearchHit {
  index: number;
  name: string;
  /** 期望职位（求职意向中的职位名，如「测绘工程师」） */
  job?: string;
  /** 当前/最近公司 */
  company?: string;
  /** 聚合画像：城市|年龄|经验|学历|活跃|状态|期望薪资 */
  meta?: string;
  /** 期望薪资（如「1.1-1.3万/月」） */
  salary?: string;
  /** 所在城市 */
  city?: string;
  /** 活跃时间（如「24小时内活跃」） */
  active?: string;
  /** 状态标签（已转发/已聊等） */
  flag?: string;
  /** 年龄（如「29」） */
  age?: string;
  /** 经验年数（如「7」） */
  exp?: string;
  /** 学历（本科/大专/硕士…） */
  edu?: string;
}

const SEARCH_URL = selectors.search.url;

/** 等待指定选择器在页面上出现（轮询，默认 10s 超时） */
async function waitForSelector(page: Page, selector: string, timeout = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await page.$(selector)) return true;
    } catch {
      /* ignore */
    }
    await delay(300 + Math.random() * 200);
  }
  return false;
}

/** 人才搜索筛选参数（对应页面筛选区，2026-08-26 实测校准） */
export interface SearchFilters {
  /** 工作年限：不限|无经验|1-3年|3-5年|5-10年|10年及以上 */
  exp?: string;
  /** 年龄：不限|22岁及以下|22-25岁|25-30岁|30-35岁|35-45岁|45岁及以上 */
  age?: string;
  /** 性别：男|女 */
  gender?: string;
  /** 期望工作地（逗号分隔，如「广州,深圳」） */
  city?: string;
  /** 居住地（逗号分隔 省,市,区，如「广东省,广州市,天河区」） */
  residence?: string;
  /** 学历要求：不限|大专及以上|本科及以上|硕士及以上|博士 */
  edu?: string;
  /** 学校性质（逗号分隔多选）：全日制|985|211|双一流|留学经历|在校生 */
  school?: string;
  /** 求职状态：离职-周内到岗|在职-月内到岗|在职-观望机会 */
  status?: string;
  /** 期望行业（逗号分隔多选） */
  industry?: string;
  /** 期望职能（逗号分隔多选） */
  func?: string;
  /** 期望月薪（页面档位文本，如「8千」「2万以上」） */
  salary?: string;
  /** 从事行业（逗号分隔多选） */
  workIndustry?: string;
  /** 从事职能（逗号分隔多选） */
  workFunc?: string;
}

/** popover 式筛选（el-popover 弹层，选项 .option-item） */
const POPOVER_SELECTS: Partial<Record<keyof SearchFilters, string>> = {
  exp: '工作年限',
  age: '年龄',
  edu: '学历要求',
  school: '学校性质',
  salary: '期望月薪',
};

/** dialog 式筛选（el-dialog 弹窗，选项 li.cascader_panel_item，多选+确定） */
const DIALOG_SELECTS: Partial<Record<keyof SearchFilters, string>> = {
  industry: '期望行业',
  func: '期望职能',
  workIndustry: '从事行业',
  workFunc: '从事职能',
};

/** 点击指定 label 的下拉触发器（轮询等待筛选区渲染完成，最多 10s） */
async function clickBaseSelect(page: Page, label: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const ok = await page
      .evaluate((lb) => {
        const btns = Array.from(document.querySelectorAll('.base-select-button'));
        const t = btns.find((b) => (b.querySelector('.base-select-label')?.textContent || '').trim() === lb);
        if (t && t instanceof HTMLElement) {
          t.click();
          return true;
        }
        return false;
      }, label)
      .catch(() => false);
    if (ok) {
      await delay(400 + Math.random() * 200);
      return true;
    }
    await delay(500);
  }
  return false;
}

/** 在可见 dialog 弹窗内点击文本匹配的级联项（li.cascader_panel_item；精确 → 省/市后缀 → 包含 三级容错） */
async function pickDialogItem(page: Page, text: string): Promise<boolean> {
  const ok = await page
    .evaluate((txt) => {
      const vis = Array.from(document.querySelectorAll('.el-dialog__wrapper')).filter((d) => {
        const r = d.getBoundingClientRect();
        return r.width > 100 && r.height > 50;
      });
      // 变体：精确 → 去掉省/市后缀（广州市→广州、广东省→广东）
      const variants = [txt, txt.replace(/(省|市|自治区|自治州)$/, '')];
      for (const d of vis) {
        const items = Array.from(d.querySelectorAll('li.cascader_panel_item'));
        // 1) 精确匹配
        for (const v of variants) {
          const it = items.find((x) => (x.textContent || '').trim() === v);
          if (it && it instanceof HTMLElement) {
            it.click();
            return true;
          }
        }
        // 2) 包含匹配（行业/职能类长名称容错，取首个命中）
        const it2 = items.find((x) => (x.textContent || '').trim().includes(txt));
        if (it2 && it2 instanceof HTMLElement) {
          it2.click();
          return true;
        }
      }
      return false;
    }, text)
    .catch(() => false);
  await delay(400 + Math.random() * 300);
  return ok;
}

/** 点击可见 dialog 弹窗的「确 定」按钮 */
async function confirmDialog(page: Page): Promise<boolean> {
  const ok = await page
    .evaluate(() => {
      const vis = Array.from(document.querySelectorAll('.el-dialog__wrapper')).filter((d) => {
        const r = d.getBoundingClientRect();
        return r.width > 100 && r.height > 50;
      });
      for (const d of vis) {
        const btns = Array.from(d.querySelectorAll('button'));
        const b = btns.find((x) => (x.textContent || '').trim().replace(/\s+/g, '') === '确定');
        if (b && b instanceof HTMLElement) {
          b.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  await delay(400 + Math.random() * 200);
  return ok;
}

/** 在 popover 弹层内点击文本匹配的选项（.option-item，轮询等待弹层） */
async function pickPopperOption(page: Page, option: string): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    const found = await page
      .evaluate((opt) => {
        const items = Array.from(document.querySelectorAll('.base-select-popper .option-item'));
        const it = items.find((x) => (x.textContent || '').trim() === opt);
        if (it && it instanceof HTMLElement) {
          it.click();
          return true;
        }
        return null;
      }, option)
      .catch(() => null);
    if (found) {
      await delay(300);
      return true;
    }
    await delay(400);
  }
  warn(`未找到选项「${option}」（可运行 51job probe 校准选择器）`);
  return false;
}

/** 按 placeholder 定位输入框并原生 setter 输入（Vue 响应：input + change + 失焦确认） */
async function fillInputByPlaceholder(page: Page, placeholder: string, value: string): Promise<boolean> {
  const ok = await page
    .evaluate(
      ({ ph, val }) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const el = inputs.find((i) => i.getAttribute('placeholder') === ph);
        if (el && el instanceof HTMLInputElement && !el.disabled) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          // 失焦触发 Vue 提交
          el.blur();
          return true;
        }
        return false;
      },
      { ph: placeholder, val: value }
    )
    .catch(() => false);
  await delay(300 + Math.random() * 200);
  return ok;
}

/** 检查按 placeholder 定位的输入框是否禁用 */
async function isInputDisabled(page: Page, placeholder: string): Promise<boolean> {
  return page
    .evaluate((ph) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const el = inputs.find((i) => i.getAttribute('placeholder') === ph);
      return el ? el.disabled : true;
    }, placeholder)
    .catch(() => true);
}

/** el-select 下拉选择：点击输入框展开 → 在 .el-select-dropdown 点文本匹配项（性别/求职状态等） */
async function pickElSelect(page: Page, placeholder: string, value: string): Promise<boolean> {
  await page
    .evaluate((ph) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const el = inputs.find((i) => i.getAttribute('placeholder') === ph);
      if (el) el.click();
    }, placeholder)
    .catch(() => {});
  await delay(500 + Math.random() * 300);

  for (let i = 0; i < 10; i++) {
    const found = await page
      .evaluate((val) => {
        const vis = Array.from(document.querySelectorAll('.el-select-dropdown')).filter((d) => {
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        for (const d of vis) {
          const items = Array.from(d.querySelectorAll('.el-select-dropdown__item'));
          const it = items.find((x) => (x.textContent || '').trim() === val);
          if (it && it instanceof HTMLElement) {
            it.click();
            return true;
          }
        }
        return null;
      }, value)
      .catch(() => null);
    if (found) {
      await delay(300);
      return true;
    }
    await delay(400);
  }
  warn(`未找到「${placeholder}」的选项「${value}」`);
  return false;
}

/**
 * 应用人才搜索筛选参数（在输入关键词后、点搜索前调用）。
 * 支持三类控件：popover 下拉、dialog 弹窗（多选）、输入框直填。
 */
export async function applySearchFilters(page: Page, filters: SearchFilters): Promise<void> {
  // 关闭可能残留的弹窗（前一次命令/交互遗留），避免遮挡筛选控件
  await page.keyboard.press('Escape').catch(() => {});
  await delay(500);

  // 1) popover 式下拉（工作年限/年龄/学历要求/学校性质/期望月薪），多值循环重开
  for (const key of ['exp', 'age', 'edu', 'school', 'salary'] as const) {
    const val = filters[key];
    if (!val) continue;
    const label = POPOVER_SELECTS[key]!;
    for (const v of val.split(/[,，]/)) {
      const vv = v.trim();
      if (!vv) continue;
      out(`设置筛选：${label} = ${vv}`);
      if (!(await clickBaseSelect(page, label))) warn(`未定位到筛选控件「${label}」`);
      await pickPopperOption(page, vv);
    }
  }

  // 2) el-select 下拉（性别/求职状态）+ 输入框直填（期望工作地，页面可能禁用）
  if (filters.gender) {
    out(`设置筛选：性别 = ${filters.gender}`);
    await pickElSelect(page, '性别', filters.gender);
  }
  if (filters.status) {
    out(`设置筛选：求职状态 = ${filters.status}`);
    await pickElSelect(page, '求职状态', filters.status);
  }
  if (filters.city) {
    if (await isInputDisabled(page, '期望工作地')) {
      warn('期望工作地输入框当前为禁用状态（可能需先在职位/订阅中配置），--city 已跳过');
    } else {
      out(`设置筛选：期望工作地 = ${filters.city}`);
      await fillInputByPlaceholder(page, '期望工作地', filters.city);
    }
  }

  // 3) dialog 式弹窗（期望行业/期望职能/从事行业/从事职能），多选+确定
  for (const key of ['industry', 'func', 'workIndustry', 'workFunc'] as const) {
    const val = filters[key];
    if (!val) continue;
    const label = DIALOG_SELECTS[key]!;
    out(`设置筛选：${label} = ${val}`);
    if (!(await clickBaseSelect(page, label))) warn(`未定位到筛选控件「${label}」`);
    for (const v of val.split(/[,，]/)) {
      const vv = v.trim();
      if (!vv) continue;
      if (!(await pickDialogItem(page, vv))) warn(`弹窗内未找到「${vv}」`);
    }
    await confirmDialog(page);
  }

  // 4) 居住地级联（省,市,区）
  if (filters.residence) {
    out(`设置筛选：居住地 = ${filters.residence}`);
    if (!(await clickBaseSelect(page, '居住地'))) warn(`未定位到筛选控件「居住地」`);
    for (const level of filters.residence.split(/[,，]/)) {
      const lv = level.trim();
      if (!lv) continue;
      if (!(await pickDialogItem(page, lv))) warn(`居住地级联未找到「${lv}」`);
      await delay(500);
    }
    await confirmDialog(page);
  }
}

/**
 * 在人才搜索页按关键词搜索。
 * 若当前不在搜索页（/Revision/talent/search），自动 goto 直达。
 * 输入框为 el-input（Vue），需原生 setter + input 事件驱动数据绑定。
 */
export async function searchTalents(
  page: Page,
  keyword: string,
  opts: { throttle?: Throttle; filters?: SearchFilters } = {}
): Promise<void> {
  await assertNoRisk(page, { action: '人才搜索', soft: true });

  const s = selectors.search;
  const current = page.url();
  // 人才搜索页判定：只有「人才搜索」页才不导航；「人才望远镜」推荐页（search-recommend，
  // includes('/search') 会误命中）及任何其他页一律 goto 直达搜索页。
  const isSearchPool = current.includes('/Revision/talent/search') && !current.includes('/Revision/talent/search-recommend');
  if (!isSearchPool) {
    out(`导航到人才搜索页…`);
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  }

  // 等待搜索框挂载（SPA 首屏渲染）
  const ok = await waitForSelector(page, s.keywordInput, 15000);
  if (!ok) {
    warn('未定位到搜索框。请运行 51job probe 校准选择器。');
    return;
  }
  await delay(500);

  // 原生 setter + input 事件（Vue 绑定）
  await page.evaluate((kw) => {
    const box = document.querySelector('.talent_search_keywords_input input') as HTMLInputElement | null;
    if (box) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(box, kw);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, keyword);
  await delay(300 + Math.random() * 300);
  if (opts.throttle) await opts.throttle.wait();

  // 应用筛选参数（点搜索前）
  if (opts.filters) {
    await applySearchFilters(page, opts.filters);
  }

  // 点搜索按钮（兜底：无按钮时回车）
  const btn = await page.$(s.searchBtn);
  if (btn) {
    await btn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  // 等待结果出现：结果卡片或「无结果」提示
  const got = await waitForSelector(page, `${s.resultList} ${s.resultItem}`, 12000);
  if (!got) await waitForSelector(page, s.noResult, 5000);
  await delay(500 + Math.random() * 500);
}

/** 从卡片文本提取画像（年龄/经验/学历） */
function parseProfile(text: string): { age?: string; exp?: string; edu?: string } {
  const age = text.match(/(\d{1,2})岁/);
  const exp = text.match(/(\d{1,2})年/);
  const edu = text.match(/(博士|硕士|本科|大专|中专|高中|初中)/);
  return {
    age: age ? age[1] : undefined,
    exp: exp ? exp[1] : undefined,
    edu: edu ? edu[1] : undefined,
  };
}

/**
 * 读取当前搜索结果列表（.list-box 下的 .resume-card 卡片）。
 */
export async function readSearchResults(page: Page, opts: { throttle?: Throttle } = {}): Promise<SearchHit[]> {
  await assertNoRisk(page, { action: '读取搜索结果', soft: true });
  if (opts.throttle) await opts.throttle.wait();

  const s = selectors.search;

  // 无结果提示存在 → 空结果
  const noResult = await page.$(s.noResult).catch(() => null);
  if (noResult) {
    warn('本次搜索无匹配人才（页面提示：没有搜索到相关的人才）。');
    return [];
  }

  const items = await page.$$(`${s.resultList} ${s.resultItem}`).catch(() => []);
  if (items.length === 0) {
    warn('未定位到搜索结果条目。请确认已执行搜索，或运行 51job probe 校准选择器。');
    return [];
  }

  const hits: SearchHit[] = [];
  for (let i = 0; i < items.length; i++) {
    const info = await items[i]
      .evaluate((el, sel) => {
        const txt = (selector: string) => {
          const f = el.querySelector(selector);
          return f ? (f.textContent || '').trim().replace(/\s+/g, ' ') : '';
        };
        const expectRaw0 = txt(sel.expect).replace(/^求职意向[:：]?\s*/, '');
        // 去掉状态标签（.expect_gray 在 .expect 内部，如「已转发」「来源于推荐」）
        const flag = txt(sel.expectGray).trim();
        let expectRaw = flag ? expectRaw0.replace(flag, '') : expectRaw0;
        // 去掉距离噪声（（距离:xx公里）/（距离:>35公里））与残留状态词
        expectRaw = expectRaw
          .replace(/（距离[^）]*）/g, '')
          .replace(/(已转发|来源于推荐|推荐|已聊)$/g, '')
          .trim();
        // 期望薪资：支持「1.1-1.3万/月」「7.6千-1.1万/月」「8千-1.2万/月」「面议」（混合单位）
        const salaryMatch = expectRaw.match(/(\d+(?:\.\d+)?(?:千|万)?-\d+(?:\.\d+)?(?:千|万)?\/月|面议)/);
        const salary = salaryMatch ? salaryMatch[1] : '';
        // 期望职位：薪资之前的职位词（去掉开头地点段）
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
    });
  }
  return hits;
}

export function searchToRows(hits: SearchHit[]): Row[] {
  return hits.map((h) => ({
    '#': h.index,
    姓名: h.name,
    期望职位: h.job || '',
    公司: h.company || '',
    画像: (h.meta || '').slice(0, 60),
  }));
}

/**
 * 在人才搜索页发起搜索（自动导航 + 可选 13 维筛选），并等结果列表稳定。
 * 供 search / greet（含 --by-index 详情管线）复用。
 */
export async function ensureSearchPool(
  page: Page,
  keyword: string,
  opts: { throttle?: Throttle; filters?: SearchFilters } = {}
): Promise<boolean> {
  await searchTalents(page, keyword, opts);
  const s = selectors.search;
  const got = await waitForSelector(page, `${s.resultList} ${s.resultItem}`, 12000).catch(() => null);
  if (!got) {
    await waitForSelector(page, s.noResult, 3000).catch(() => null);
    return false;
  }
  await delay(600 + Math.random() * 400);
  return true;
}

/**
 * 在当前搜索结果中定位候选人卡片序号（1-based）。
 * @returns 命中卡片序号（1-based），失败返回 0
 */
export async function locateCandidate(
  page: Page,
  opts: { name?: string; index?: number } = {}
): Promise<number> {
  const s = selectors.search;
  const items = await page.$$(`${s.resultList} ${s.resultItem}`).catch(() => []);
  if (opts.index != null) {
    if (opts.index < 1 || opts.index > items.length) {
      warn(`--by-index ${opts.index} 超出范围（列表共 ${items.length} 条）`);
      return 0;
    }
    return opts.index;
  }
  if (!opts.name) {
    warn('请提供姓名或 --by-index 序号');
    return 0;
  }
  for (let i = 0; i < items.length; i++) {
    const text = await items[i].evaluate((el) => el.textContent || '').catch(() => '');
    if (text.includes(opts.name)) {
      return i + 1;
    }
  }
  warn(`未在 ${items.length} 条结果中定位到「${opts.name}」`);
  return 0;
}

/**
 * greetTalent 结果：outcome + 详情管线拿到的简历详情。
 * JSON 模式下命令层把 detail 并入最终单文档输出（T103），本函数不再自行 printJson。
 */
export interface GreetResult {
  outcome: HiOutcome;
  detail?: CandidateDetail;
}

/**
 * 对候选人打招呼（支持「先看详情再 Hi」）。
 * - 定位：`opts.index`（列表序号，1-based）或 `name`（文本匹配）
 * - 前置筛选：`opts.filters` 复用 search 的 13 维筛选
 * - 详情管线（传入 browser 时）：开详情 → 摘要 → 人机确认 → 详情页 Hi
 *   - `browser` 为空时回退旧路径：卡片「立即Hi聊」一键
 * - `--dry-run`：只看详情 + 摘要，不 Hi（返回 dry_run）
 * @returns GreetResult（outcome：success / quota_exhausted / failed / unknown / dry_run / cancelled）
 */
export async function greetTalent(
  page: Page,
  name: string,
  opts: {
    job?: string;
    throttle?: Throttle;
    filters?: SearchFilters;
    index?: number;
    dryRun?: boolean;
    confirm?: boolean;
    browser?: Browser;
  } = {}
): Promise<GreetResult> {
  await assertNoRisk(page, { action: `对 ${name || `第${opts.index}位候选人`} 打招呼`, soft: false });
  const throttle = opts.throttle;
  if (throttle) await throttle.wait();

  // 0) 无结果时保底搜索（兼容旧调用：不传 filters 也自主导航）
  const got = await ensureSearchPool(page, opts.job || name, { throttle, filters: opts.filters });
  if (!got) {
    warn(`搜索「${opts.job || name}」无结果，请调整关键词或筛选后重试。`);
    return { outcome: 'failed' };
  }

  // 1) 定位卡片
  const idx = await locateCandidate(page, { name, index: opts.index });
  if (!idx) return { outcome: 'failed' };

  // 2) 详情管线（有 browser 时）：开详情 → 展示 → 决策 → Hi
  if (opts.browser) {
    const opened = await openDetailByIndex(opts.browser, page, idx, { throttle });
    if (!opened) {
      warn('详情页打开或提取失败');
      return { outcome: 'failed' };
    }
    const { page: detailPage, detail } = opened;
    trackExtraPage(detailPage); // 统一清理详情 tab
    // 摘要输出：text 模式在此打印；JSON 模式的详情由命令层并入单文档结果（T103）
    if (getFormat() !== 'json') {
      out(detailToSummary(detail));
    }
    // 决策
    if (opts.dryRun) {
      out('--dry-run：已查看详情，未发出打招呼');
      return { outcome: 'dry_run', detail };
    }
    const targetName = detail.name || name || `候选人${idx}`;
    const yes = opts.confirm !== false
      ? await confirmAction(`是否对「${targetName}」发出打招呼？`)
      : true;
    if (!yes) {
      out(`已跳过「${targetName}」，未打招呼`);
      return { outcome: 'cancelled', detail };
    }
    return { outcome: await hiChatOnDetail(detailPage, { throttle }), detail };
  }

  // 3) 无 browser：旧路径，列表卡片内「立即Hi聊」直接点 + 结果校验
  const s = selectors.search;
  const card = (await page.$$(`${s.resultList} ${s.resultItem}`).catch(() => []))[idx - 1];
  const clicked = await card
    .evaluate((el) => {
      const all = Array.from(el.querySelectorAll('button, div, span'));
      const target = all.find((b) => (b.textContent || '').trim() === '立即Hi聊');
      if (target && target instanceof HTMLElement) {
        target.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (clicked) {
    out(`已点击「${name || `第${idx}位候选人`}」的「立即Hi聊」，校验结果…`);
    return { outcome: await detectHiResult(page, { btnText: `${s.resultList} ${s.resultItem} button` }) };
  }
  warn('已在列表中定位到候选人，但未找到「立即Hi聊」按钮');
  return { outcome: 'failed' };
}
