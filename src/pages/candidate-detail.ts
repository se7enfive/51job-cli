import type { Browser, Page } from 'puppeteer-core';
import { assertNoRisk } from '../core/guard';
import { delay, Throttle } from '../core/throttle';
import { out, warn } from '../utils/output';
import { selectors } from './selectors';
import { detectHiResult, HiOutcome } from './hi-result';

/**
 * 候选人简历详情提取模块。
 *
 * 实测链路（2026-08-26 校准）：
 * 人才搜索结果卡片 `.item.resume-card` → 点击 `.detail` → **新开 tab** 到
 * `/Revision/talent/resume/detail?resumeId=...` → 详情页字段：
 *   - 顶部 `.resume_detail_info`：姓名/活跃/求职状态/年龄/经验/学历/现居
 *   - 求职意向 `.eh_resume_detail_job_intention_wrap`：期望职位/城市/性质/薪资/求职偏好
 *   - 工作经历 `.workExp_item`（`.work_timerange` 时间段 + `.work_content` 职责）
 *   - 教育经历 `.education_wrap`
 *   - 技能 `.tag_skill` / `.skill_label` / `.skill_card_content`
 *   - 动作卡 `.chat_btn`（「立即Hi聊」）
 * 详情页即开即「立即Hi聊」可直接打招呼——这就是「先看再 Hi」的决策点。
 */

export interface WorkExp {
  /** 公司 */
  company?: string;
  /** 职位 */
  position?: string;
  /** 时间段（如「2012.05-2026.02（13年9个月）」） */
  period?: string;
  /** 职责/项目描述 */
  desc?: string;
}

export interface EduExp {
  /** 学校 */
  school?: string;
  /** 学历 */
  degree?: string;
  /** 专业 */
  major?: string;
  /** 时间段 */
  period?: string;
}

export interface CandidateDetail {
  /** 详情页 resumeId（URL 参数） */
  resumeId?: string;
  /** 详情页 URL */
  url?: string;
  name?: string;
  /** 顶部状态区原始文本（活跃/求职状态/年龄/经验/学历/现居/政治面貌） */
  status?: string;
  /** 求职意向（期望职位/城市/性质/薪资） */
  intention?: string;
  /** 求职偏好技能（tag_skill） */
  skills?: string[];
  /** 智能技能明细（skill_label：RTK/全站仪/GPS…） */
  skillLabels?: string[];
  /** 技能卡原始文本 */
  skillCardText?: string;
  work?: WorkExp[];
  edu?: EduExp[];
}

/** 等待选择器出现（轮询） */
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

