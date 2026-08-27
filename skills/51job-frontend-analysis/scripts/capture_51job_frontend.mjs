#!/usr/bin/env node
/**
 * Capture 51job/ehire 线上前端 JS，归档到 docs/research/51job-online-js/<date>/。
 * 用于 51job-cli 可用性基线更新、反检测策略复核与选择器校准。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ENTRY_PAGES = [
  { label: 'ehire', url: 'https://ehire.51job.com/' },
  { label: 'login', url: 'https://login.51job.com/' },
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 30_000;
const RESEARCH_ROOT = path.join('docs', 'research', '51job-online-js');

const HIGH_RISK_PATTERNS = [
  'eh-crypto',
  'security',
  'risk',
  'captcha',
  'verify',
  'anti',
  'debugger',
  'MutationObserver',
];
const SEARCH_TERMS = [
  'debugger',
  'Function(',
  'constructor',
  'MutationObserver',
  'setInterval',
  'console',
  'devtools',
  'captcha',
  'verify',
  'risk',
  'security',
  'encrypt',
  'rsa',
  'aes',
  'md5',
  'sha1',
];

function usage() {
  return [
    'Usage: node skills/51job-frontend-analysis/scripts/capture_51job_frontend.mjs [--date YYYY-MM-DD] [--force]',
    '',
    'Captures 51job/ehire frontend JavaScript into docs/research/51job-online-js/<date>.',
    'Without --force, the output directory must not already exist.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { force: false, date: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      out.force = true;
      continue;
    }
    if (arg === '--date') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--date requires YYYY-MM-DD');
      out.date = value;
      i++;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) {
    throw new Error(`Invalid --date: ${out.date}`);
  }
  return out;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeUrl(raw, baseUrl) {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function toStableIdentity(url) {
  return url
    .replace(/\/element-ui@[\d.]+\.js$/i, '/element-ui@*.js')
    .replace(/\/in\/resource\/js\/\d{4}\/login\//i, '/in/resource/js/*/login/')
    .replace(/\/login\/(common|login)\.[a-f0-9]{6,}\.js$/i, '/login/$1.*.js')
    .replace(/\/eh-crypto\.min\.js\?version=[\d.]+$/i, '/eh-crypto.min.js?version=*')
    .replace(/\/(jquery|pointtrack)\.js\?\d+$/i, '/$1.js?*');
}

function localPathForUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const filename = parts.pop() || 'index';
  const safe = filename.replace(/[^a-zA-Z0-9_.~!$&'()*+,;=:@-]/g, '_');
  if (parts.length === 0) return safe;
  return path.join(...parts, safe);
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchStrict(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} while fetching ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, finalUrl: res.url || url };
}

function extractHtmlScripts(html, baseUrl) {
  const urls = new Set();
  const attrRe = /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrRe)) {
    const raw = match[1];
    if (!raw) continue;
    const url = normalizeUrl(raw, baseUrl);
    if (url) urls.add(url);
  }
  return Array.from(urls);
}

async function findLatestBaselineDir(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
    return dirs.length > 0 ? path.join(root, dirs[dirs.length - 1]) : null;
  } catch {
    return null;
  }
}

