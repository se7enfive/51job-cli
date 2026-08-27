import type { Page } from 'puppeteer-core';
import { out, warn } from '../utils/output';
import { delay } from '../core/throttle';
import { selectors } from './selectors';

/**
 * Hi 打招呼结果类型。
 * - success: 确认已发出（Hi 按钮文案已不再等于「立即Hi聊」等初始文案）
 * - quota_exhausted: 额度不足弹窗（Hi 未发出；弹窗需手动关闭，已自动点关闭）
 * - failed: 明确失败（按钮原样 + 出现失败类弹窗）
 * - unknown: 超时无信号，保守按未成功处理
 * - dry_run: --dry-run 查看详情后主动结束（正常流程，未发出，命令退出码 0）
 * - cancelled: 用户在 Y/N 确认时跳过（正常流程，未发出，命令退出码 0）
 */
export type HiOutcome = 'success' | 'quota_exhausted' | 'failed' | 'unknown' | 'dry_run' | 'cancelled';

/** Hi 按钮初始文案：前缀类（立即Hi聊/立即沟通/立即联系/立即聊） */
const HI_BTN_INITIAL_PREFIX_RE = /^立即(?:Hi聊|沟通|联系|聊)/;
/** Hi 按钮初始文案：完整短词类 */
const HI_BTN_INITIAL_EXACT = ['Hi聊', '沟通'];

/** 任一文本仍为初始态即视为「还未发出去」。导出供单元测试（T301）。
 * 注意：不能做朴素 includes——「已Hi聊」「已沟通」等成功后文案包含短词
 * 「Hi聊」「沟通」，朴素包含会把成功态误判为初始态（成功永远检测不到）。 */
export function stillInitial(texts: string[]): boolean {
  return texts.some((t) => {
    const s = t.trim();
    if (!s) return false;
    if (HI_BTN_INITIAL_PREFIX_RE.test(s)) return true;
    return HI_BTN_INITIAL_EXACT.includes(s);
  });
}

/** 额度不足弹窗特征文案 */
const QUOTA_TEXT_PATTERNS: RegExp[] = [
  /剩余额度不足/i,
  /额度不足/i,
  /联系管理员/i,
  /余额不足/i,
  /产品数不足/i,
  /点数不足/i,
  /Hi聊点数/i,
];

/** 其他失败类弹窗特征文案 */
const FAIL_TEXT_PATTERNS: RegExp[] = [
  /操作失败/i,
  /系统繁忙/i,
  /网络异常/i,
  /请求超时/i,
];

interface HiProbe {
  hasDialog: boolean;
  dialogText: string;
}

/** 只读探测：当前页面是否有可见弹窗及其文案 */
async function probeHi(page: Page): Promise<HiProbe> {
  const sel = selectors.hiResult;
  return page
    .evaluate((s) => {
      const dls = Array.from(document.querySelectorAll<HTMLElement>(s.dialog)).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const hasDialog = dls.length > 0;
      const dialogText = hasDialog ? (dls[0].innerText || '').slice(0, 1200) : '';
      return { hasDialog, dialogText };
    }, sel)
    .catch(() => ({ hasDialog: false, dialogText: '' }));
}

/** 主动关闭 Hi 结果弹窗（模态框需手动点关闭，否则阻塞页面后续操作）。失败静默。 */
export async function closeHiDialog(page: Page): Promise<void> {
  try {
    await page.evaluate(
      (s) => {
        const dls = Array.from(document.querySelectorAll<HTMLElement>(s.dialog)).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (dls.length === 0) return;
        const d = dls[0];
        // 1) 右上角 × 关闭按钮
        const close = d.querySelector<HTMLElement>(s.close);
        if (close) {
          close.click();
          return;
        }
        // 2) 文本按钮兜底（我知道了/确定/关闭）
        const btns = Array.from(d.querySelectorAll<HTMLElement>(s.confirmBtn));
        const textBtn = btns.find((b) => {
          const t = (b.textContent || '').trim();
          return t.length <= 8 && /知道了|确\s*定|关\s*闭/.test(t);
        });
        if (textBtn) textBtn.click();
      },
      selectors.hiResult
    ).catch(() => {});
    await delay(300);
  } catch {
    /* 关闭失败不致命：留给后续探测兜底 */
  }
}

/** 查询某个按钮选择器当前所有可见文本（用于判断是否仍为「立即Hi聊」初始态） */
async function btnTexts(page: Page, selector: string): Promise<string[]> {
  return page
    .$$eval(selector, (els) =>
      els
        .map((e) => ((e as HTMLElement).textContent || '').trim())
        .filter((t) => t.length > 0)
    )
    .catch(() => []);
}

/**
 * 只读取目标卡片内的按钮/状态文本（T106）。
 * 列表多卡时，成功判定只看被点击的那张卡——否则其他卡的「立即Hi聊」初始文案
 * 会遮蔽目标卡的成功信号（恒判 unknown），或他卡变化被误判为目标成功。
 * 返回 null 表示卡片定位失败（下标漂移/重渲染），调用方降级全页扫描。
 */
