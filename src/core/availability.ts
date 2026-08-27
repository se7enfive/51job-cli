import { createHash } from 'node:crypto';
import { readJson, writeJson, cacheDir } from '../utils/store';
import { join } from 'node:path';

/**
 * 51job 线上前端可用性校验（boss_availability 对应移植）。
 *
 * 设计与 boss-cli 的差异（按 51job 实测调整）：
 * - ehire 壳页（https://ehire.51job.com/）与登录页（https://login.51job.com/）
 *   匿名可访问，校验无需登录态、无需启动浏览器。
 * - ehire 微前端 gaea chunk（main-*.chunk.js）每次发版都换文件名，只做
 *   「数量存在性」校验（>= 8 个），不做 URL/哈希钉死。
 * - 登录页 common.*.js / login.*.js 为内容哈希文件名，做「模式存在性」校验，
 *   不钉哈希——避免 51job 例行发版导致 CLI 误禁用。
 * - 只有「稳定命名」的核心脚本（vue-bundle / element-ui / eh-crypto /
 *   pdf.min / jquery / pointtrack）钉 SHA-256：这些变更意味着前端底座或
 *   登录加密逻辑被改动，选择器与守卫需要重新复核。
 * - 校验结果落盘缓存 6 小时（~/.51job-cli/.cache/availability.json），
 *   避免每条命令都重新下载约 2MB 脚本；51JOB_AVAILABILITY_REFRESH=1 强制刷新。
 */

const CHECK_ENTRY_URL = 'https://ehire.51job.com/';
const CHECK_LOGIN_URL = 'https://login.51job.com/';
const CHECK_TIMEOUT_MS = 45_000;
const VERIFIED_CAPTURE_LABEL = '2026-08-25 51job-online-js snapshot';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_FILE = 'availability.json';

const CHECK_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
} as const;

/** ehire 壳页必需脚本（存在性 + 身份宽容匹配） */
const REQUIRED_ENTRY_SCRIPT_URLS = [
  'https://fccdn.51jobcdn.com/ehire2021/public/js/vue-bundle.js',
  'https://fccdn.51jobcdn.com/ehire2021/public/js/element-ui@2.15.14.js',
  'https://fccdn.51jobcdn.com/ehire2021/public/js/eh-crypto.min.js?version=1.0.1',
  'https://fccdn.51jobcdn.com/ehire2021/public/js/pdf.min.js',
] as const;

/** 登录页必需脚本（jquery/pointtrack 稳定命名；common/login 为哈希文件名，靠模式匹配） */
const REQUIRED_LOGIN_SCRIPT_URLS = [
  'https://js.51jobcdn.com/in/js/2016/jquery.js?20180319',
  'https://js.51jobcdn.com/in/js/2016/pointtrack.js?20211019',
  'https://js.51jobcdn.com/in/resource/js/2025/login/common.e76ad9ae.js',
  'https://js.51jobcdn.com/in/resource/js/2025/login/login.a9554db6.js',
] as const;

/** 内容级哈希守护：仅稳定命名脚本（变更 = 前端底座/登录加密改动） */
const GUARDED_SCRIPT_HASHES = [
  {
    label: 'ehire vue-bundle',
    url: 'https://fccdn.51jobcdn.com/ehire2021/public/js/vue-bundle.js',
    sha256: '0b6479880461ca50959c268e584c6495d5afbdb9e82202295ace9e01f10c5ef0',
  },
  {
    label: 'ehire element-ui',
    url: 'https://fccdn.51jobcdn.com/ehire2021/public/js/element-ui@2.15.14.js',
    sha256: '4348c450e6c72f1c4fdf376febf391de8041cd5f89f90dd3a0b66a3c76a63665',
  },
  {
    label: 'ehire eh-crypto（登录加密）',
    url: 'https://fccdn.51jobcdn.com/ehire2021/public/js/eh-crypto.min.js?version=1.0.1',
    sha256: 'd9fa70ea5465bebbfd5e70a23b88d012e4b6e1f4135b731b8321396c61955d37',
  },
  {
    label: 'ehire pdf.min',
    url: 'https://fccdn.51jobcdn.com/ehire2021/public/js/pdf.min.js',
    sha256: '3baa68966dd94536443809de61bbec2adcb77372917037f6d0c730b650a06b9b',
  },
  {
    label: 'login jquery',
    url: 'https://js.51jobcdn.com/in/js/2016/jquery.js?20180319',
    sha256: 'fbf67a9fb31274f6d34ed1b549f318c1deb1f43b5339ac7228348bf9ce16c49f',
  },
  {
    label: 'login pointtrack',
    url: 'https://js.51jobcdn.com/in/js/2016/pointtrack.js?20211019',
    sha256: '80493f262ae01e9f4268bc617f0083cb474f9a1f53bdf0368cc043289c2a36e9',
  },
] as const;

