import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { sleep } from '../browser/timing.js';
import { cacheDir, ensureDirs } from '../utils/store.js';

const SESSION_LOCK_FILE = join(cacheDir(), 'session.lock');
const SESSION_LOCK_WAIT_MAX_MS = 30_000;
const SESSION_LOCK_POLL_MS = 250;

type SessionLockMeta = {
  pid: number;
  createdAt: number;
  hostname: string;
  cwd: string;
  /** 脱敏命令摘要（T204）：仅「脚本名 + 子命令」，绝不含参数值——send --text 的消息内容等不落盘 */
  command: string;
};

/** 脱敏命令摘要：丢弃全部选项与参数值，仅保留脚本文件名与子命令名。argv 可注入供测试。 */
export function sanitizedCommand(argv: string[] = process.argv): string {
  const script = basename(argv[1] ?? '51job');
  const sub = argv[2] && !argv[2].startsWith('-') ? ` ${argv[2]}` : '';
  return `${script}${sub}`;
}

function buildSessionLockMeta(): SessionLockMeta {
  return {
    pid: process.pid,
    createdAt: Date.now(),
    hostname: hostname(),
    cwd: process.cwd(),
    command: sanitizedCommand(),
  };
}

async function readSessionLockMeta(): Promise<SessionLockMeta | null> {
  try {
    const raw = await readFile(SESSION_LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionLockMeta>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.command !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      hostname: parsed.hostname,
      cwd: parsed.cwd,
      command: parsed.command,
    };
  } catch {
    return null;
  }
}

async function processExists(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    return code === 'EPERM';
  }
}

async function clearStaleSessionLockIfNeeded(): Promise<void> {
  const meta = await readSessionLockMeta();
  if (!meta) {
    await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
    return;
  }
  if (meta.hostname !== hostname()) {
    if (!(await processExists(meta.pid))) {
      await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
    }
    return;
  }
  if (await processExists(meta.pid)) {
    return;
  }
  await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
}

function formatSessionLockOwner(meta: SessionLockMeta | null): string {
  if (!meta) {
    return 'unknown';
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - meta.createdAt) / 1000));
  return [
    'pid=' + meta.pid,
    'host=' + meta.hostname,
    'age=' + ageSeconds + 's',
    meta.command ? 'cmd=' + meta.command : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * 跨进程会话锁：`open(path, 'wx')` 原子创建，杜绝两个命令同时操作浏览器。
 * - 锁文件含 pid/hostname/cwd/command 元数据，方便定位持有者。
 * - 持有者进程已死（stale）时自动清理。
 * - 最多等待 30s，超时抛错并显示锁持有者信息。
 */
export async function withSessionLock<T>(callback: () => Promise<T>): Promise<T> {
  ensureDirs();
  const deadline = Date.now() + SESSION_LOCK_WAIT_MAX_MS;

  while (true) {
    try {
      const handle = await open(SESSION_LOCK_FILE, 'wx');
      let lockCreated = false;
      try {
        await handle.writeFile(JSON.stringify(buildSessionLockMeta()), 'utf8');
        lockCreated = true;
      } finally {
        await handle.close().catch(() => {});
      }

      if (!lockCreated) {
        await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
        throw new Error('51job session lock creation failed.');
      }

      try {
        return await callback();
      } finally {
        await rm(SESSION_LOCK_FILE, { force: true }).catch(() => {});
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code !== 'EEXIST') {
        throw error;
      }

      await clearStaleSessionLockIfNeeded();
      if (Date.now() >= deadline) {
        const meta = await readSessionLockMeta();
        throw new Error(
          '51job session is busy for more than 30s. Lock owner: ' +
            formatSessionLockOwner(meta) +
            '. If stale, delete ' +
            SESSION_LOCK_FILE,
        );
      }
      await sleep(SESSION_LOCK_POLL_MS);
    }
  }
}
