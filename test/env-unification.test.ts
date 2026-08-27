import { afterEach, describe, expect, it } from 'vitest';
import { getHeadlessFlag } from '../src/core/browser';
import { resolveBaiduCredentials } from '../src/ocr/baidu_ocr';

const envKeys = ['51JOB_BROWSER_HEADLESS', 'RECRUIT_BROWSER_HEADLESS', 'RECRUIT_BROWSER_HIDDEN', '51JOB_BAIDU_API_KEY', '51JOB_BAIDU_SECRET_KEY', 'API_KEY', 'SECRET_KEY'];
const saved: Record<string, string | undefined> = {};
beforeAllSave();

function beforeAllSave() {
  for (const k of envKeys) saved[k] = process.env[k];
}
function cleanEnv() {
  for (const k of envKeys) delete process.env[k];
}

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getHeadlessFlag（T401 变量统一）', () => {
  it('默认有头', () => {
    cleanEnv();
    expect(getHeadlessFlag()).toBe(false);
  });

  it('51JOB_BROWSER_HEADLESS=true 生效', () => {
    cleanEnv();
    process.env['51JOB_BROWSER_HEADLESS'] = 'true';
    expect(getHeadlessFlag()).toBe(true);
  });

  it('文档名 RECRUIT_BROWSER_HEADLESS=true 生效（原代码读错名不生效）', () => {
    cleanEnv();
    process.env['RECRUIT_BROWSER_HEADLESS'] = 'true';
    expect(getHeadlessFlag()).toBe(true);
  });

  it('旧名 RECRUIT_BROWSER_HIDDEN 兼容生效（1）', () => {
    cleanEnv();
    process.env['RECRUIT_BROWSER_HIDDEN'] = '1';
    expect(getHeadlessFlag()).toBe(true);
  });

  it('新名优先于旧名', () => {
    cleanEnv();
    process.env['RECRUIT_BROWSER_HIDDEN'] = 'true';
    process.env['RECRUIT_BROWSER_HEADLESS'] = 'false';
    expect(getHeadlessFlag()).toBe(false);
  });

  it('非 true/1 值视为有头', () => {
    cleanEnv();
    process.env['RECRUIT_BROWSER_HEADLESS'] = 'yes';
    expect(getHeadlessFlag()).toBe(false);
  });
});

describe('resolveBaiduCredentials（T401：51JOB 专用名优先）', () => {
  it('专用名优先于通用名', () => {
    cleanEnv();
    process.env['51JOB_BAIDU_API_KEY'] = 'k51';
    process.env['51JOB_BAIDU_SECRET_KEY'] = 's51';
    process.env.API_KEY = 'kgeneric';
    process.env.SECRET_KEY = 'sgeneric';
    expect(resolveBaiduCredentials()).toEqual({ key: 'k51', secret: 's51', usedGenericNames: false });
  });

  it('仅有通用名时兜底并标记 usedGenericNames', () => {
    cleanEnv();
    process.env.API_KEY = 'kgeneric';
    process.env.SECRET_KEY = 'sgeneric';
    expect(resolveBaiduCredentials()).toEqual({ key: 'kgeneric', secret: 'sgeneric', usedGenericNames: true });
  });

  it('专用名存在（哪怕不完整）时不与通用名拼接', () => {
    cleanEnv();
    process.env['51JOB_BAIDU_API_KEY'] = 'k51';
    process.env.API_KEY = 'kgeneric';
    process.env.SECRET_KEY = 'sgeneric';
    const r = resolveBaiduCredentials();
    expect(r.key).toBe('k51');
    expect(r.secret).toBeUndefined();
  });

  it('都未配置 → undefined', () => {
    cleanEnv();
    expect(resolveBaiduCredentials()).toEqual({ key: undefined, secret: undefined, usedGenericNames: false });
  });
});
