import { basename, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ocrDir } from '../utils/store';
import { baiduOcrImageBase64, isBaiduOcrConfigured } from './baidu_ocr';

/**
 * 是否对在线简历截图做 OCR（从 boss-cli 移植）。关闭：`51JOB_RESUME_OCR=0`。
 * 开启时需配置百度 `API_KEY` + `SECRET_KEY`（在线识别，无本地引擎）。
 */
export function isResumeOcrEnabled(): boolean {
  const v = process.env['51JOB_RESUME_OCR']?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
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
    await writeFile(textPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return { textPath, text };
  };

  const p = ocrChain.then(run);
  ocrChain = p.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[51job-cli] resume OCR chain reset after failure:', msg);
  });
  return p;
}
