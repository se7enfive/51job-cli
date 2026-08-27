export type OutputFormat = 'text' | 'json';

let format: OutputFormat = 'text';

export function setFormat(f: OutputFormat): void {
  format = f;
}

export function getFormat(): OutputFormat {
  return format;
}

export interface Row {
  [key: string]: string | number | undefined;
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return w;
}

function padDisplay(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) return s;
  return s + ' '.repeat(width - w);
}

/** 超宽单元格截断加省略号（T110）：保证列宽 ≤ 上限，表格不再因长字段错位 */
function truncateDisplay(s: string, maxWidth: number): string {
  if (displayWidth(s) <= maxWidth) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > maxWidth - 1) break; // 留 1 列给省略号
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function printTable(rows: Row[]): void {
  if (rows.length === 0) {
    out('(empty)');
    return;
  }
  const headers = Object.keys(rows[0]);
  const widths = headers.map((h) => {
    let max = displayWidth(h);
    for (const r of rows) {
      const v = r[h] === undefined ? '' : String(r[h]);
      max = Math.max(max, displayWidth(v));
    }
    return Math.min(max, 60);
  });
  const line = headers.map((h, i) => padDisplay(h, widths[i])).join('  ');
  out(line);
  out('-'.repeat(displayWidth(line)));
  for (const r of rows) {
    out(headers.map((h, i) => padDisplay(truncateDisplay(r[h] === undefined ? '' : String(r[h]), widths[i]), widths[i])).join('  '));
  }
}

export function printJson(obj: unknown): void {
  // JSON 协议（T103）：stdout 只允许「最终结果文档」从这条路输出——
  // 不经 out()，避免在 --json 模式下被改道 stderr。
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function out(msg: string): void {
  // --json 模式下 stdout 恒为单个可 JSON.parse 的结果文档（printJson 输出）；
  // out() 视为过程消息，改道 stderr（[info] 前缀），过程进度不再污染 stdout。
  if (format === 'json') {
    process.stderr.write('[info] ' + msg + '\n');
    return;
  }
  process.stdout.write(msg + '\n');
}

export function err(msg: string): void {
  process.stderr.write(msg + '\n');
}

export function warn(msg: string): void {
  err('⚠ ' + msg);
}

/**
 * 命令级致命错误：fail() 抛出后由顶层（program.parseAsync().catch）统一收口置退出码。
 * 用异常代替 process.exit——保证 runCommand / withSessionLock 的 finally 清理
 * （断开浏览器连接、释放会话锁）照常执行，且 stdout 缓冲（--json 结果）完整落盘。
 */
export class FatalCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'FatalCliError';
  }
}

export function fail(msg: string, exitCode = 1): never {
  err('✖ ' + msg);
  throw new FatalCliError(msg, exitCode);
}
