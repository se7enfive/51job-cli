import * as readline from 'readline';
import { warn } from './output';

/** 确认超时毫秒（超时按拒绝处理；<=0 关闭超时）。默认 5 分钟。 */
function confirmTimeoutMs(): number {
  const raw = parseInt(process.env['51JOB_CONFIRM_TIMEOUT_MS'] ?? '', 10);
  if (Number.isFinite(raw)) return raw <= 0 ? 0 : raw;
  return 300_000;
}

/**
 * 人机确认：向终端提问，等待用户输入 Y/N。
 * - 默认 Yes（直接回车 = 确认）
 * - 输入 n/N/否/no 返回 false
 * - 其他（y/Y/是/yes/任意回车）返回 true
 *
 * 非交互安全（T109）：stdin 非 TTY、已关闭（EOF）或超时未作答时一律返回 false
 * （安全侧默认拒绝，绝不挂起）——调用方均为不可逆操作门禁（action/greet），
 * 编排层确需自动化请显式传 --no-confirm 跳过本函数。
 */
export function confirmAction(question: string, defaultYes = true): Promise<boolean> {
  // 非 TTY（管道/编排子进程/无终端）：不存在人工作答，立即拒绝，不创建 readline 等待
  if (!process.stdin.isTTY) {
    warn('当前为非交互环境（无终端输入），确认默认拒绝。自动化场景请显式传 --no-confirm。');
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const settle = (v: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      resolve(v);
    };
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`${question} ${suffix} `, (ans) => {
      const a = ans.trim().toLowerCase();
      if (!a) {
        settle(defaultYes);
        return;
      }
      if (['n', 'no', '否', '不'].includes(a)) {
        settle(false);
        return;
      }
      settle(true);
    });
    // stdin 关闭（EOF）未作答 → 拒绝
    rl.on('close', () => settle(false));
    // 超时未作答 → 拒绝
    const ms = confirmTimeoutMs();
    const timer =
      ms > 0
        ? setTimeout(() => {
            warn(`确认超时（${Math.round(ms / 1000)}s）未作答，默认拒绝。自动化场景请显式传 --no-confirm。`);
            settle(false);
          }, ms)
        : null;
    if (timer) timer.unref();
  });
}