/** 从 URL 提取 resumeId */
function extractResumeId(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.searchParams.get('resumeId') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 在详情页提取结构化字段。
 * 调用前需已在新开的详情 tab 上，且等待加载完成。
 */
export async function readCandidateDetail(page: Page, opts: { throttle?: Throttle } = {}): Promise<CandidateDetail> {
  await assertNoRisk(page, { action: '读取候选人详情', soft: true });
  if (opts.throttle) await opts.throttle.wait();

  const s = selectors.candidateDetail;

  // 等待详情页就绪（头部信息出现）
  const ok = await waitForSelector(page, s.header, 12000);
  if (!ok) {
    warn('详情页未就绪（未定位到 .resume_detail_info）。可能未登录 / 选择器失效，请运行 51job probe。');
    return {};
  }
  await delay(400 + Math.random() * 300);

  const url = page.url();

  const raw = await page
    .evaluate((sel) => {
      const txt = (el: Element | null | undefined) => (el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '');

      // 顶部信息
      const header = txt(document.querySelector(sel.header)).slice(0, 300);

      // 姓名（.user_name 里第一个非空；可能含「姓名 姓名 活跃」重复，取第一个词）
      let name = '';
      for (const n of Array.from(document.querySelectorAll(sel.name))) {
        const t = txt(n).trim();
        if (t && /[\u4e00-\u9fa5]{2,}/.test(t)) {
          name = t.split(/\s+/)[0];
          break;
        }
      }

      // 求职意向
      const intention = txt(document.querySelector(sel.intention)).slice(0, 300);

      // 工作经历
      const work: { company?: string; position?: string; period?: string; desc?: string }[] = [];
      for (const item of Array.from(document.querySelectorAll(sel.workItem))) {
        const period = txt(item.querySelector(sel.workTimeRange)).replace(/候选人似乎处于离职状态.*$/, '').trim();
        const desc = txt(item.querySelector(sel.workContent));
        let company = '';
        let position = '';
        // 条目文本：公司 职位（如「中建四局…测绘/测量工程施工」），移除岗位标签后缀
        const text = txt(item);
        const lines = text.split(/(?=[A-Za-z]{1,10}[（(]20\d{2}|20\d{2}[.)-])/);
        if (lines.length >= 1) {
          const first = lines[0].trim().replace(/(测绘\/测量|工程测量|测绘|测量|工程师)$/, '').trim();
          const m = first.match(/^(.+?)\s+(.+?)$/);
          if (m) {
            company = m[1].trim();
            position = m[2].trim();
          } else {
            company = first;
          }
        }
        work.push({ company: company || undefined, position: position || undefined, period: period || undefined, desc: desc || undefined });
      }

      // 教育经历（.education_wrap 内多个学校块；过滤「双一流/985/留学」等标签词）
      const eduRaw = txt(document.querySelector(sel.eduWrap));
      const edu: { school?: string; degree?: string; major?: string; period?: string }[] = [];
      if (eduRaw) {
        const skip = /双一流|985|211|留学|全日制|非全日制/;
        const schoolMatch = eduRaw.matchAll(/([\u4e00-\u9fa5·（）]+?(?:大学|学院|学校|职校|技师学院))/g);
        for (const m of schoolMatch) {
          const school = m[1];
          if (!skip.test(school)) {
            // 顺带抓学历（本科/大专/硕士）与专业（在「学校 学历 专业 年份」里）
            const after = eduRaw.slice(eduRaw.indexOf(school) + school.length, eduRaw.indexOf(school) + school.length + 60);
            const degreeM = after.match(/(本科|大专|硕士|博士|中专|高中)/);
            const majorM = after.match(/([\u4e00-\u9fa5·]+?)(?:20\d{2}[.年])/);
            edu.push({
              school: school,
              degree: degreeM ? degreeM[1] : undefined,
              major: majorM ? majorM[1] : undefined,
              period: after.match(/(\d{4}[.年][\d.]*~?\d{0,2}[.年]?)/)?.[1] || undefined,
            });
          }
        }
      }

      // 技能
      const skills = Array.from(document.querySelectorAll(sel.skillTag))
        .map((el) => txt(el))
        .filter((t) => t && t.length <= 20)
        .slice(0, 30);
      const skillLabels = Array.from(document.querySelectorAll(sel.skillLabel))
        .map((el) => txt(el))
        .filter((t) => t && t.length <= 30)
        .slice(0, 50);
      const skillCardText = txt(document.querySelector(sel.skillCard)).slice(0, 500);

      return { header, name, intention, work, edu, skills, skillLabels, skillCardText };
    }, {
      header: s.header,
      name: s.name,
      intention: s.intention,
      workItem: s.workItem,
      workTimeRange: s.workTimeRange,
      workContent: s.workContent,
      eduWrap: s.eduWrap,
      skillTag: s.skillTag,
      skillLabel: s.skillLabel,
      skillCard: s.skillCard,
    })
    .catch(() => null);

  if (!raw) {
    warn('详情页提取失败（DOM 读取异常）');
    return { url };
  }

  return {
    resumeId: extractResumeId(url),
    url,
    name: raw.name || undefined,
    status: raw.header || undefined,
    intention: raw.intention || undefined,
    skills: raw.skills.length > 0 ? raw.skills : undefined,
    skillLabels: raw.skillLabels.length > 0 ? raw.skillLabels : undefined,
    skillCardText: raw.skillCardText || undefined,
    work: raw.work.length > 0 ? raw.work : undefined,
    edu: raw.edu.length > 0 ? raw.edu : undefined,
  };
}

/** 生成人形可读摘要（供 --summary / 交互展示） */
export function detailToSummary(d: CandidateDetail): string {
  const lines: string[] = [];
  if (d.name) lines.push(`姓名: ${d.name}`);
  if (d.status) lines.push(`状态: ${d.status.slice(0, 100)}`);
  if (d.intention) lines.push(`意向: ${d.intention.slice(0, 100)}`);
  if (d.skills && d.skills.length > 0) lines.push(`技能: ${d.skills.join(' / ').slice(0, 80)}`);
  if (d.skillLabels && d.skillLabels.length > 0) lines.push(`明细: ${d.skillLabels.slice(0, 12).join(' / ')}`);
  if (d.work && d.work.length > 0) {
    lines.push('经历:');
    for (const w of d.work.slice(0, 3)) {
      lines.push(`  · ${[w.period, w.company, w.position].filter(Boolean).join(' | ')}${w.desc ? ` — ${w.desc.slice(0, 60)}` : ''}`);
    }
  }
  if (d.edu && d.edu.length > 0) {
    lines.push(`教育: ${d.edu.map((e) => [e.school, e.degree, e.major].filter(Boolean).join(' · ')).slice(0, 3).join('；')}`);
  }
  return lines.join('\n');
}

/**
 * 在当前搜索列表中对第 index 张卡片打开详情新 tab 并提取。
 * @param browser 已连接的 Browser（用于捕获 targetcreated）
 * @param page    当前搜索页
 * @param index   卡片序号（1-based）
 * @returns { page: 详情页, detail: CandidateDetail }，失败返回 null
 */
export async function openDetailByIndex(
  browser: Browser,
  page: Page,
  index: number,
  opts: { throttle?: Throttle } = {}
): Promise<{ page: Page; detail: CandidateDetail } | null> {
  const s = selectors.search;
  const cards = await page.$$(`${s.resultList} ${s.resultItem}`).catch(() => []);
  const card = cards[index - 1];
  if (!card) {
    warn(`卡片序号 ${index} 超出搜索列表范围（共 ${cards.length} 个）`);
    return null;
  }

  // T306：记录点击前的 Page 对象集合——按对象身份而非 URL 判新页，
  // 天然兼容「同一候选人同 URL 二次查看」场景；不依赖 targetcreated 事件（更稳）
  const beforePages = new Set<Page>(
    (await browser.pages().catch(() => [] as Page[])).filter((p) => !p.isClosed()),
  );

  // 点击卡片 .detail 区域（跳详情）
  const clicked = await card
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
  out(`已点击第 ${index} 张卡片，等待详情页…`);

  const deadline = Date.now() + 12000;
  let detailPage: Page | null = null;
  while (Date.now() < deadline) {
    const pages = await browser.pages().catch(() => [] as Page[]);
    for (const p of pages) {
      if (p.isClosed() || beforePages.has(p)) continue;
      let u = '';
      try { u = p.url(); } catch { /* ignore */ }
      if (u.includes('/resume/detail')) {
        detailPage = p;
        break;
      }
    }
    if (detailPage) break;
    await delay(400 + Math.random() * 300);
  }

  if (!detailPage) {
    // T107：未捕获到详情 tab 时不能把搜索列表页当详情页读（空等 12s 返回空详情），
    // 直接判失败，由调用方给出明确错误。
    warn('未捕获到详情 tab（12s）：站点可能未新开详情页，详情提取失败');
    return null;
  }
  await detailPage.bringToFront().catch(() => {});
  await delay(1800 + Math.random() * 800);

  if (opts.throttle) await opts.throttle.wait();
  const detail = await readCandidateDetail(detailPage, { throttle: opts.throttle });
  return { page: detailPage, detail };
}

/**
 * 在详情页点击「立即Hi聊」发起打招呼，并校验真实结果。
 * 返回 HiOutcome：success / quota_exhausted / failed / unknown（不再简单返回「点到了」）。
 */
export async function hiChatOnDetail(page: Page, opts: { throttle?: Throttle } = {}): Promise<HiOutcome> {
  await assertNoRisk(page, { action: '详情页打招呼', soft: false });
  if (opts.throttle) await opts.throttle.wait();

  const s = selectors.candidateDetail;
  const btn = await page.$(s.hiChatBtn);
  if (!btn) {
    warn('未找到「立即Hi聊」按钮（.chat_btn/.btn_item_chat）');
    return 'failed';
  }
  await btn.scrollIntoView().catch(() => {});
  await delay(300);
  await btn.click().catch(() => {});
  out('已点击详情页「立即Hi聊」，校验结果…');
  return detectHiResult(page, { btnText: s.hiChatBtn });
}