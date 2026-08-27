import * as readline from 'readline';

/**
 * 人机确认：向终端提问，等待用户输入 Y/N。
 * - 默认 Yes（直接回车 = 确认）
 * - 输入 n/N/否/no 返回 false
 * - 其他（y/Y/是/yes/任意回车）返回 true
 */
export function confirmAction(question: string, defaultYes = true): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`${question} ${suffix} `, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      if (!a) {
        resolve(defaultYes);
        return;
      }
      if (['n', 'no', '否', '不'].includes(a)) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}