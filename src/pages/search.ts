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

/**
 * 「期望工作地」级联选择（2026-08-28 实测校正）：
 * 搜索页头部期望工作地输入框是 **readonly/disabled 只读**，不能直填；
 * 正确交互是点击容器（.talent_search_address）弹出级联弹窗（.eh_cascader_dialog），
 * 逐级点省/市（li.cascader_panel_item）再点「确定」。
 * @param levels 省/市级联序列，如 ['广东省','湛江'] 或 ['湛江']（只有市级时第一级找不到会在第二级命中）
 */
async function pickCityByCascader(page: Page, levels: string[]): Promise<void> {
  // 幂等：输入框已回显目标市 → 跳过
  const cur = await page.evaluate(() => (document.querySelector('.talent_search_address input') as HTMLInputElement | null)?.value || '').catch(() => '');
  const targetCity = levels[levels.length - 1] || '';
  if (cur.trim() === targetCity) {
    out(`筛选「期望工作地 = ${targetCity}」已设置（幂等跳过）`);
    return;
  }

  // 点容器打开弹窗
  const opened = await page
    .evaluate(() => {
      const el = document.querySelector('.talent_search_address, .talent_search_address_elinput') as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    })
    .catch(() => false);
  if (!opened) { warn('未定位到「期望工作地」选择控件'); return; }
  await delay(800 + Math.random() * 400);

  // 逐级选省/市（弹窗 .eh_cascader_dialog 内的 li.cascader_panel_item）
  for (const lv of levels) {
    await pickDialogItem(page, lv);
    await delay(500);
  }
  await confirmDialog(page);
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
 *
 * 幂等（2026-08-28 实测）：筛选设置过之后按钮 label 会被替换为选中值
 * （「居住地」→「湛江」「学历要求」→「本科及以上」），再按原 label 找会得到
 * 「未定位到筛选控件」。因此在点击前先读当前全部 label，若目标值已在其中
 * 则视为已设置、跳过（避免空转 10s 与 warn 误导）。
 */
export async function applySearchFilters(page: Page, filters: SearchFilters): Promise<void> {
  // 关闭可能残留的弹窗（前一次命令/交互遗留），避免遮挡筛选控件
  await page.keyboard.press('Escape').catch(() => {});
  await delay(500);

  // 幂等基线：当前已设置的筛选值（按钮 label，如「湛江」「本科及以上」）
  const appliedLabels = await page
    .evaluate(() => Array.from(document.querySelectorAll('.base-select-button .base-select-label')).map((x) => (x.textContent || '').trim()))
    .catch(() => [] as string[]);
  const alreadyApplied = (value: string): boolean =>
    appliedLabels.some((l) => l && l === value) || appliedLabels.some((l) => l && l.includes(value));

  // 1) popover 式下拉（工作年限/年龄/学历要求/学校性质/期望月薪），多值循环重开
  for (const key of ['exp', 'age', 'edu', 'school', 'salary'] as const) {
    const val = filters[key];
    if (!val) continue;
    const label = POPOVER_SELECTS[key]!;
    for (const v of val.split(/[,，]/)) {
      const vv = v.trim();
      if (!vv) continue;
      if (alreadyApplied(vv)) {
        out(`筛选「${label} = ${vv}」已设置（幂等跳过）`);
        continue;
      }
      out(`设置筛选：${label} = ${vv}`);
      if (!(await clickBaseSelect(page, label))) warn(`未定位到筛选控件「${label}」`);
      await pickPopperOption(page, vv);
    }
  }

  // 2) el-select 下拉（性别/求职状态）+ 期望工作地（touch：点容器弹级联选择器）
  if (filters.gender) {
    out(`设置筛选：性别 = ${filters.gender}`);
    await pickElSelect(page, '性别', filters.gender);
  }
  if (filters.status) {
    out(`设置筛选：求职状态 = ${filters.status}`);
    await pickElSelect(page, '求职状态', filters.status);
  }
  if (filters.city) {
    // 实测（2026-08-28）：「期望工作地」输入框为只读/禁用（readonly disabled），
    // **不能直填**——正确交互是点击容器（.talent_search_address）弹出级联弹窗选城市。
    // 页面上带 `-区` 的就取市级；无则原样。支持「省,市」两级（如 广东省,湛江）。
    out(`设置筛选：期望工作地 = ${filters.city}`);
    const levels = filters.city.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    await pickCityByCascader(page, levels);
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
    // 幂等：市名已显示在按钮 label（如「湛江」）→ 已设置过，跳过
    const cityName = filters.residence.split(/[,，]/).pop()?.trim() || filters.residence;
    if (alreadyApplied(cityName)) {
      out(`筛选「居住地」已设置（幂等跳过）`);
    } else {
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
}

/**
 * 在人才搜索页按关键词搜索。
 * 若当前不在搜索页（/Revision/talent/search），自动 goto 直达。
 * 输入框为 el-input（Vue），需原生 setter + input 事件驱动数据绑定。
 *
 * @param opts.position   显式职位范围（search --position）：职位名即搜索词，且 tag 锁定该职位。
 *                        命令层已保证与 keyword 互斥（T112 grilling 决议），这里兜底优先。
 * @param opts.fallbackToUnlimited 职位 tag 匹配不到时是否切「不限职位」清池（默认 true，Q9a 决议；
 *                        --position 且职位卡已找到时上层传 false——清池会破坏注入校准）。
 * @returns JobScopeResult：matched=范围锁定目标职位 / unlimited=全池 / kept=仍停留原范围
 */
export async function searchTalents(
  page: Page,
  keyword: string,
  opts: {
    throttle?: Throttle;
    filters?: SearchFilters;
    position?: string;
    fallbackToUnlimited?: boolean;
  } = {}
): Promise<JobScopeResult> {
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
    return 'kept';
  }
  await delay(500);

  const kw = opts.position ?? keyword;

  // 原生 setter + input 事件（Vue 绑定）
  await page.evaluate((kw) => {
    const box = document.querySelector('.talent_search_keywords_input input') as HTMLInputElement | null;
    if (box) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(box, kw);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, kw);
  await delay(300 + Math.random() * 300);
  if (opts.throttle) await opts.throttle.wait();

  // 确保搜索范围是目标职位（2026-08-28 实测：搜索页有「当前选中职位」tag（.cur_selected_job_tag），
  // goto 后残留上次职位的选中态（如上次搜「市政造价员」就锁死该职位人才池）→ 结果被污染。
  // 关键词填入后再切——「搜索词匹配职位」分组会随关键词刷新，此时才能匹配到目标项。
  const scope = await selectJobForKeyword(page, kw, { fallbackToUnlimited: opts.fallbackToUnlimited !== false });

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
  return scope;
}

/** 读取「当前选中职位」tag 的职位名（空串=无选中/全池） */
async function readJobTagName(page: Page): Promise<string> {
  return page
    .evaluate((sel) => (document.querySelector(sel)?.textContent || '').trim(), '.cur_selected_job_tag .cur_selected_job_tag_jobname')
    .catch(() => '');
}

/** 打开「当前选中职位」职位下拉（真实鼠标点击 tag，DOM .click() 不触发 Vue 绑定） */
async function openJobTagDropdown(page: Page): Promise<boolean> {
  const box = await page
    .evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, '.cur_selected_job_tag')
    .catch(() => null);
  if (box && box.w > 0) {
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    await delay(800 + Math.random() * 400);
    return true;
  }
  warn('未定位到「当前选中职位」控件（搜索范围可能残留）');
  return false;
}

/** 在职位下拉（.talent_search_select_job_dropdown）内按文本点职位项：精确匹配优先，其次包含匹配 */
async function pickJobDropdownItem(page: Page, text: string): Promise<string> {
  const picked = await page
    .evaluate((txt) => {
      const names = Array.from(document.querySelectorAll('.talent_search_select_job_dropdown .job-item-name'));
      // 精确匹配优先（trim 后全等）；再退一步包含匹配
      let n = names.find((x) => (x.textContent || '').trim() === txt);
      if (!n) n = names.find((x) => (x.textContent || '').includes(txt));
      const item = n?.closest('.job-item') as HTMLElement | null;
      if (item) { item.click(); return item.textContent?.trim().slice(0, 30) ?? ''; }
      return '';
    }, text)
    .catch(() => '');
  await delay(400 + Math.random() * 300);
  return picked;
}

/**
 * 把搜索范围切到「不限职位」（全池）——清除残留的职位 tag（2026-08-28 用户确认下拉存在此选项）。
 * 幂等：tag 已为空/不限职位 → 直接成功。
 * @returns 切换成功与否
 */
async function ensureUnlimitedJob(page: Page): Promise<boolean> {
  const cur = await readJobTagName(page);
  if (cur === '' || cur === '不限职位') return true; // 幂等：已全池

  // 下拉可能还开着（前一步刚点过 tag）：先直接在里面找「不限职位」项
  if (await pickJobDropdownItem(page, '不限职位')) {
    await delay(1200 + Math.random() * 600);
    const now = await readJobTagName(page);
    if (now === '' || now === '不限职位') {
      out('搜索范围已切换至「不限职位」（全池）');
      return true;
    }
  }
  // 回退：重新打开下拉再找
  if (!(await openJobTagDropdown(page))) return false;
  const picked = await pickJobDropdownItem(page, '不限职位');
  if (!picked) {
    warn('职位下拉中未找到「不限职位」项（搜索范围可能残留）');
    return false;
  }
  await delay(1200 + Math.random() * 600);
  const now = await readJobTagName(page);
  if (now === '' || now === '不限职位') {
    out('搜索范围已切换至「不限职位」（全池）');
    return true;
  }
  warn(`点击「不限职位」后 tag 未更新（当前「${now || '?'}」）`);
  return false;
}

/** 职位范围锁定结果（T112 grilling 决议：供命令层 JSON 可观测） */
export type JobScopeResult = 'matched' | 'unlimited' | 'kept';

/**
 * 把搜索范围切到与关键词匹配的职位（2026-08-28 实测发现的关键污染源）。
 * 搜索页顶部有「当前选中职位」tag（.cur_selected_job_tag），goto 后**残留上次职位的选中态**
 * （如上次搜「市政造价员」，本次哪怕关键词填「销售主管」，搜索也锁在市政造价员人才池——
 * 结果全是被职位过滤后的造价/预结算背景）。本函数：
 * 1. tag 已等于目标 → 幂等返回 'matched'；
 * 2. 否则点 tag 打开职位下拉（.talent_search_select_job_dropdown，真实鼠标点击，
 *    因 DOM .click() 不触发 Vue 绑定），在「搜索词匹配职位/我的职位/组织下职位」分组里
 *    找 `.job-item-name` 文本匹配关键词的项并点击；
 * 3. 找不到匹配职位项（人名/技能词搜索）→ grilling 决议（Q9a/Q6c）：**切「不限职位」清池**
 *    （替代原「warn 保留残留」——根治残留锁池）——除非 fallbackToUnlimited=false
 *    （--position 且职位卡已找到的异常路径：清池会破坏注入，保留当前范围并 warn）。
 * @returns JobScopeResult：matched=已锁定目标职位 / unlimited=已切全池 /
 *          kept=仍停留原范围（切换失败或显式保留）
 */
export async function selectJobForKeyword(
  page: Page,
  keyword: string,
  opts: { fallbackToUnlimited?: boolean } = {},
): Promise<JobScopeResult> {
  const kw = keyword.trim();
  const cur = await readJobTagName(page);
  if (cur === kw) return 'matched'; // 幂等：已选中目标职位

  // 打开职位下拉（真实鼠标点击 tag）
  if (!(await openJobTagDropdown(page))) {
    if (cur === '' || cur === '不限职位') return 'unlimited'; // 无法打开但已在全池 = 已清
    return 'kept';
  }

  // 找匹配职位项并点击
  const picked = await pickJobDropdownItem(page, kw);
  if (picked) {
    await delay(1200 + Math.random() * 600);
    const now = await readJobTagName(page);
    if (now === kw) {
      out(`搜索范围已切换至职位「${kw}」`);
      return 'matched';
    }
    warn(`点击职位项后 tag 未更新（当前「${now || '?'}」），范围可能仍残留`);
    return 'kept';
  }

  // 无匹配职位项：人名/技能词搜索
  if (opts.fallbackToUnlimited === false) {
    // 显式职位（--position 且职位管理页已找到卡）：清池会破坏注入校准，保留当前范围并提示
    warn(`职位下拉中无「${kw}」项（职位管理页已定位到该职位，疑似下拉同步问题），保留当前范围`);
    return 'kept';
  }
  // Q9a/Q6c 决议：匹配不到 → 切「不限职位」清池（根治残留锁池：搜人名/技能词 = 全池，语义正确）
  const ok = await ensureUnlimitedJob(page);
  return ok ? 'unlimited' : 'kept';
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
 * 搜索结果全量收集（2026-08-28 实测虚拟列表）：
 * 搜索页列表是**虚拟滚动**——DOM 只保留视口 ~30 张卡，滚动时**复用节点替换内容**
 * （同一 .item.resume-card 节点换姓名/经历），配合分页接口（talent_hunt_resume_list，
 * page_index/page_size=50）。因此「先滚到底再读 DOM」只会拿到底部 30 张——前面的人全丢。
 *
 * 正确姿势：**边慢滚边收集**——每滚一段（真实滚轮，模拟真人阅读节奏），把当前视口
 * 可见卡片解析并入集合（按姓名去重），再继续滚；滚到底且连续 3 轮不再发现新人即收敛。
 * 慢节奏 + 随机停顿是为等分页接口响应与渲染（用户实测建议）。
 *
 * @returns 按首次发现顺序去重的搜索命中（含画像字段，后续再拼 meta）
 */
async function collectLoadedSearchCards(
  page: Page,
  itemSel: string,
  cardSels: { expect: string; name: string; company: string; active: string; address: string; expectGray: string; desc: string },
): Promise<Array<{
  name: string; expect: string; salary: string; job: string; company: string;
  active: string; address: string; flag: string; userinfo: string;
}>> {
  const STABLE_ROUNDS = 3;      // 连续几轮「滚到底无新人」视为收敛
  const MAX_STEPS = 400;        // 上限守卫（2289 条 / 每轮 ~10 人 ≈ 230 轮够用）
  const MAX_MS = 20 * 60_000;   // 总时限守卫 20min
  const WHEEL_DELTA = 380;      // 每次滚轮像素（约一屏 1/3，真人阅读节奏）

  const seen = new Set<string>();
  const collected: Array<{
    name: string; expect: string; salary: string; job: string; company: string;
    active: string; address: string; flag: string; userinfo: string;
  }> = [];

  const collectCurrent = async (): Promise<void> => {
    const rows = await page
      .evaluate((sel, sels) => {
        const out: Array<Record<string, string>> = [];
        const nameSel = sels.name, expectSel = sels.expect, expectGraySel = sels.expectGray;
        const companySel = sels.company, activeSel = sels.active, addressSel = sels.address, descSel = sels.desc;
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const txt = (selector: string) => {
            const f = el.querySelector(selector);
            return f ? (f.textContent || '').trim().replace(/\s+/g, ' ') : '';
          };
          const name = txt(nameSel);
          if (!name) continue;
          let expectRaw0 = txt(expectSel).replace(/^求职意向[:：]?\s*/, '');
          const flag = txt(expectGraySel).trim();
          let expectRaw = flag ? expectRaw0.replace(flag, '') : expectRaw0;
          expectRaw = expectRaw
            .replace(/（距离[^）]*）/g, '')
            .replace(/(已转发|来源于推荐|推荐|已聊)$/g, '')
            .trim();
          const salaryMatch = expectRaw.match(/(\d+(?:\.\d+)?(?:千|万)?-\d+(?:\.\d+)?(?:千|万)?\/月|面议)/);
          const salary = salaryMatch ? salaryMatch[1] : '';
          const jobPart = salary ? expectRaw.replace(salary, '').trim() : expectRaw.trim();
          const job = jobPart.replace(/^[一-龥·,，、\s]+/, '').trim() || jobPart.trim();
          out.push({
            name, expect: expectRaw, salary, job,
            company: txt(companySel),
            active: txt(activeSel),
            address: txt(addressSel),
            flag,
            desc: txt(descSel),
            userinfo: txt('.userinfo'),
          });
        }
        return out;
      }, itemSel, cardSels)
      .catch(() => [] as Array<Record<string, string>>);
    for (const r of rows) {
      if (r.name && !seen.has(r.name)) {
        seen.add(r.name);
        collected.push(r as { name: string; expect: string; salary: string; job: string; company: string; active: string; address: string; flag: string; userinfo: string });
      }
    }
  };

  // 滚回顶部
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('div,section'))) {
      if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await delay(800 + Math.random() * 500);
  await collectCurrent();
  if (collected.length === 0) return collected;

  // 鼠标悬停到列表区，让滚轮落在可滚动容器上
  await page.mouse.move(960, 450).catch(() => {});
  await delay(300);

  const deadline = Date.now() + MAX_MS;
  let stable = 0;
  let lastCount = collected.length;
  for (let step = 0; step < MAX_STEPS && Date.now() < deadline; step++) {
    // 慢滚一小段（模拟真人阅读节奏），随机停顿等接口响应+渲染
    await page.mouse.wheel({ deltaY: WHEEL_DELTA + Math.round(Math.random() * 200) }).catch(() => {});
    await delay(1400 + Math.random() * 900);

    await collectCurrent();
    if (collected.length === lastCount) {
      // 此轮无新人：判断是否已到底（再滚一步看 scrollTop 是否还会变）
      const canScroll = await page
        .evaluate(() => {
          let moved = false;
          for (const el of Array.from(document.querySelectorAll('div,section'))) {
            if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
              const before = el.scrollTop;
              el.scrollTop += 300;
              if (el.scrollTop !== before) moved = true;
            }
          }
          const wb = window.scrollY;
          window.scrollBy(0, 300);
          if (window.scrollY !== wb) moved = true;
          return moved;
        })
        .catch(() => false);
      if (!canScroll) {
        stable++;
        if (stable >= STABLE_ROUNDS) break;
      } else {
        stable = 0; // 还能滚但没新人，继续看
      }
    } else {
      lastCount = collected.length;
      stable = 0;
    }
  }

  if (stable < STABLE_ROUNDS && collected.length > 0) {
    warn(`搜索列表滚动收集达步数/时限上限（已收 ${collected.length} 人），可能未走完全部`);
  }
  return collected;
}

