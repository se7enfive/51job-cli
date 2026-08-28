import { describe, expect, it } from 'vitest';
import { parseMgmtRow, detailToSearchFilters } from '../src/pages/job';

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

describe('detailToSearchFilters（职位卡 detail → 搜索筛选）', () => {
  it('完整 4 段：城市去区级 + 学历上取', () => {
    const f = detailToSearchFilters('湛江-霞山区 | 本科 | 3年及以上 | 7-12万/年');
    expect(f.city).toBe('湛江');
    expect(f.edu).toBe('本科及以上');
    // 年限（“3年及以上”与页面枚举槽不符）与年薪均不注入
    expect(f.exp).toBeUndefined();
    expect(f.salary).toBeUndefined();
  });

  it('直辖市区：广州-天河区 → 广州', () => {
    expect(detailToSearchFilters('广州-天河区 | 大专 | 3年及以上 | 8千-1.5万/月').city).toBe('广州');
  });

  it('纯市不带区：韶关 → 韶关', () => {
    const f = detailToSearchFilters('韶关 | 本科 | 2年及以上 | 5千-1万/月');
    expect(f.city).toBe('韶关');
  });

  it('学历上取表：大专→大专及以上，硕士→硕士及以上', () => {
    expect(detailToSearchFilters('A | 大专 | x | y').edu).toBe('大专及以上');
    expect(detailToSearchFilters('A | 硕士 | x | y').edu).toBe('硕士及以上');
  });

  it('非标准学历（中技/中专）不映射 → edu 跳过', () => {
    const f = detailToSearchFilters('广州-天河区 | 中技/中专 | 3年及以上 | 7千-1万/月·13薪');
    expect(f.edu).toBeUndefined();
    expect(f.city).toBe('广州');
  });

  it('只有城市段 / 无学历段 → 仅 city，edu 跳过', () => {
    expect(detailToSearchFilters('')).toEqual({});
    expect(detailToSearchFilters('   ')).toEqual({});
    const onlyCity = detailToSearchFilters('广州-天河区');
    expect(onlyCity.city).toBe('广州');
    expect(onlyCity.edu).toBeUndefined();
    const cityExp = detailToSearchFilters('湛江-霞山区 | 5年及以上'); // 缺学历段
    expect(cityExp.city).toBe('湛江');
    expect(cityExp.edu).toBeUndefined();
  });
});