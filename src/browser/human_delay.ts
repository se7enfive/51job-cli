import type { Page } from 'puppeteer-core';
import { randomIntInclusive, sleep, sleepRandom } from './timing.js';

/** macOS 用 Meta，其余平台用 Control */
export function selectAllModifierKey(): 'Meta' | 'Control' {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

/** 导航到 ehire 页面并 load 后，等待 SPA/接口渲染 */
export const NAV_GOTO_SETTLE_MS = { min: 2800, max: 5200 } as const;

/** 页面执行上下文被销毁后重试前 */
export const CONTEXT_DESTROY_RETRY_MS = { min: 900, max: 1800 } as const;

/** 页面内导航点击后，等待路由与 SPA 状态开始变化 */
export const PAGE_NAV_AFTER_CLICK_MS = { min: 420, max: 1100 } as const;

/** 列表滚动查找候选人时，每轮之间的间隔 */
export const LIST_SCROLL_GAP_MS = { min: 240, max: 760 } as const;

/** 点击会话行后，等待右侧面板出现的短停顿 */
export const OPEN_CHAT_AFTER_ROW_CLICK_MS = { min: 420, max: 1200 } as const;

/** mouse.click 的按下/抬起间隔（Puppeteer delay 选项） */
export const MOUSE_CLICK_PRESS_MS = { min: 55, max: 180 } as const;

/** 筛选「全部」等操作之间的停顿 */
export const LIST_FILTER_GAP_MS = { min: 780, max: 1400 } as const;

/** 下拉打开、搜索输入、选择岗位等连续动作之间的停顿 */
export const SEARCH_ACTION_GAP_MS = { min: 280, max: 760 } as const;

/** 关键词输入后，等待前端过滤/接口刷新开始响应 */
export const SEARCH_INPUT_AFTER_MS = { min: 420, max: 980 } as const;

/** 点击候选人卡片打开简历预览后，等待弹层/iframe 开始挂载 */
export const RESUME_PREVIEW_OPEN_GAP_MS = { min: 420, max: 1100 } as const;

/** 列表稳定轮询间隔（随机） */
export const LIST_POLL_MS = { min: 420, max: 780 } as const;

/** 列表为空时至少等待多久才认为稳定 */
export const LIST_MIN_BEFORE_EMPTY_OK_MS = 5000;

/** 登录态探测轮询间隔 */
export const PROBE_LOGIN_POLL_MS = { min: 520, max: 980 } as const;

/** 点击聊天输入框 */
export const SEND_INPUT_CLICK_MS = { min: 45, max: 160 } as const;

/** 逐字输入：字符间隔（随机） */
export const SEND_TYPING_GAP_MS = { min: 38, max: 125 } as const;

/** 按下 Enter 后、流程结束前短停顿 */
export const SEND_AFTER_ENTER_MS = { min: 260, max: 920 } as const;

/** send 中先发完文字后、再执行 --action 前的默认随机间隔 */
export const SEND_BEFORE_RESUME_MS = { min: 2800, max: 5600 } as const;

/** 点击「沟通记录」后等待弹窗与列表渲染 */
export const CHAT_HISTORY_DIALOG_WAIT_MS = { min: 500, max: 1400 } as const;

/** 会话列表切换后等待刷新 */
export const CHAT_HISTORY_TAB_SWITCH_MS = { min: 350, max: 900 } as const;

/** 点击「在线简历」后等待 iframe 出现 */
export const ONLINE_RESUME_IFRAME_APPEAR_MS = { min: 600, max: 1600 } as const;

/** 点击后等待简历 iframe 出现、或判定为付费墙弹层的上限（毫秒） */
export const ONLINE_RESUME_IFRAME_WAIT_MAX_MS = 15_000;

/** 打招呼点击后主文档付费弹层轮询上限（毫秒） */
export const GREET_PAYWALL_WAIT_MAX_MS = 3500;

/** iframe 出现后等待简历区域渲染 */
export const ONLINE_RESUME_IFRAME_SETTLE_MS = { min: 1800, max: 4200 } as const;

/**
 * 逐字符输入，字符之间为随机间隔（末尾字符后不再额外等待）。
 * 相比 puppeteer 默认 type 的固定 delay，随机间隔更接近人类输入节奏。
 */
export async function typeTextWithRandomKeyDelay(
  page: Page,
  text: string,
  minGapMs: number,
  maxGapMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const codepoints = Array.from(text);
  for (let i = 0; i < codepoints.length; i++) {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }
    const ch = codepoints[i]!;
    await page.keyboard.type(ch, { delay: 0 });
    if (i < codepoints.length - 1) {
      await sleep(randomIntInclusive(minGapMs, maxGapMs), signal);
    }
  }
}

/**
 * 随机鼠标轨迹移动：从 (x0,y0) 到 (x1,y1)，中间加 3~6 个带随机弧度偏移的中间点，
 * 每段用随机时长（80~240ms）移动，模拟真实人类鼠标路径（非直线）。
 * 2026-08-26 为降低简历详情批量查看风控触发添加。
 */
export async function mouseMoveHuman(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const steps = randomIntInclusive(3, 6);
  // 起点
  await page.mouse.move(from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / (steps + 1);
    // 贝塞尔近似：直线 + 随机法向偏移（弧度感）
    const bx = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * 60;
    const by = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * 40;
    await page.mouse.move(bx, by);
    await sleepRandom(40, 140);
  }
  // 精确落到目标点
  await page.mouse.move(to.x, to.y);
  await sleep(40 + Math.random() * 120);
}

/**
 * 开详情前的人类停留：随机 5-15 秒（皇帝拍板 A+B）。
 * 期间做随机「浏览」动作（轻微滚动 + 鼠标滑过），降低会话级操作频率信号。
 * 注意：超过了原 SEND_BEFORE_RESUME_MS 的用途，故新加独立函数。
 */
export async function humanPauseBeforeDetail(page: Page): Promise<void> {
  const total = randomIntInclusive(5000, 15000);
  const deadline = Date.now() + total;
  // 0~3 次随机滚动（上下小幅度）
  const scrolls = randomIntInclusive(0, 3);
  for (let i = 0; i < scrolls; i++) {
    if (Date.now() >= deadline) break;
    const delta = randomIntInclusive(-260, 260);
    await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), delta).catch(() => {});
    await sleepRandom(500, 1200);
  }
  // 剩余时间自然等完
  const remain = deadline - Date.now();
  if (remain > 0) await sleep(remain);
}
