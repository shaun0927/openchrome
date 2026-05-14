import type { Page } from 'puppeteer-core';

interface PreloadScript {
  id: string;
  source: string;
}

const scripts = new Map<string, PreloadScript>();
const applied = new WeakMap<Page, Set<string>>();

export function registerPreloadScript(id: string, source: string): void {
  if (!/^[a-z0-9._:-]{1,80}$/i.test(id)) {
    throw new Error(`Invalid preload script id: ${id}`);
  }
  scripts.set(id, { id, source });
}

export function unregisterPreloadScript(id: string): boolean {
  return scripts.delete(id);
}

export function listPreloadScriptIds(): string[] {
  return Array.from(scripts.keys()).sort();
}

export async function applyRegisteredPreloads(page: Page): Promise<void> {
  if (scripts.size === 0) return;
  let pageApplied = applied.get(page);
  if (!pageApplied) {
    pageApplied = new Set<string>();
    applied.set(page, pageApplied);
  }
  for (const script of scripts.values()) {
    if (pageApplied.has(script.id)) continue;
    await page.evaluateOnNewDocument(script.source).catch((err: unknown) => {
      throw new Error(`preload_script_failed:${script.id}:${err instanceof Error ? err.message : String(err)}`);
    });
    pageApplied.add(script.id);
  }
}

export function _resetPreloadScriptsForTests(): void {
  scripts.clear();
}
