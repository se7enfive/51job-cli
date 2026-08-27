import { basename, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ocrDir } from '../utils/store';
import { baiduOcrImageBase64, isBaiduOcrConfigured } from './baidu_ocr';

/**
 * 是否对在线简历截图做 OCR（从 boss-cli 移植）。
 * T202：默认关闭（opt-in）——截图含候选人手机号/住址/完整经历等 PII，
 * 开启即表示同意把整框截图上传百度智能云识别。显式开启：`51JOB_RESUME_OCR=1`。
 * 开启时需配置百度 51JOB_BAIDU_API_KEY/SECRET_KEY（或通用 API_KEY/SECRET_KEY）。
 */
export function isResumeOcrEnabled(): boolean {
  const v = process.env['51JOB_RESUME_OCR']?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** 串行执行 OCR，避免并发请求交错 */
let ocrChain: Promise<unknown> = Promise.resolve();

/**
 * 对简历截图 PNG 调用百度 OCR，将结果写入 `~/.51job-cli/ocr/`（与截图同名 `.txt`）。
 */
export async function ocrResumePngToTextFile(pngAbsPath: string): Promise<{ textPath: string; text: string }> {
  if (!isBaiduOcrConfigured()) {
    throw new Error(
      '已开启简历 OCR（51JOB_RESUME_OCR），但未配置百度密钥：请设置 API_KEY 与 SECRET_KEY（或 51JOB_BAIDU_API_KEY / 51JOB_BAIDU_SECRET_KEY）。',
    );
  }
  await mkdir(ocrDir(), { recursive: true });

  const base = basename(pngAbsPath).replace(/\.png$/i, '.txt');
  const textPath = join(ocrDir(), base);

  const run = async (): Promise<{ textPath: string; text: string }> => {
    const buf = await readFile(pngAbsPath);
    const text = await baiduOcrImageBase64(buf.toString('base64'));
    // T203：OCR 文本含候选人 PII，权限收紧（POSIX 生效，Windows 仅 read-only 位）
    await writeFile(textPath, text.endsWith('\n') ? text : `${text}\n`, { encoding: 'utf8', mode: 0o600 });
    return { textPath, text };
  };

  const p = ocrChain.then(run);
  ocrChain = p.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[51job-cli] resume OCR chain reset after failure:', msg);
  });
  return p;
}
