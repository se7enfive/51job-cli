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
    out(headers.map((h, i) => padDisplay(r[h] === undefined ? '' : String(r[h]), widths[i])).join('  '));
  }
}

export function printJson(obj: unknown): void {
  out(JSON.stringify(obj, null, 2));
}

export function out(msg: string): void {
  process.stdout.write(msg + '\n');
}

export function err(msg: string): void {
  process.stderr.write(msg + '\n');
}

export function warn(msg: string): void {
  err('⚠ ' + msg);
}

export function fail(msg: string): never {
  err('✖ ' + msg);
  process.exit(1);
}
