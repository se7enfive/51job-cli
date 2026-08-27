import { describe, expect, it } from 'vitest';
import { stillInitial } from '../src/pages/hi-result';

describe('stillInitial', () => {
  it('初始文案 → true（未发出）', () => {
    expect(stillInitial(['立即Hi聊'])).toBe(true);
    expect(stillInitial(['立即沟通'])).toBe(true);
    expect(stillInitial(['立即联系'])).toBe(true);
  });

  it('变化文案 → false（已发出）', () => {
    expect(stillInitial(['已Hi聊'])).toBe(false);
    expect(stillInitial(['等待回应'])).toBe(false);
    expect(stillInitial(['已聊天'])).toBe(false);
  });

  it('T106：混合数组只要任一含初始文案即 true（配合目标卡限定使用）', () => {
    expect(stillInitial(['已Hi聊', '立即Hi聊'])).toBe(true);
    expect(stillInitial(['立即Hi聊', '已Hi聊'])).toBe(true);
  });

  it('空数组 → false（无信号，交由上层按 unknown 处理）', () => {
    expect(stillInitial([])).toBe(false);
  });

  it('包含式匹配：文案含初始词前缀也算初始态', () => {
    expect(stillInitial(['立即Hi聊 +10'])).toBe(true);
  });
});
