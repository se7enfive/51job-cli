import type { Page } from 'puppeteer-core';
import { join } from 'node:path';
import { EHIRE_HOME } from '../core/browser';
import { assertNoRisk } from '../core/guard';
import { delay, Throttle } from '../core/throttle';
import { out, warn } from '../utils/output';
import { selectors } from './selectors';
import { collectInboxCandidates } from './inbox';
import { ocrDir } from '../utils/store';
import { isResumeOcrEnabled, ocrResumePngToTextFile } from '../ocr/resume_ocr';

/** 人才管理页（候选人列表，行内「回复」按钮是聊天入口） */
const TALENT_MANAGEMENT_URL = 'https://ehire.51job.com/Revision/talent/management';

/** 轮询取第一个「可见」（rect 非零）的匹配元素下标，找不到返回 -1。 */
async function firstVisibleIndex(page: Page, sel: string, timeoutMs = 10_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const idx = await page
      .evaluate((s) => {
        const els = Array.from(document.querySelectorAll(s));
        for (let i = 0; i < els.length; i++) {
          const r = els[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return i;
        }
        return -1;
      }, sel)
      .catch(() => -1);
    if (idx >= 0) return idx;
    await delay(500);
  }
  return -1;
}

interface TalentRow {
  name: string;
}

/** 收集人才管理页候选人行（以「回复」按钮为锚，向上找含 .name 的行容器）。 */
async function collectTalentRows(page: Page): Promise<TalentRow[]> {
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

/**
 * 打开与候选人的沟通面板。
 *
 * 实测校准（2026-08-25）：51job ehire 的聊天入口不在工作台投递卡（点击只弹简历详情），
 * 而在「人才管理」页每个候选人行的「回复」按钮：点击后右侧展开 chatting-area 面板，
 * 面板内 .input-textarea_self 输入框（placeholder「发送给 <姓名>」）+ .new-send-button 发送。
 *
 * 注意 DOM 中常驻一个 0x0 的隐藏 im-chat-panel 模板实例——所有元素匹配必须校验可见性（rect>0）。
 * 支持 --index 指定 list 输出序号（序号口径与 list 完全一致：collectInboxCandidates
 * 过滤非投递卡后统一编号；--unread 再按未读过滤，即 list --unread 的序号），
 * --strict 要求姓名精确相等。
 */
export async function openChat(
  page: Page,
  opts: { name?: string; index?: number; unreadOnly?: boolean; strict?: boolean; throttle?: Throttle } = {}
): Promise<boolean> {
  await assertNoRisk(page, { action: '打开会话', soft: false });
  if (opts.throttle) await opts.throttle.wait();

  // 1. 解析目标姓名（index 模式：用与 list 一致的序号空间解析，T105）
  let targetName = opts.name ?? '';
  if (!targetName && opts.index !== undefined) {
    const url = page.url();
    if (!url.includes('/Revision/navigate')) {
      await page.goto(EHIRE_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await delay(1500 + Math.random() * 1000);
    }
    const candidates = await collectInboxCandidates(page);
    const pool = opts.unreadOnly ? candidates.filter((c) => c.unread) : candidates;
    if (pool.length === 0) {
      warn(
        opts.unreadOnly
          ? '未读列表为空（或未定位到投递列表），无法解析序号。'
          : '未定位到工作台投递列表，无法解析序号对应的姓名。'
      );
      return false;
    }
    const cand = pool[opts.index - 1];
    if (!cand) {
      warn(
        `序号 ${opts.index} 超出列表范围（共 ${pool.length} 条${opts.unreadOnly ? '未读' : ''}）。` +
          '序号口径与 list 输出一致，请重新运行 list 确认。'
      );
      return false;
    }
    targetName = cand.name;
    if (!targetName) {
      warn(`无法读取序号 ${opts.index} 对应的候选人姓名。`);
      return false;
    }
  }
  if (!targetName) {
    warn('需要提供姓名或 --index 序号');
    return false;
  }

  // 2. 进入人才管理页
  const url = page.url();
  if (!url.includes('/talent/management')) {
    await page.goto(TALENT_MANAGEMENT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await delay(1500 + Math.random() * 1000);
  }

  // 3. 定位目标行（列表为内层容器懒加载——window 滚动无效，需滚动 main_container）
  let rows = await collectTalentRows(page);
  let targetIdx = matchRowIndex(rows, targetName, opts.strict);
  if (targetIdx < 0) {
    for (let round = 0; round < 10 && targetIdx < 0; round++) {
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
      targetIdx = matchRowIndex(rows, targetName, opts.strict);
    }
  }
  if (targetIdx < 0) {
    warn(`未在人才管理列表中找到「${targetName}」（共 ${rows.length} 行）。可能需要翻页或调整筛选。`);
    return false;
  }

  // 4. 点击该行的「回复」按钮
  const buttons = await page.$$(selectors.talentMgmt.replyBtn).catch(() => []);
  const replyBtn = buttons[targetIdx];
  if (!replyBtn) {
    warn('回复按钮定位失败，页面可能已刷新。');
    return false;
  }
  // 目标行可能还在视口外（懒加载滚动后停在底部），先滚进视口再点，避免点击落空
  await replyBtn.scrollIntoView().catch(() => {});
  await delay(300 + Math.random() * 300);
  await replyBtn.click();
  out(`已点击「${targetName}」的回复按钮，等待沟通面板展开…`);

  // 5. 轮询等待可见输入框（隐藏模板实例 rect 为 0，必须校验可见性）
  const inputIdx = await firstVisibleIndex(page, selectors.chat.messageInput, 12_000);
  if (inputIdx < 0) {
    warn('沟通面板未在 12s 内展开（未见可见输入框）。');
    return false;
  }

  // 6. 校验面板目标（部分场景 placeholder 为「发送给 <姓名>」，部分为通用文案）
  const ph = await page
    .evaluate((sel, i) => {
      const els = document.querySelectorAll(sel);
      const el = els[i];
      return el ? el.getAttribute('placeholder') || '' : '';
    }, selectors.chat.messageInput, inputIdx)
    .catch(() => '');
  if (ph.includes('发送给') && !ph.includes(targetName)) {
    warn(`面板目标校验不一致：placeholder「${ph}」不含「${targetName}」，请人工确认。`);
  } else {
    out(`沟通面板已打开（${ph || '输入框就绪'}）`);
  }
  return true;
}

function matchRowIndex(rows: TalentRow[], name: string, strict?: boolean): number {
  for (let i = 0; i < rows.length; i++) {
    const n = rows[i].name;
    if (!n) continue;
    if (strict ? n === name : n.includes(name)) return i;
  }
  return -1;
}

/**
 * 向当前会话发送文本消息。
 * 只操作「可见」元素：DOM 中常驻隐藏的 im-chat-panel 模板（rect 0x0），
 * 直接 page.$() 会命中隐藏实例导致 click 报 not clickable。
 */
export async function sendMessage(
  page: Page,
  text: string,
  opts: { throttle?: Throttle } = {}
): Promise<boolean> {
  await assertNoRisk(page, { action: '发送消息', soft: false });
  if (opts.throttle) await opts.throttle.wait();

  const s = selectors.chat;
  const inputIdx = await firstVisibleIndex(page, s.messageInput, 5_000);
  if (inputIdx < 0) {
    warn('未定位到可见的消息输入框。请先运行 chat 打开沟通面板，或运行 51job probe 校准选择器。');
    return false;
  }
  const inputs = await page.$$(s.messageInput);
  const input = inputs[inputIdx];
  if (!input) {
    warn('输入框定位失败。');
    return false;
  }

  const isEditable = await input.evaluate((el) => (el as HTMLElement).isContentEditable);
  if (isEditable) {
    await input.click();
    await input.type(text, { delay: 20 + Math.random() * 40 });
  } else {
    await input.click({ clickCount: 3 });
    await input.type(text, { delay: 20 + Math.random() * 40 });
  }

  // 实测：IM SDK 输入状态同步有延迟，typing 后立刻点发送会被忽略。
  // 停顿后重新聚焦输入框，再执行发送。
  await delay(700 + Math.random() * 500);
  await input.click().catch(() => {});

  if (opts.throttle) await opts.throttle.wait();

  // 发送按钮同样只取可见实例；实测 IM SDK 的发送按钮必须用真实鼠标坐标点击
  // （ElementHandle.click() 不触发其 mousedown 处理链），Enter 作为兜底。
  // 发送选择器必须是按钮本身（不能带容器兜底，见 selectors.chat.sendBtn 注释）。
  const clickVisibleSend = async (): Promise<boolean> => {
    const p = await page
      .evaluate((sel) => {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      }, s.sendBtn)
      .catch(() => null);
    if (p) {
      await page.mouse.click(p.x, p.y);
      return true;
    }
    return false;
  };

  const inputCleared = async (): Promise<boolean> => {
    const rem = await input.evaluate((el) => (el.textContent || '').trim()).catch(() => text);
    return !rem.includes(text.slice(0, 10));
  };

  // T108 防重发护栏：补发前先读聊天区已有消息，确认首击确实未出现在会话记录中才补发。
  // 首击可能已实际发出（IM SDK 输入状态同步偶发慢导致输入框清空校验误报），
  // 盲目补发 = 同一消息发两遍。用消息前 10 字符在 messages 节点中查找。
  const messageAlreadyVisible = async (): Promise<boolean> => {
    const probe = text.slice(0, 10);
    const panelText = await page
      .evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((n) => n.textContent || '').join('\n'), s.messages)
      .catch(() => '');
    return !!panelText && panelText.includes(probe);
  };

  const clicked = await clickVisibleSend();
  if (!clicked) {
    await input.press('Enter');
  }
  await delay(1500);
  if (!(await inputCleared())) {
    if (await messageAlreadyVisible()) {
      // 首击已生效（输入框清空校验误报）：按已发送处理，不补发
      warn('输入框未清空但会话记录已含该消息，按已发送处理（不补发）。');
      out(`消息已发送: ${text.length > 50 ? text.slice(0, 50) + '…' : text}`);
      return true;
    }
    // 首击未生效（IM SDK 输入状态同步偶发慢）：重新聚焦后再补一次真实点击，Enter 兜底。
    // T108：补发最多 1 次。
    await input.click().catch(() => {});
    await delay(600);
    if (!(await clickVisibleSend())) {
      await input.press('Enter');
    }
    await delay(1500);
    if (!(await inputCleared())) {
      if (await messageAlreadyVisible()) {
        warn('输入框未清空但会话记录已含该消息，按已发送处理。');
        out(`消息已发送: ${text.length > 50 ? text.slice(0, 50) + '…' : text}`);
        return true;
      }
      // T108：无法确认是否发出时不再继续补发（宁失败不重复），交人工检查
      warn('补发后输入框仍未清空且会话记录未见消息，不再继续补发，请人工检查沟通面板。');
      return false;
    }
  }

  await delay(800 + Math.random() * 900);

  // 发送后校验：输入框应被清空（仍含所发文本开头 = 发送失败）
  const remaining = await input
    .evaluate((el) => (el.textContent || '').trim())
    .catch(() => text);
  if (remaining.includes(text.slice(0, 10))) {
    warn('发送后输入框内容未清空，消息可能未发出。请人工检查沟通面板。');
    return false;
  }

  out(`消息已发送: ${text.length > 50 ? text.slice(0, 50) + '…' : text}`);
  return true;
}

/**
 * 在当前会话执行快捷操作（索要简历 / 标记不合适 / 交换微信 等）。
 * @param action 操作名（resume/unsuitable/note/wechat/phone/interview/interviewed/accept/reject）
 * @param opts.confirm 对外不可逆动作（unsuitable/reject/accept）默认需用户二次确认（Y/n）
 */
export async function chatAction(
  page: Page,
  action: string,
  opts: { throttle?: Throttle; confirm?: boolean } = {}
): Promise<boolean> {
  await assertNoRisk(page, { action: `执行会话操作 ${action}`, soft: false });
  if (opts.throttle) await opts.throttle.wait();

  // 关键词按 2026-08-25 实测面板按钮校准（打电话/换微信/邀请面试/标记已面试/不合适）
  const actionMap: Record<string, string[]> = {
    resume: ['在线简历', '查看简历', '索要简历', '获取简历', '简历'],
    unsuitable: ['不合适'],
    note: ['备注', '添加备注'],
    wechat: ['换微信', '交换微信'],
    phone: ['打电话', '拨打电话'],
    interview: ['邀请面试', '邀约', '约面试'],
    interviewed: ['标记已面试'],
    accept: ['接受', '通过'],
    reject: ['拒绝', '不合适'],
  };

  const keywords = actionMap[action] || [action];
  const buttons = await page.$$('button, [class*="btn"], [class*="action"], [role="button"]').catch(() => []);

  for (const btn of buttons) {
    const text = await btn.evaluate((el) => (el.textContent || '').trim()).catch(() => '');
    if (keywords.some((k) => text.includes(k))) {
      // 对外不可逆动作（不合适/拒绝/接受）默认先确认
      const irreversible = ['unsuitable', 'reject', 'accept'].includes(action);
      if (irreversible && opts.confirm !== false) {
        const { confirmAction } = await import('../utils/confirm');
        const yes = await confirmAction(`「${text}」是不可逆操作，确认继续？[Y/n]`);
        if (!yes) { out('已取消'); return false; }
      }
      await btn.click();
      await delay(500 + Math.random() * 700);
      out(`已执行操作「${text}」`);
      return true;
    }
  }

  warn(`未找到匹配「${action}」的操作按钮`);
  return false;
}

/**
 * 预览候选人在线简历（每日次数有限）。
 * 实测链路：打开会话 → 点面板头部「在线简历」图标（.file-style.online）
 * → 弹出 .resume 简历弹窗（求职意向/工作经历/教育经历）→ 整框截图
 * → 百度 OCR 识别为文本（~/.51job-cli/ocr/<姓名>-<日期>.txt）→ 关闭弹窗。
 * OCR 关闭：51JOB_RESUME_OCR=0；需百度 API_KEY/SECRET_KEY。
 */
export async function previewResume(page: Page, name: string, opts: { throttle?: Throttle } = {}): Promise<boolean> {
  await assertNoRisk(page, { action: `预览 ${name} 的简历`, soft: false });
  if (opts.throttle) await opts.throttle.wait();

  const s = selectors.resume;

  // 弹窗已开着则直接复用
  let dlg = await firstVisibleElement(page, s.dialog);
  if (!dlg) {
    const opened = await openChat(page, { name, throttle: opts.throttle });
    if (!opened) return false;
    await delay(600 + Math.random() * 600);

    // 点面板头部「在线简历」图标（真实鼠标坐标点击，与发送按钮同理）
    const entry = await firstVisibleElement(page, s.entry);
    if (!entry) {
      warn('未找到「在线简历」入口按钮（面板可能未展开，可运行 51job probe 校准）');
      return false;
    }
    const box = await entry.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    out('已点击「在线简历」，等待简历弹窗…');

    // 等弹窗出现（最多 10s）
    dlg = await waitForVisibleElement(page, s.dialog, 10_000);
    if (!dlg) {
      warn('简历弹窗未出现（可能已达每日预览上限，或选择器需校准）');
      return false;
    }
  } else {
    out('简历弹窗已打开');
  }

  await captureAndOcrResume(page, dlg, name);

  // 关闭弹窗（不影响返回值）
  try {
    const close = await firstVisibleElement(page, s.close);
    if (close) {
      const cbox = await close.boundingBox();
      if (cbox) await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
      await delay(400 + Math.random() * 300);
    }
  } catch {
    /* ignore */
  }
  return true;
}

/** 取第一个可见（rect 非零）的元素句柄（防隐藏模板误命中）。 */
async function firstVisibleElement(page: Page, sel: string) {
  const handles = await page.$$(sel).catch(() => []);
  for (const h of handles) {
    const box = await h.boundingBox().catch(() => null);
    if (box && box.width > 8 && box.height > 8) return h;
  }
  return null;
}

/** 轮询等待可见元素出现。 */
async function waitForVisibleElement(page: Page, sel: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = await firstVisibleElement(page, sel);
    if (h) return h;
    await delay(400 + Math.random() * 200);
  }
  return null;
}

/** 截图文件名安全段 */
function safeResumeFileBase(name: string): string {
  const t = name.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 64);
  return t.length > 0 ? t : 'candidate';
}

/** 对可见简历弹窗整框截图（captureBeyondViewport 抓全量内容），再走百度 OCR。 */
async function captureAndOcrResume(
  page: Page,
  dlg: import('puppeteer-core').ElementHandle<Element>,
  name: string,
): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  const pngPath = join(ocrDir(), `${safeResumeFileBase(name)}-${stamp}.png`);
  try {
    await dlg.screenshot({ path: pngPath, type: 'png', captureBeyondViewport: true });
    out(`简历截图已保存: ${pngPath}`);
  } catch (e) {
    warn(`简历截图失败: ${e instanceof Error ? e.message : String(e)}`);
    return;
  } finally {
    await dlg.dispose().catch(() => {});
  }

  if (!isResumeOcrEnabled()) {
    out('简历 OCR 未开启（51JOB_RESUME_OCR=0；默认开启，需百度 API_KEY/SECRET_KEY）');
    return;
  }
  try {
    const { textPath } = await ocrResumePngToTextFile(pngPath);
    out(`简历文本已识别: ${textPath}`);
  } catch (e) {
    warn(`简历 OCR 失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}
