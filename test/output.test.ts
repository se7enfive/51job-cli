import { describe, expect, it } from 'vitest';
import { displayWidth, printTable, truncateDisplay } from '../src/utils/output';

describe('displayWidth', () => {
  it('ASCII 记 1', () => expect(displayWidth('abc')).toBe(3));
  it('CJK 记 2', () => expect(displayWidth('中文')).toBe(4));
  it('全角标点记 2', () => expect(displayWidth('，')).toBe(2));
  it('混合', () => expect(displayWidth('a中b')).toBe(4));
});

describe('truncateDisplay', () => {
  it('不超宽原样返回', () => {
    expect(truncateDisplay('abc', 10)).toBe('abc');
    expect(truncateDisplay('中文', 4)).toBe('中文');
  });

  it('超宽截断加省略号且不超上限', () => {
    const s = '投递了 测绘工程师岗位，期望薪资 1.1-1.3万/月，经验七年';
    const out = truncateDisplay(s, 20);
    expect(displayWidth(out)).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(s.length);
  });

  it('ASCII 超宽同样截断', () => {
    const out = truncateDisplay('x'.repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('printTable', () => {
  it('超宽单元格被截断，各列保持对齐宽度', () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      lines.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      printTable([
        { '#': 1, 姓名: '张三', 摘要: '投递了 很长很长很长很长很长很长很长很长很长很长的摘要内容需要被截断' },
        { '#': 2, 姓名: '李四', 摘要: '短' },
      ]);
    } finally {
      process.stdout.write = orig;
    }
    const rows = lines.join('').split('\n').filter((l) => l.length > 0);
    // 表头 + 分隔线 + 2 行数据
    expect(rows.length).toBe(4);
    expect(rows[3]).toContain('短');
    expect(rows[2]).toContain('…');
    // 数据行显示宽度一致（对齐）
    expect(displayWidth(rows[2])).toBe(displayWidth(rows[3]));
  });
});