/**
 * 读取当前搜索结果列表（.list-box 下的 .resume-card 卡片）。
 * 列表是**虚拟滚动**（DOM 只留视口 ~30 卡，滚动替换内容）。
 * - 默认（all=false）：只读首屏 ~30 人——形成候选池够用；后续用台账 resumeId 直链操作
 *   （2026-08-28 决议：全量滚动 20min 代价大且**易触发风控**，先读首屏，需要全量时显式 --all）
 * - all=true：边慢滚边收集全量（collectLoadedSearchCards，去重合并，可达数百人，
 *   耗时分钟级；⚠️ 滚动采集行为易被风控识别，非必要不使用）。返回按首次发现顺序的候选人。
 */
export async function readSearchResults(page: Page, opts: { throttle?: Throttle; all?: boolean } = {}): Promise<SearchHit[]> {
  await assertNoRisk(page, { action: '读取搜索结果', soft: true });
  if (opts.throttle) await opts.throttle.wait();

  const s = selectors.search;

  // 无结果提示存在 → 空结果
  const noResult = await page.$(s.noResult).catch(() => null);
  if (noResult) {
    warn('本次搜索无匹配人才（页面提示：没有搜索到相关的人才）。');
    return [];
  }

  // 有滚动空间且显式 --all → 边慢滚边收集全量（虚拟列表）；否则直接读首屏
  const hasScroll = opts.all
    ? await page
        .evaluate(() => {
          for (const el of Array.from(document.querySelectorAll('div,section'))) {
            if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) return true;
          }
          return window.scrollY < (document.documentElement.scrollHeight - window.innerHeight - 50);
        })
        .catch(() => false)
    : false;

  if (hasScroll) {
    const cardSels = {
      expect: s.expect, name: s.name, company: s.company, active: s.active,
      address: s.address, expectGray: s.expectGray, desc: s.desc,
    };
    const collected = await collectLoadedSearchCards(page, `${s.resultList} ${s.resultItem}`, cardSels);
    const hits: SearchHit[] = [];
    for (const r of collected) {
      const prof = parseProfile(r.userinfo);
      const meta = [
        r.address || '',
        prof.age ? `${prof.age}岁` : '',
        prof.exp ? `${prof.exp}年` : '',
        prof.edu || '',
        r.active || '',
        r.flag || '',
        r.salary || '',
      ]
        .filter(Boolean)
        .join(' | ');
      hits.push({
        index: hits.length + 1,
        name: r.name,
        job: r.job || undefined,
        company: r.company || undefined,
        meta,
        salary: r.salary || undefined,
        city: r.address || undefined,
        active: r.active || undefined,
        flag: r.flag || undefined,
        age: prof.age,
        exp: prof.exp,
        edu: prof.edu,
      });
    }
    return hits;
  }

  // 无滚动空间 → 直接读 DOM 全部卡（原有逻辑）
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
  // T110 输入防护：拒绝空关键词搜索——空串搜索返回不可控结果池，
  // 按序号定位可能作用到错误候选人。防御所有调用方（不只 greet 入口）。
  if (!keyword.trim()) {
    warn('搜索关键词为空（未提供姓名/--job），拒绝建立候选池。请提供姓名或 --job，或先在页面上完成搜索。');
    return false;
  }
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

  // T110 输入防护：姓名/--job/--by-index 至少其一，否则拒绝空关键词兜底搜索
  if (!name && !opts.job && opts.index === undefined) {
    warn('需要姓名、--job 或 --by-index 之一，无法建立候选池');
    return { outcome: 'failed' };
  }

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
    // T106：成功判定只看被点击的这张卡（idx 为 locateCandidate 的 1-based 序号）
    return {
      outcome: await detectHiResult(page, {
        cardSelector: `${s.resultList} ${s.resultItem}`,
        targetIndex: idx - 1,
        btnText: `${s.resultList} ${s.resultItem} button`,
      }),
    };
  }
  warn('已在列表中定位到候选人，但未找到「立即Hi聊」按钮');
  return { outcome: 'failed' };
}
