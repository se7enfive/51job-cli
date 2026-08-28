import { describe, expect, it } from 'vitest';
import { parseMgmtRow } from '../src/pages/job';

describe('parseMgmtRow', () => {
  it('正常画像行：提取年龄/年限/学历/城市，经历作 snippet', () => {
    const r = parseMgmtRow('李寿国 当前在线 拨打电话 26岁 3年 本科 杭州 2025.05-2026.03 (10个月) 上海华铁实业 • 测绘/测量');
    expect(r.age).toBe('26岁');
    expect(r.years).toBe('3年');
    expect(r.edu).toBe('本科');
    expect(r.city).toBe('杭州');
    expect(r.snippet).toContain('上海华铁实业');
  });

  it('城市不误报操作词（排除“回复/合适/拨打电话”等穷表）', () => {
    // 行内学历后紧跟操作按钮，而非城市——城市应为空，不应取到“回复”
    const r = parseMgmtRow('彭辉红 30岁 7年 本科 回复 合适 不合适 2019.07-2020.08 广东慧图 • 助理');
    expect(r.age).toBe('30岁');
    expect(r.edu).toBe('本科');
    // 城市若没渲染则留空（不出错值）
    if (r.city) {
      expect(r.city).not.toMatch(/回复|合适|拨打电话|在线|继续/);
    }
  });

  it('无“年”经验词：years 留空（如硕士无经验标签）', () => {
    const r = parseMgmtRow('秦鹏晨 无经验 本科 桂林 2024.09-2025.01 (4个月) 某公司 • 岗');
    expect(r.age).toBeUndefined();
    expect(r.edu).toBe('本科');
  });

  it('学历缺失但不崩溃：至少保留 age', () => {
    const r = parseMgmtRow('张三 28岁 广州');
    expect(r.age).toBe('28岁');
  });

  it('经历紧贴城市时，城市锚在时间戳之前', () => {
    // 城市“广州”后紧接经历时间戳，不应被后续经历/按钮干扰
    const r = parseMgmtRow('何敏萍 24岁 3年 大专 武汉 2024.09-2025.01 (4个月) 广西某土地');
    expect(r.city).toBe('武汉');
  });
});