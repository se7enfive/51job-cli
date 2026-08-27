import { describe, expect, it } from 'vitest';
import { sanitizedCommand } from '../src/core/sessionLock';

describe('sanitizedCommand（T204：锁文件脱敏）', () => {
  it('只保留脚本名 + 子命令', () => {
    expect(sanitizedCommand(['node', 'C:/x/dist/index.js', 'send', '--text', '秘密消息内容'])).toBe('index.js send');
  });

  it('无子命令时只保留脚本名', () => {
    expect(sanitizedCommand(['node', 'dist/index.js'])).toBe('index.js');
  });

  it('首参为 flag 时不含参数', () => {
    expect(sanitizedCommand(['node', 'dist/index.js', '--help'])).toBe('index.js');
  });

  it('姓名/岗位等参数值绝不出现', () => {
    const out = sanitizedCommand(['node', 'dist/index.js', 'greet', '张三', '--job', '测绘工程师']);
    expect(out).toBe('index.js greet');
    expect(out).not.toContain('张三');
    expect(out).not.toContain('测绘');
  });

  it('argv[1] 缺失时回退 51job', () => {
    expect(sanitizedCommand(['node'])).toBe('51job');
  });
});
