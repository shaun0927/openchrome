/**
 * DOM Delta Feedback - Captures what changed in the DOM after an action
 *
 * Injects a MutationObserver before an action, collects mutations after,
 * and formats a compact delta string that tells the LLM what happened
 * without needing a screenshot.
 */

import type { Page } from 'puppeteer-core';
import { safeTitle } from './safe-title';

export interface DomDeltaOptions {
  /** Time to wait for DOM to settle after action (ms). Default: 150 */
  settleMs?: number;
  /** Maximum characters for the delta string. Default: 500 */
  maxChars?: number;
}

export interface DomDeltaResult<T> {
  result: T;
  delta: string;
}

// Script injected into the page to set up the MutationObserver
const INJECT_OBSERVER_SCRIPT = `(() => {
  const delta = {
    preUrl: location.href,
    preTitle: document.title,
    preScroll: { x: window.scrollX, y: window.scrollY },
    mutations: []
  };

  const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT']);
  const MAX_MUTATIONS = 15;

  const observer = new MutationObserver((records) => {
    if (delta.mutations.length >= MAX_MUTATIONS) return;

    for (const r of records) {
      if (delta.mutations.length >= MAX_MUTATIONS) break;

      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (delta.mutations.length >= MAX_MUTATIONS) break;
          if (n.nodeType !== 1) continue;
          const el = n;
          if (IGNORE_TAGS.has(el.tagName)) continue;
          const role = el.getAttribute && el.getAttribute('role');
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 40);
          const label = role ? tag + '[role="' + role + '"]' : tag;
          delta.mutations.push({ type: 'added', label, text });
        }
        for (const n of r.removedNodes) {
          if (delta.mutations.length >= MAX_MUTATIONS) break;
          if (n.nodeType !== 1) continue;
          const el = n;
          if (IGNORE_TAGS.has(el.tagName)) continue;
          const role = el.getAttribute && el.getAttribute('role');
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 40);
          const label = role ? tag + '[role="' + role + '"]' : tag;
          delta.mutations.push({ type: 'removed', label, text });
        }
      }

      if (r.type === 'attributes') {
        if (delta.mutations.length >= MAX_MUTATIONS) break;
        const el = r.target;
        if (el.nodeType !== 1) continue;
        if (IGNORE_TAGS.has(el.tagName)) continue;
        const attr = r.attributeName;
        const oldVal = r.oldValue;
        const newVal = el.getAttribute(attr);
        if (oldVal === newVal) continue;
        // Skip pure CSS animation class changes
        if (attr === 'class') {
          const oldClasses = new Set((oldVal || '').split(/\\s+/));
          const newClasses = new Set((newVal || '').split(/\\s+/));
          const added = [...newClasses].filter(c => !oldClasses.has(c));
          const removed = [...oldClasses].filter(c => !newClasses.has(c));
          const allChanges = [...added, ...removed];
          const isAnimOnly = allChanges.every(c =>
            /^(animate|fade|slide|transition|entering|leaving|active|ng-|v-)/i.test(c)
          );
          if (isAnimOnly && allChanges.length > 0) continue;
        }
        const tag = el.tagName.toLowerCase();
        const id = el.id ? '#' + el.id : '';
        const label = tag + id;
        const oldStr = oldVal != null ? String(oldVal).slice(0, 30) : 'null';
        const newStr = newVal != null ? String(newVal).slice(0, 30) : 'null';
        delta.mutations.push({ type: 'attribute', label, attr, oldVal: oldStr, newVal: newStr });
      }
    }
  });

  // Disconnect any previous observer to avoid global collision on concurrent calls
  if (window.__ocObserver) {
    try { window.__ocObserver.disconnect(); } catch(e) {}
  }

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-expanded',
                       'aria-hidden', 'open', 'checked', 'value', 'src', 'href']
  });

  window.__ocDelta = delta;
  window.__ocObserver = observer;
})()`;

// Script to collect mutations after action
const COLLECT_DELTA_SCRIPT = `(() => {
  try {
    if (!window.__ocObserver) return null;
    window.__ocObserver.disconnect();
    const d = window.__ocDelta;
    if (!d) return null;

    const result = {
      urlChanged: location.href !== d.preUrl,
      newUrl: location.href !== d.preUrl ? location.href : null,
      titleChanged: document.title !== d.preTitle,
      newTitle: document.title !== d.preTitle ? document.title : null,
      scrollChanged: window.scrollX !== d.preScroll.x || window.scrollY !== d.preScroll.y,
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      preScroll: d.preScroll,
      mutations: d.mutations
    };

    // Cleanup
    delete window.__ocDelta;
    delete window.__ocObserver;

    return result;
  } catch (e) {
    return null;
  }
})()`;

