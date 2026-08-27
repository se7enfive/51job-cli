import type { Page } from 'puppeteer-core';
import { randomIntInclusive, sleep, sleepRandom } from './timing.js';

/**
 * 人类行为模拟：随机停顿、鼠标轨迹。
 * T304 清理：未接线的 timing 常量与函数（selectAllModifierKey /
 * typeTextWithRandomKeyDelay 等）已删除，校准值可从 git 历史（577860c）找回。
 * 保留当前在用的三个常量与两个函数。
 */

/** 页面执行上下文被销毁后重试前（sessionPage 使用） */
export const CONTEXT_DESTROY_RETRY_MS = { min: 900, max: 1800 } as const;

/** 列表稳定轮询间隔（随机，inbox 使用） */
export const LIST_POLL_MS = { min: 420, max: 780 } as const;

/** 列表为空时至少等待多久才认为稳定（inbox 使用） */
export const LIST_MIN_BEFORE_EMPTY_OK_MS = 5000;

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
