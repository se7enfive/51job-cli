import * as fs from 'fs';
import * as path from 'path';
import { ocrDir, probeDir, jdDir } from './store';

export interface ExpiredFile {
  /** 目录标签（用于输出） */
  dirLabel: 'ocr' | 'probe' | 'jd';
  file: string;
  ageDays: number;
}

/**
 * 按保留期列出可清理的生成物（T203）。
 * 只扫 ocr/（简历截图+识别文本）、probe/（页面快照）与可选的 jd/（职位 JD 缓存）；
 * 绝不触碰 .cache/（登录态、state.json、session.lock）。
 * 保留期 retentionDays=0 表示全部清理。年龄按 mtime 计算，仅平铺文件（当前布局无子目录）。
 */
export function collectExpiredFiles(retentionDays: number, includeJd = false): ExpiredFile[] {
  const retentionMs = Math.max(0, retentionDays) * 86_400_000;
  const now = Date.now();
  const targets: Array<{ label: 'ocr' | 'probe' | 'jd'; dir: string }> = [
    { label: 'ocr', dir: ocrDir() },
    { label: 'probe', dir: probeDir() },
  ];
  if (includeJd) targets.push({ label: 'jd', dir: jdDir() });

  const result: ExpiredFile[] = [];
  for (const t of targets) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(t.dir);
    } catch {
      continue; // 目录不存在 = 无可清理
    }
    for (const name of entries) {
      const full = path.join(t.dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const ageMs = now - st.mtimeMs;
        if (ageMs >= retentionMs) {
          result.push({ dirLabel: t.label, file: full, ageDays: Math.floor(ageMs / 86_400_000) });
        }
      } catch {
        /* 单个文件 stat 失败跳过，不中断清理 */
      }
    }
  }
  return result;
}
