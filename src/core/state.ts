import * as fs from 'fs';
import { readJson, writeJson, stateFile, cacheDir } from '../utils/store';

export interface BrowserState {
  pid: number;
  port: number;
  userDataDir: string;
  startedAt: string;
}

export function readState(): BrowserState | null {
  return readJson<BrowserState>(stateFile());
}

export function writeState(state: BrowserState): void {
  // T201：state.json 含 CDP 调试端口（拿到即可接管浏览器），权限收紧到仅本用户
  writeJson(stateFile(), state, 0o600);
}

export function clearState(): void {
  try {
    fs.unlinkSync(stateFile());
  } catch {
    // ignore
  }
}

export function defaultUserDataDir(): string {
  return cacheDir();
}

/**
 * 检测 pid 对应的进程是否存活。
 * Windows / Linux / macOS 通用：process.kill(pid, 0) 不发送信号，仅探测存在性。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 检测端口是否可连（用于判断常驻 Chrome 的调试端口是否还活着）。
 */
export async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net') as typeof import('net');
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}