/** gaea 微前端 chunk 最少数量（低于此值说明壳页结构大改） */
const MIN_GAEA_CHUNKS = 8;

export class JobAvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobAvailabilityError';
  }
}

function normalizeRemoteUrl(raw: string, baseUrl: string): string | null {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractAssetUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  // 页面内脚本为协议相对地址（//fccdn.51jobcdn.com/...）
  const attrRe = /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrRe)) {
    const raw = match[1];
    if (!raw) continue;
    const url = normalizeRemoteUrl(raw, baseUrl);
    if (url) urls.add(url);
  }
  return Array.from(urls).sort();
}

/**
 * 身份宽容匹配：版本号 / 日期查询串 / 内容哈希文件名 / 年份目录变化均视为同一脚本。
 * 例：
 *   eh-crypto.min.js?version=1.0.2  ≡ eh-crypto.min.js?version=1.0.1
 *   jquery.js?20250101               ≡ jquery.js?20180319
 *   login.a9554db6.js                ≡ login.b83f2c1a.js
 *   /2026/login/login.*.js           ≡ /2025/login/login.*.js
 *   element-ui@2.15.15.js            ≡ element-ui@2.15.14.js
 */
function toStableScriptIdentity(url: string): string {
  return url
    .replace(/\/element-ui@[\d.]+\.js$/i, '/element-ui@*.js')
    .replace(/\/in\/resource\/js\/\d{4}\/login\//i, '/in/resource/js/*/login/')
    .replace(/\/login\/(common|login)\.[a-f0-9]{6,}\.js$/i, '/login/$1.*.js')
    .replace(/\/eh-crypto\.min\.js\?version=[\d.]+$/i, '/eh-crypto.min.js?version=*')
    .replace(/\/(jquery|pointtrack)\.js\?\d+$/i, '/$1.js?*');
}

function findCurrentScriptUrl(
  assetUrls: readonly string[],
  expectedUrl: string,
): { url: string | null; reason: string | null } {
  if (assetUrls.includes(expectedUrl)) {
    return { url: expectedUrl, reason: null };
  }
  const expectedIdentity = toStableScriptIdentity(expectedUrl);
  if (expectedIdentity === expectedUrl) {
    return { url: null, reason: null };
  }
  const matches = assetUrls.filter((url) => toStableScriptIdentity(url) === expectedIdentity);
  if (matches.length === 0) {
    return { url: null, reason: null };
  }
  if (matches.length > 1) {
    return {
      url: null,
      reason: `多个当前脚本匹配同一个已验证身份 ${expectedIdentity}: ${matches.join(', ')}`,
    };
  }
  return { url: matches[0], reason: null };
}

function formatDisabledMessage(reasons: string[]): string {
  return [
    '51job CLI 已禁用：51job 线上前端与已验证基线不一致。',
    `已验证基线：${VERIFIED_CAPTURE_LABEL}。`,
    '',
    '触发原因：',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    '处理方式：运行 skills/51job-frontend-analysis 的 capture 脚本重新归档线上 JS，',
    '复核选择器 / 反检测 / 登录加密策略，然后更新 src/core/availability.ts 基线后再使用。',
    '（更新基线后可设 51JOB_AVAILABILITY_REFRESH=1 立即失效旧缓存）',
  ].join('\n');
}

async function fetchBufferStrict(url: string): Promise<{ buffer: Buffer; finalUrl: string }> {
  const res = await fetch(url, {
    headers: CHECK_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} while fetching ${url}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  return { buffer: body, finalUrl: res.url || url };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function assertEntryPageMatches(params: {
  pageLabel: string;
  url: string;
  requiredScripts: readonly string[];
  /** 仅 ehire 壳页需要校验 gaea 微前端 chunk 数量 */
  checkGaeaChunks?: boolean;
}): Promise<{ reasons: string[]; assetUrls: string[] }> {
  try {
    const reasons: string[] = [];
    const { buffer, finalUrl } = await fetchBufferStrict(params.url);
    if (finalUrl !== params.url) {
      reasons.push(`${params.pageLabel} 发生跳转：${params.url} -> ${finalUrl}`);
    }
    const html = buffer.toString('utf8');
    const assetUrls = extractAssetUrls(html, params.url);

    for (const url of params.requiredScripts) {
      const current = findCurrentScriptUrl(assetUrls, url);
      if (current.reason) {
        reasons.push(`${params.pageLabel} ${current.reason}`);
        continue;
      }
      if (!current.url) {
        reasons.push(`${params.pageLabel} 缺少已验证脚本：${url}`);
      }
    }

    // gaea 微前端 chunk 数量校验（只查数量，不钉死具体 chunk）
    if (params.checkGaeaChunks) {
      const gaeaChunks = assetUrls.filter((u) => u.includes('/ehire2021/micro/gaea/js/main-'));
      if (gaeaChunks.length < MIN_GAEA_CHUNKS) {
        reasons.push(
          `${params.pageLabel} gaea 微前端 chunk 仅 ${gaeaChunks.length} 个（基线 >= ${MIN_GAEA_CHUNKS}），壳页结构疑似大改`,
        );
      }
    }

    return { reasons, assetUrls };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { reasons: [`无法读取 ${params.pageLabel} ${params.url}：${msg}`], assetUrls: [] };
  }
}

async function assertOnlineFrontendMatchesBaseline(): Promise<void> {
  const entryPage = await assertEntryPageMatches({
    pageLabel: '51job ehire 壳页',
    url: CHECK_ENTRY_URL,
    requiredScripts: REQUIRED_ENTRY_SCRIPT_URLS,
    checkGaeaChunks: true,
  });
  const loginPage = await assertEntryPageMatches({
    pageLabel: '51job 登录页',
    url: CHECK_LOGIN_URL,
    requiredScripts: REQUIRED_LOGIN_SCRIPT_URLS,
  });
  const reasons = [...entryPage.reasons, ...loginPage.reasons];
  const currentAssetUrls = [...entryPage.assetUrls, ...loginPage.assetUrls];

  if (reasons.length > 0) {
    throw new JobAvailabilityError(formatDisabledMessage(reasons));
  }

  for (const guarded of GUARDED_SCRIPT_HASHES) {
    const current = findCurrentScriptUrl(currentAssetUrls, guarded.url);
    if (current.reason) {
      reasons.push(`${guarded.label} ${current.reason}`);
      continue;
    }
    const guardedUrl = current.url ?? guarded.url;
    try {
      const { buffer, finalUrl } = await fetchBufferStrict(guardedUrl);
      if (finalUrl !== guardedUrl) {
        reasons.push(`${guarded.label} 发生跳转：${guardedUrl} -> ${finalUrl}`);
        continue;
      }
      const actualSha256 = sha256(buffer);
      if (actualSha256 !== guarded.sha256) {
        reasons.push(
          `${guarded.label} SHA-256 不一致：url ${guardedUrl}, expected ${guarded.sha256}, actual ${actualSha256}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reasons.push(`${guarded.label} 读取失败：${msg}`);
    }
  }

  if (reasons.length > 0) {
    throw new JobAvailabilityError(formatDisabledMessage(reasons));
  }
}

type AvailabilityCache = {
  checkedAtMs: number;
  ok: boolean;
  reasons?: string[];
};

function readAvailabilityCache(): AvailabilityCache | null {
  const cached = readJson<AvailabilityCache>(join(cacheDir(), CACHE_FILE));
  if (!cached || typeof cached.checkedAtMs !== 'number') return null;
  return cached;
}

/** 业务命令入口调用；通过则静默返回，不通过抛 JobAvailabilityError（CLI 禁用）。 */
export async function assertJobCliAvailable(): Promise<void> {
  const forceRefresh = process.env.JOB_AVAILABILITY_REFRESH === '1' || process.env['51JOB_AVAILABILITY_REFRESH'] === '1';
  if (!forceRefresh) {
    const cached = readAvailabilityCache();
    if (cached && Date.now() - cached.checkedAtMs < CACHE_TTL_MS) {
      if (!cached.ok) {
        throw new JobAvailabilityError(formatDisabledMessage(cached.reasons ?? ['缓存的上次校验未通过']));
      }
      return;
    }
  }

  let ok = false;
  let reasons: string[] | undefined;
  try {
    await assertOnlineFrontendMatchesBaseline();
    ok = true;
  } catch (e) {
    if (e instanceof JobAvailabilityError) {
      reasons = e.message.split('\n');
      throw e;
    }
    throw e;
  } finally {
    try {
      writeJson(join(cacheDir(), CACHE_FILE), {
        checkedAtMs: Date.now(),
        ok,
        ...(reasons ? { reasons } : {}),
      } satisfies AvailabilityCache);
    } catch {
      /* 缓存写失败不影响校验结果 */
    }
  }
}
