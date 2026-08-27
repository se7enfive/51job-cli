import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'puppeteer-core';
import { assertNoRisk } from '../core/guard';
import { delay, Throttle } from '../core/throttle';
import { out, warn, Row } from '../utils/output';
import { jdDir } from '../utils/store';
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
 * 读取职位列表。
 * 不在职位管理页时自动导航（URL 直达），选择器按 2026-08-26 实测 DOM 校准：
 * 职位卡 .job_card / 名称 .job_name / 类型 .job-type-tag / 状态 .job_tag（多个拼接）/
 * 详情行 .job_bottom_info（地点|学历|经验|薪资）/ 待处理数 .job_card_num。
 */
export async function readPositions(page: Page, opts: { throttle?: Throttle } = {}): Promise<JobPost[]> {
  await assertNoRisk(page, { action: '读取职位列表', soft: true });
  if (opts.throttle) await opts.throttle.wait();

  if (!page.url().includes('/Revision/job-manage')) {
    out('正在进入职位管理页…');
    await page.goto(JOB_MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await delay(2500 + Math.random() * 1000);
  }

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
