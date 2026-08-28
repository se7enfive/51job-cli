import { describe, expect, it } from 'vitest';
import { resumeDetailUrl } from '../src/pages/candidate-detail';

describe('resumeDetailUrl（简历ID直链 URL 构造）', () => {
  it('仅 resumeId：基础直链，不带操作上下文', () => {
    expect(resumeDetailUrl('345987469')).toBe(
      'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=345987469'
    );
  });

  it('带 jobId：附带搜索池上下文（recommendJobId/jobId/fromModule）', () => {
    const u = resumeDetailUrl('404581021', '162089910');
    expect(u).toContain('resumeId=404581021');
    expect(u).toContain('recommendJobId=162089910');
    expect(u).toContain('jobId=162089910');
    expect(u).toContain('fromModule=foundTalentSerachCommon');
  });

  it('resumeId 含特殊字符时正确编码', () => {
    expect(resumeDetailUrl('123 abc')).toContain('resumeId=123%20abc');
  });
});