async function btnTextsInCard(page: Page, cardSelector: string, cardIndex: number): Promise<string[] | null> {
  return page
    .evaluate((sel, i) => {
      const card = document.querySelectorAll(sel)[i];
      if (!card) return null;
      // 按钮之外兜底 [class*="btn"]：部分卡片 Hi 后按钮可能被状态标签替换
      const els = Array.from(card.querySelectorAll('button, [role="button"], [class*="btn"]'));
      return els.map((e) => ((e as HTMLElement).textContent || '').trim()).filter((t) => t.length > 0);
    }, cardSelector, cardIndex)
    .catch(() => null);
}

/**
 * 点击「立即Hi聊」后判定真实结果。
 * 判定优先级：额度弹窗 > 失败弹窗 > 按钮文案变化(=成功) > 超时 unknown。
 *
 * @param page   当前页（列表页或详情页）
 * @param opt.btnText Hi 按钮选择器（用于「文案变化=成功」判定；缺省则只靠弹窗判定）
 * @param opt.cardSelector 目标卡容器选择器（列表页多卡场景，T106）
 * @param opt.targetIndex 目标卡下标（0-based，与 cardSelector 配套）；
 *   提供后成功判定只看这张卡——卡片定位失败自动降级 btnText 全页扫描并 warn。
 */
export async function detectHiResult(
  page: Page,
  opt: { btnText?: string; cardSelector?: string; targetIndex?: number } = {}
): Promise<HiOutcome> {
  // 目标限定文本收集（T106）：cardSelector+targetIndex 优先，失败降级 btnText 全页扫描
  const collectTargetTexts = async (): Promise<string[] | null> => {
    if (opt.cardSelector && opt.targetIndex !== undefined) {
      const inCard = await btnTextsInCard(page, opt.cardSelector, opt.targetIndex);
      if (inCard !== null) return inCard;
      warn('目标卡片定位失败（可能重渲染），降级为全页按钮扫描判定');
    }
    if (opt.btnText) return btnTexts(page, opt.btnText);
    return null;
  };
  const hasBtnCheck = !!(opt.btnText || (opt.cardSelector && opt.targetIndex !== undefined));

  // 等待弹窗/按钮变化出现（0.6~1.4s）
  await delay(600 + Math.random() * 800);

  // 1) 额度不足弹窗（最高优先级：命中即停手并关弹窗）
  const p0 = await probeHi(page);
  if (p0.hasDialog && QUOTA_TEXT_PATTERNS.some((re) => re.test(p0.dialogText))) {
    warn('检测到「剩余额度不足」弹窗：本次 Hi 未发出，已停止');
    await closeHiDialog(page);
    return 'quota_exhausted';
  }

  // 2) 失败类弹窗
  if (p0.hasDialog && FAIL_TEXT_PATTERNS.some((re) => re.test(p0.dialogText))) {
    warn('检测到失败提示弹窗，Hi 未发出');
    await closeHiDialog(page);
    return 'failed';
  }

  // 3) 按钮文案变化 = 成功（只看目标卡，T106）
  if (hasBtnCheck) {
    const texts = await collectTargetTexts();
    if (texts && texts.length > 0 && !stillInitial(texts)) {
      out('Hi 已发出：按钮文案已离开「立即Hi聊」初始态');
      return 'success';
    }
  }

  // 4) 慢渲染兜底：再等 1.2s 复查
  await delay(1200);
  const p1 = await probeHi(page);
  if (p1.hasDialog && QUOTA_TEXT_PATTERNS.some((re) => re.test(p1.dialogText))) {
    warn('检测到「剩余额度不足」弹窗：本次 Hi 未投放，已停止');
    await closeHiDialog(page);
    return 'quota_exhausted';
  }
  if (p1.hasDialog && FAIL_TEXT_PATTERNS.some((re) => re.test(p1.dialogText))) {
    warn('检测到失败提示弹窗，Hi 未发出');
    await closeHiDialog(page);
    return 'failed';
  }
  if (hasBtnCheck) {
    const texts = await collectTargetTexts();
    if (texts && texts.length > 0 && !stillInitial(texts)) {
      out('Hi 已发出（复查确认按钮文案已变化）');
      return 'success';
    }
  }

  // 5) 无成功信号：有未识别弹窗判 failed，否则 unknown
  const p2 = await probeHi(page);
  if (p2.hasDialog) {
    warn('存在未识别弹窗，Hi 结果未知（可能未发出）');
    return 'failed';
  }
  warn('等待后仍无成功信号（按钮未变、无弹窗），按「未确认成功」处理');
  return 'unknown';
}

/** Hi 结果标签（供 JSON 输出透出 hiResult 字段） */
export function hiOutcomeTag(o: HiOutcome): string {
  return o;
}