interface CollectedDelta {
  urlChanged: boolean;
  newUrl: string | null;
  titleChanged: boolean;
  newTitle: string | null;
  scrollChanged: boolean;
  scroll: { x: number; y: number };
  preScroll: { x: number; y: number };
  mutations: Array<{
    type: 'added' | 'removed' | 'attribute';
    label: string;
    text?: string;
    attr?: string;
    oldVal?: string;
    newVal?: string;
  }>;
}

/**
 * Format collected delta into a compact readable string
 */
function formatDelta(delta: CollectedDelta, maxChars: number): string {
  const lines: string[] = [];

  // Deduplicate mutations: collapse identical entries
  const seen = new Set<string>();
  const uniqueMutations = delta.mutations.filter(m => {
    const key = `${m.type}|${m.label}|${m.text || ''}|${m.attr || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Cap at 10 per type
  const added = uniqueMutations.filter(m => m.type === 'added').slice(0, 10);
  const removed = uniqueMutations.filter(m => m.type === 'removed').slice(0, 10);
  const changed = uniqueMutations.filter(m => m.type === 'attribute').slice(0, 10);

  for (const m of added) {
    const text = m.text ? `: "${m.text}"` : '';
    lines.push(`+ ${m.label}${text}`);
  }

  for (const m of removed) {
    const text = m.text ? `: "${m.text}"` : '';
    lines.push(`- ${m.label}${text}`);
  }

  for (const m of changed) {
    lines.push(`~ ${m.label}: ${m.attr} ${m.oldVal}\u2192${m.newVal}`);
  }

  if (delta.urlChanged && delta.newUrl) {
    lines.push(`URL: ${delta.newUrl}`);
  }

  if (delta.titleChanged && delta.newTitle) {
    lines.push(`Title: "${delta.newTitle}"`);
  }

  if (delta.scrollChanged) {
    lines.push(`Scroll: ${delta.preScroll.x},${delta.preScroll.y} \u2192 ${delta.scroll.x},${delta.scroll.y}`);
  }

  if (lines.length === 0) return '';

  let result = '\n[DOM Delta]\n' + lines.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 3) + '...';
  }
  return result;
}

/**
 * Execute an action while capturing DOM mutations.
 *
 * Injects a MutationObserver before the action, waits for the DOM to settle
 * after the action, then collects and formats the changes.
 *
 * If the action causes a page navigation, the observer is destroyed —
 * we detect this via URL change and report the navigation instead.
 */
export async function withDomDelta<T>(
  page: Page,
  action: () => Promise<T>,
  options?: DomDeltaOptions
): Promise<DomDeltaResult<T>> {
  const settleMs = options?.settleMs ?? 150;
  const maxChars = options?.maxChars ?? 500;

  let preUrl: string;
  try {
    preUrl = page.url();
  } catch {
    preUrl = '';
  }

  // Inject the MutationObserver
  try {
    await page.evaluate(INJECT_OBSERVER_SCRIPT);
  } catch {
    // If injection fails (e.g., page not ready), just run the action without delta
    const result = await action();
    return { result, delta: '' };
  }

  // Listen for navigation that would destroy the observer
  let navigated = false;
  const onNav = () => { navigated = true; };
  page.on('framenavigated', onNav);

  // Execute the action (try/finally ensures observer cleanup on failure)
  let result: T;
  try {
    result = await action();
  } catch (e) {
    page.off('framenavigated', onNav);
    // Try to disconnect observer on failure
    try { await page.evaluate('window.__ocObserver && window.__ocObserver.disconnect()'); } catch {}
    throw e;
  }

  // Wait for DOM to settle
  await new Promise(resolve => setTimeout(resolve, settleMs));

  // Check if navigation occurred (observer would be destroyed)
  let postUrl: string;
  try {
    postUrl = page.url();
  } catch {
    postUrl = '';
  }

  page.off('framenavigated', onNav);

  if (navigated || (postUrl && preUrl && postUrl !== preUrl)) {
    // Page navigated — observer is gone
    let title = '';
    try {
      title = await safeTitle(page);
    } catch {
      // ignore
    }
    let delta = `\n[Page navigated: ${postUrl}]`;
    if (title) {
      delta += `\n[Title: "${title}"]`;
    }
    return { result, delta };
  }

  // Collect mutations
  try {
    const collected = await page.evaluate(COLLECT_DELTA_SCRIPT) as CollectedDelta | null;
    if (!collected) {
      return { result, delta: '' };
    }
    const delta = formatDelta(collected, maxChars);
    return { result, delta };
  } catch {
    // Collection failed (page might have navigated or crashed)
    return { result, delta: '' };
  }
}