async function loadPreviousManifest(previousDir) {
  if (!previousDir) return null;
  try {
    const raw = await readFile(path.join(previousDir, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isHighRisk(scriptPath) {
  return HIGH_RISK_PATTERNS.some((p) => scriptPath.toLowerCase().includes(p));
}

function scanScript(text, terms) {
  const hits = {};
  for (const term of terms) {
    let count = 0;
    let idx = text.indexOf(term);
    while (idx !== -1) {
      count++;
      idx = text.indexOf(term, idx + term.length);
    }
    if (count > 0) hits[term] = count;
  }
  return hits;
}

function buildAnalysisMarkdown({ date, previousDir, previousManifest, currentEntries, currentScripts }) {
  const prevMap = new Map();
  if (previousManifest?.scripts) {
    for (const s of previousManifest.scripts) prevMap.set(toStableIdentity(s.url), s);
  }
  const currentMap = new Map();
  for (const s of currentScripts) currentMap.set(toStableIdentity(s.url), s);

  const identities = new Set([...prevMap.keys(), ...currentMap.keys()]);
  const added = [];
  const removed = [];
  const changedHashes = [];
  const unchanged = [];

  for (const id of identities) {
    const prev = prevMap.get(id);
    const cur = currentMap.get(id);
    if (!prev && cur) {
      added.push(cur);
    } else if (prev && !cur) {
      removed.push(prev);
    } else if (prev && cur && prev.sha256 !== cur.sha256) {
      changedHashes.push({ url: cur.url, previousSha256: prev.sha256, currentSha256: cur.sha256 });
    } else if (prev && cur) {
      unchanged.push(cur.url);
    }
  }

  const baselineChanged = added.length > 0 || removed.length > 0 || changedHashes.length > 0;
  const riskHits = currentScripts
    .filter((s) => isHighRisk(s.localPath))
    .map((s) => ({ path: s.localPath, hits: scanScript(s.text, SEARCH_TERMS) }))
    .filter((s) => Object.keys(s.hits).length > 0);

  const lines = [
    '# 51job Frontend Analysis',
    '',
    `- Capture date: ${date}`,
    `- Previous baseline: ${previousDir ? path.basename(previousDir) : 'none'}`,
    `- Entries: ${currentEntries.map((e) => `${e.label}(${e.scripts.length})`).join(', ')}`,
    '',
    '## Entry Pages',
    '',
    ...currentEntries.map(
      (e) => `- **${e.label}**: ${e.url} -> ${e.finalUrl} (${e.bytes} bytes, sha256 ${e.sha256})`,
    ),
    '',
    '## Script Summary',
    '',
    '| Identity | URL | Size | SHA-256 |',
    '| --- | --- | --- | --- |',
    ...currentScripts.map(
      (s) => `| \`${toStableIdentity(s.url)}\` | [${s.url}](${s.url}) | ${s.bytes} | ${s.sha256} |`,
    ),
    '',
  ];

  if (added.length > 0 || removed.length > 0 || changedHashes.length > 0) {
    lines.push('## Baseline Diff', '');
    if (added.length > 0) {
      lines.push('### Added', '', ...added.map((s) => `- ${s.url}`), '');
    }
    if (removed.length > 0) {
      lines.push('### Removed', '', ...removed.map((s) => `- ${s.url}`), '');
    }
    if (changedHashes.length > 0) {
      lines.push(
        '### Same-Identity Hash Changes',
        '',
        ...changedHashes.map((s) => `- ${s.url}: ${s.previousSha256} -> ${s.currentSha256}`),
        '',
      );
    }
  }

  lines.push('## High-Risk Pattern Hits', '');
  if (riskHits.length === 0) {
    lines.push('- No configured high-risk terms found in high-risk scripts.', '');
  } else {
    for (const item of riskHits) {
      const summary = Object.entries(item.hits)
        .map(([term, count]) => `${term}=${count}`)
        .join(', ');
      lines.push(`- ${item.path}: ${summary}`);
    }
    lines.push('');
  }

  lines.push('## Recommendation', '');
  if (baselineChanged) {
    lines.push(
      '- 51job 前端基线发生变化，应保持 CLI 禁用直到人工复核完成。',
      '- 更新 `src/core/availability.ts` 中的常量与哈希。',
      '- 复核 `src/core/pageGuards.ts` 的请求拦截模式是否仍覆盖新的风险/安全脚本。',
      '- 复核 `src/pages/selectors.ts` 中受影响页面的选择器。',
    );
  } else {
    lines.push(
      '- 线上脚本与上一基线在 URL/身份/哈希层面一致。',
      '- 除非人工复核发现行为变化，否则无需更新 availability 常量。',
    );
  }
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = args.date || todayInShanghai();
  const outDir = path.join(RESEARCH_ROOT, date);
  const rawDir = path.join(outDir, 'raw');

  if ((await pathExists(outDir)) && !args.force) {
    throw new Error(`Output directory already exists: ${outDir}. Use --force to overwrite.`);
  }
  await mkdir(rawDir, { recursive: true });

  const currentEntries = [];
  const currentScripts = [];
  const fetchedUrls = new Set();

  for (const entry of ENTRY_PAGES) {
    const fetched = await fetchStrict(entry.url);
    const scripts = extractHtmlScripts(fetched.buffer.toString('utf8'), entry.url);
    currentEntries.push({
      label: entry.label,
      url: entry.url,
      finalUrl: fetched.finalUrl,
      bytes: fetched.buffer.length,
      sha256: sha256(fetched.buffer),
      scripts,
    });

    for (const url of scripts) {
      if (fetchedUrls.has(url)) continue;
      fetchedUrls.add(url);
      try {
        const sf = await fetchStrict(url);
        const text = sf.buffer.toString('utf8');
        const localPath = localPathForUrl(url);
        const rawFile = path.join(rawDir, localPath);
        await mkdir(path.dirname(rawFile), { recursive: true });
        await writeFile(rawFile, sf.buffer);
        currentScripts.push({
          url,
          localPath,
          bytes: sf.buffer.length,
          sha256: sha256(sf.buffer),
          text,
        });
      } catch (e) {
        console.warn(`[warn] failed to fetch script ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const previousDir = await findLatestBaselineDir(RESEARCH_ROOT);
  const previousManifest = previousDir && path.basename(previousDir) !== date ? await loadPreviousManifest(previousDir) : null;

  const manifest = {
    capturedAt: new Date().toISOString(),
    previousBaseline: previousDir ? path.basename(previousDir) : null,
    entries: currentEntries,
    scripts: currentScripts.map((s) => ({ url: s.url, localPath: s.localPath, bytes: s.bytes, sha256: s.sha256 })),
  };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const analysis = buildAnalysisMarkdown({
    date,
    previousDir,
    previousManifest,
    currentEntries,
    currentScripts,
  });
  await writeFile(path.join(outDir, 'analysis.md'), analysis);

  console.log(`Archived to ${outDir}`);
  console.log(`- Entry pages: ${currentEntries.length}`);
  console.log(`- Scripts: ${currentScripts.length}`);
  console.log(`- Previous baseline: ${previousDir ? path.basename(previousDir) : 'none'}`);
}

main().catch((e) => {
  console.error('[capture_51job_frontend] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
