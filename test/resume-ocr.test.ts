import { afterEach, describe, expect, it } from 'vitest';
import { isResumeOcrEnabled } from '../src/ocr/resume_ocr';

const KEY = '51JOB_RESUME_OCR';
const orig = process.env[KEY];

afterEach(() => {
  if (orig === undefined) delete process.env[KEY];
  else process.env[KEY] = orig;
});

describe('isResumeOcrEnabled（T202：默认关闭，显式 opt-in）', () => {
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['no', false],
    ['1', true],
    ['true', true],
    ['yes', true],
    ['YES', true],
    ['True', true],
  ];
  for (const [v, want] of cases) {
    it(`51JOB_RESUME_OCR=${JSON.stringify(v)} → ${want}`, () => {
      if (v === undefined) delete process.env[KEY];
      else process.env[KEY] = v;
      expect(isResumeOcrEnabled()).toBe(want);
    });
  }
});
