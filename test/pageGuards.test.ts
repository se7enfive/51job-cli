import { afterEach, describe, expect, it } from 'vitest';
import { classifyPausedRequest, isRiskNavigationUrl, parsePatternList } from '../src/core/pageGuards';

describe('isRiskNavigationUrl', () => {
  const cases: Array<[string, boolean, string]> = [
    ['https://ehire.51job.com/login', false, '登录页不拦截'],
    ['https://ehire.51job.com/inbox/list', false, '业务页不拦截'],
    ['https://ehire.51job.com/safeguard/verify', true, '风控路径拦截'],
    ['https://ehire.51job.com/login?captcha=1', true, '验证参数拦截'],
    ['https://ehire.51job.com/risk/check', true, '风险路径拦截'],
    ['https://ehire.51job.com/security-check', true, 'security 路径拦截'],
    ['https://ehire.51job.com/xx/checkcode/y', true, 'checkcode 路径拦截'],
    ['https://ehire.51job.com/blocked', true, 'blocked 路径拦截'],
    ['about:blank', true, 'about:blank 命中正则（导航守卫侧另有排除逻辑）'],
  ];
  for (const [url, want, label] of cases) {
    it(label, () => expect(isRiskNavigationUrl(url)).toBe(want));
  }
});

describe('classifyPausedRequest', () => {
  it('上报类 URL → report', () => {
    expect(classifyPausedRequest('https://ehire.51job.com/dap/collect?v=1')).toBe('report');
    expect(classifyPausedRequest('https://ehire.51job.com/api/monitor/')).toBe('report');
  });

  it('风控导航 URL → risk_navigation', () => {
    expect(classifyPausedRequest('https://ehire.51job.com/safeguard/verify')).toBe('risk_navigation');
  });

  it('其余（含显式配置的安全脚本）→ security_script', () => {
    expect(classifyPausedRequest('https://ehire.51job.com/static/app.js')).toBe('security_script');
  });
});

describe('parsePatternList', () => {
  const KEY = '51JOB_TEST_PATTERNS';
  const orig = process.env[KEY];

  afterEach(() => {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  });

  it('未设置时返回默认值', () => {
    delete process.env[KEY];
    expect(parsePatternList(KEY, ['*a.com/*x*', '*b.com/*y*'])).toEqual(['*a.com/*x*', '*b.com/*y*']);
  });

  it('环境变量逗号分隔覆盖默认值，并过滤空白项', () => {
    process.env[KEY] = ' *a.com/*p* , , *a.com/*q* ';
    expect(parsePatternList(KEY, ['*default*'])).toEqual(['*a.com/*p*', '*a.com/*q*']);
  });

  it('空白串视为未设置（回默认）', () => {
    process.env[KEY] = '  ';
    expect(parsePatternList(KEY, ['*default*'])).toEqual(['*default*']);
  });
});
