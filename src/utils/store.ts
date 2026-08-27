import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(os.homedir(), '.51job-cli');
const CACHE_DIR = path.join(ROOT, '.cache');
const JD_DIR = path.join(ROOT, 'jd');
const OCR_DIR = path.join(ROOT, 'ocr');
const STATE_FILE = path.join(ROOT, 'state.json');
const PROBE_DIR = path.join(ROOT, 'probe');

export function root(): string {
  return ROOT;
}

export function cacheDir(): string {
  return CACHE_DIR;
}

export function jdDir(): string {
  return JD_DIR;
}

export function stateFile(): string {
  return STATE_FILE;
}

export function probeDir(): string {
  return PROBE_DIR;
}

export function ocrDir(): string {
  return OCR_DIR;
}

export function ensureDirs(): void {
  for (const dir of [ROOT, CACHE_DIR, JD_DIR, OCR_DIR, PROBE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(file: string, data: unknown): void {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}
