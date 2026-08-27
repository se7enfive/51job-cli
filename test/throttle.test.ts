import { afterEach, describe, expect, it } from 'vitest';
import { createThrottle, parseThrottleEnv } from '../src/core/throttle';

const KEY = '51JOB_DELAY';
const orig = process.env[KEY];

afterEach(() => {
  if (orig === undefined) delete process.env[KEY];
  else process.env[KEY] = orig;
});

describe('parseThrottleEnv', () => {
  it('未设置时默认 800-2500', () => {
    delete process.env[KEY];
    expect(parseThrottleEnv()).toEqual({ min: 800, max: 2500 });
  });

  it('单值 = 固定间隔', () => {
    process.env[KEY] = '1000';
    expect(parseThrottleEnv()).toEqual({ min: 1000, max: 1000 });
  });

  it('逗号区间 800,2000', () => {
    process.env[KEY] = '800,2000';
    expect(parseThrottleEnv()).toEqual({ min: 800, max: 2000 });
  });

  it('区间自动取较大值为 max', () => {
    process.env[KEY] = '2000,800';
    expect(parseThrottleEnv()).toEqual({ min: 2000, max: 2000 });
  });

  it('非法值回退默认', () => {
    process.env[KEY] = 'abc';
    expect(parseThrottleEnv()).toEqual({ min: 800, max: 2500 });
  });

  it('空串回退默认', () => {
    process.env[KEY] = '';
    expect(parseThrottleEnv()).toEqual({ min: 800, max: 2500 });
  });

  // 现状断言：解析器只支持逗号分隔，「800-2000」会被 parseInt 截成固定 800。
  // 该写法曾在 .env.example 中作为示例导致随机节流静默失效（审查 §6.5）。
  // 若未来解析器支持连字符区间，请同步更新本用例。
  it('连字符写法 800-2000 当前解析为固定 800（现状断言）', () => {
    process.env[KEY] = '800-2000';
    expect(parseThrottleEnv()).toEqual({ min: 800, max: 800 });
  });
});

describe('createThrottle', () => {
  it('wait 耗时落在 [min, max] 附近且计数递增', async () => {
    const t = createThrottle({ min: 50, max: 90 });
    const t0 = Date.now();
    await t.wait();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(400);
    expect(t.hits).toBe(1);
    await t.wait();
    expect(t.hits).toBe(2);
  });
});
