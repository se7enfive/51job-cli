import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'puppeteer-core';
import { out } from '../utils/output';
import { probeDir, ensureDirs } from '../utils/store';

export interface ProbeElement {
  tag: string;
  id?: string;
  name?: string;
  cls: string;
  text: string;
  type?: string;
  placeholder?: string;
  href?: string;
}

export interface ProbeResult {
  url: string;
  title: string;
  time: string;
  inputs: ProbeElement[];
  buttons: ProbeElement[];
  links: ProbeElement[];
  listLike: ProbeElement[];
  savePath: string;
}

const MAX_PER_CATEGORY = 40;

function dedupe(els: ProbeElement[]): ProbeElement[] {
  const seen = new Set<string>();
  const out: ProbeElement[] = [];
  for (const e of els) {
    const key = `${e.tag}|${e.cls}|${e.text}|${e.id || ''}|${e.placeholder || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * 探查当前页面结构：抓取输入框、按钮、链接、疑似列表容器，
 * 输出结构化 JSON（同时保存到 ~/.51job-cli/probe/ 下），供校准 selectors.ts。
 */
export async function probePage(page: Page): Promise<ProbeResult> {
  const url = page.url();
  const title = await page.title().catch(() => '');

  const collected = await page.evaluate(() => {
    const pick = (el: Element): { cls: string; text: string } => ({
      cls: typeof el.className === 'string' ? el.className : '',
      text: (el.textContent || '').trim().slice(0, 60),
    });

    const inputs: ProbeElement[] = [];
    document.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach((el) => {
      const html = el as HTMLInputElement;
      inputs.push({
        tag: el.tagName.toLowerCase(),
        id: html.id || undefined,
        name: html.getAttribute('name') || undefined,
        cls: pick(el).cls,
        text: pick(el).text,
        type: html.getAttribute('type') || undefined,
        placeholder: html.getAttribute('placeholder') || undefined,
      });
    });

    const buttons: ProbeElement[] = [];
    document.querySelectorAll('button, [role="button"], [class*="btn"]').forEach((el) => {
      buttons.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        cls: pick(el).cls,
        text: pick(el).text,
      });
    });

    const links: ProbeElement[] = [];
    document.querySelectorAll('a[href]').forEach((el) => {
      const a = el as HTMLAnchorElement;
      links.push({
        tag: 'a',
        id: el.id || undefined,
        cls: pick(el).cls,
        text: pick(el).text,
        href: a.href,
      });
    });

    const listLike: ProbeElement[] = [];
    document
      .querySelectorAll('[class*="list"] li, [class*="list-item"], [class*="item"]:not([class*="items"] *)')
      .forEach((el) => {
        listLike.push({ tag: el.tagName.toLowerCase(), cls: pick(el).cls, text: pick(el).text });
      });

    return { inputs, buttons, links, listLike };
  });

  ensureDirs();
  const file = path.join(probeDir(), `probe-${Date.now()}.json`);
  const result: ProbeResult = {
    url,
    title,
    time: new Date().toISOString(),
    inputs: dedupe(collected.inputs).slice(0, MAX_PER_CATEGORY),
    buttons: dedupe(collected.buttons).slice(0, MAX_PER_CATEGORY),
    links: dedupe(collected.links).slice(0, MAX_PER_CATEGORY),
    listLike: dedupe(collected.listLike).slice(0, MAX_PER_CATEGORY),
    savePath: file,
  };

  // T203：probe 快照可能含候选人姓名等 PII，权限收紧（POSIX 生效，Windows 仅 read-only 位）
  fs.writeFileSync(file, JSON.stringify(result, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return result;
}

export function printProbe(result: ProbeResult): void {
  out(`页面: ${result.url}`);
  out(`标题: ${result.title}`);
  out('');

  out(`输入框 (${result.inputs.length}):`);
  for (const e of result.inputs) {
    out(`  <${e.tag}${e.id ? ' id="' + e.id + '"' : ''}${e.name ? ' name="' + e.name + '"' : ''} type="${e.type || ''}" placeholder="${e.placeholder || ''}" class="${e.cls}">`);
  }
  out('');

  out(`按钮 (${result.buttons.length}):`);
  for (const e of result.buttons) {
    out(`  <${e.tag}${e.id ? ' id="' + e.id + '"' : ''} class="${e.cls}"> ${e.text}`);
  }
  out('');

  out(`链接 (${result.links.length}):`);
  for (const e of result.links.slice(0, 20)) {
    out(`  <a class="${e.cls}"> ${e.text} → ${e.href}`);
  }
  out('');

  out(`疑似列表容器 (${result.listLike.length}):`);
  for (const e of result.listLike.slice(0, 20)) {
    out(`  <${e.tag} class="${e.cls}"> ${e.text.slice(0, 50)}`);
  }
  out('');
  out(`完整 JSON 已保存: ${result.savePath}`);
}
