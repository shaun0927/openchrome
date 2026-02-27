/**
 * Visual Summary - Generates a lightweight text description of visible page state
 *
 * After click/navigate actions, extracts enough context (~100-150 tokens) for
 * LLMs to understand the current page state without requiring follow-up screenshots.
 */

import type { Page } from 'puppeteer-core';

// Script injected into the page to extract visible state in one evaluate call
const EXTRACT_STATE_SCRIPT = `(() => {
  try {
    const url = location.href;
    const title = document.title;

    // Scroll position
    const scrollX = Math.round(window.scrollX);
    const scrollY = Math.round(window.scrollY);
    const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    const clientHeight = document.documentElement.clientHeight || window.innerHeight || 0;

    // Active/focused element
    let activeEl = null;
    try {
      const el = document.activeElement;
      if (el && el !== document.body && el !== document.documentElement) {
        const tag = el.tagName.toLowerCase();
        const label =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('name') ||
          (el.textContent || '').trim().slice(0, 40);
        const ariaSelected = el.getAttribute('aria-selected');
        const ariaCurrent = el.getAttribute('aria-current');
        const isActive = el.classList.contains('active');
        activeEl = { tag, label, ariaSelected, ariaCurrent, isActive };
      }
    } catch (e) {}

    // Visible scrollable panels (role=tabpanel, [class*=panel], [class*=content], main, article)
    const panelSelectors = [
      '[role="tabpanel"]',
      'main',
      'article',
      '[class*="panel"]',
      '[class*="content"]',
    ];
    const panels = [];
    const seenPanels = new Set();
    for (const sel of panelSelectors) {
      if (panels.length >= 3) break;
      let found;
      try { found = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of found) {
        if (panels.length >= 3) break;
        if (seenPanels.has(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        if (!text) continue;
        seenPanels.add(el);
        panels.push(text);
      }
    }

    // Active tab/button states (aria-selected, aria-current, .active)
    const activeStates = [];
    try {
      const candidates = document.querySelectorAll(
        '[aria-selected="true"], [aria-current], .active, [class*="tab--active"], [class*="tab-active"]'
      );
      for (const el of candidates) {
        if (activeStates.length >= 5) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().slice(0, 40);
        const ariaSelected = el.getAttribute('aria-selected');
        const ariaCurrent = el.getAttribute('aria-current');
        const qualifier = ariaSelected === 'true' ? 'aria-selected' : ariaCurrent ? 'aria-current' : 'active';
        if (text) activeStates.push({ tag, text, qualifier });
      }
    } catch (e) {}

    // Visible form state (inputs, selects, checkboxes)
    const formState = [];
    try {
      const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
      for (const el of inputs) {
        if (formState.length >= 5) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || tag;
        const name = el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
        if (type === 'checkbox' || type === 'radio') {
          formState.push({ type, name, checked: el.checked });
        } else if (tag === 'select') {
          const opt = el.options[el.selectedIndex];
          const val = opt ? (opt.text || opt.value).slice(0, 30) : '';
          if (val) formState.push({ type: 'select', name, value: val });
        } else {
          const val = (el.value || '').slice(0, 40);
          if (val) formState.push({ type, name, value: val });
        }
      }
    } catch (e) {}

    // Visible headings for section context
    const headings = [];
    try {
      const hEls = document.querySelectorAll('h1, h2, h3, h4');
      for (const el of hEls) {
        if (headings.length >= 4) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().slice(0, 50);
        if (text) headings.push({ tag, text });
      }
    } catch (e) {}

    return { url, title, scrollX, scrollY, scrollHeight, clientHeight, panels, activeStates, formState, headings, activeEl };
  } catch (e) {
    return null;
  }
})()`;

interface PageState {
  url: string;
  title: string;
  scrollX: number;
  scrollY: number;
  scrollHeight: number;
  clientHeight: number;
  panels: string[];
  activeStates: Array<{ tag: string; text: string; qualifier: string }>;
  formState: Array<{ type: string; name: string; value?: string; checked?: boolean }>;
  headings: Array<{ tag: string; text: string }>;
  activeEl: { tag: string; label: string; ariaSelected: string | null; ariaCurrent: string | null; isActive: boolean } | null;
}

/**
 * Format extracted page state into a compact multi-line string.
 */
function formatPageState(state: PageState): string {
  const lines: string[] = [];

  // Line 1: URL, title, scroll position
  const scrollPct = state.scrollHeight > 0
    ? Math.round((state.scrollY / (state.scrollHeight - state.clientHeight || state.scrollHeight)) * 100)
    : 0;
  const titleShort = state.title.slice(0, 60);
  lines.push(`[Page State] url: ${state.url} | title: "${titleShort}" | scroll: ${state.scrollY}/${state.scrollHeight} (${scrollPct}%)`);

  // Active focused element (deduplicated with activeStates)
  if (state.activeEl) {
    const { tag, label, ariaSelected, ariaCurrent, isActive } = state.activeEl;
    const qualifier = ariaSelected === 'true' ? ' (aria-selected)' : ariaCurrent ? ' (aria-current)' : isActive ? ' (active)' : '';
    if (label) lines.push(`[Active] ${tag} "${label}"${qualifier}`);
  }

  // Active tab/button states
  if (state.activeStates.length > 0) {
    const parts = state.activeStates.map(s => `${s.tag} "${s.text}" (${s.qualifier})`);
    lines.push(`[Selected] ${parts.join(' | ')}`);
  }

  // Visible panels
  if (state.panels.length > 0) {
    const parts = state.panels.map((p, i) => `Panel ${i + 1}: "${p}"`);
    lines.push(`[Visible] ${parts.join(' | ')}`);
  }

  // Headings
  if (state.headings.length > 0) {
    const parts = state.headings.map(h => `${h.tag}: "${h.text}"`);
    lines.push(`[Headings] ${parts.join(' | ')}`);
  }

  // Form state
  if (state.formState.length > 0) {
    const parts = state.formState.map(f => {
      if (f.type === 'checkbox' || f.type === 'radio') {
        return `${f.name || f.type}=${f.checked ? 'checked' : 'unchecked'}`;
      }
      return `${f.name || f.type}="${f.value}"`;
    });
    lines.push(`[Form] ${parts.join(' | ')}`);
  }

  return lines.join('\n');
}

/**
 * Generate a lightweight text description of the visible page state.
 *
 * Extracts URL, title, scroll position, active elements, visible panel content,
 * headings, and form state — formatted for LLM consumption (~100-200 tokens).
 *
 * Returns an empty string on any error (non-blocking, fail-safe).
 */
export async function generateVisualSummary(page: Page): Promise<string> {
  try {
    const state = await Promise.race([
      page.evaluate(EXTRACT_STATE_SCRIPT) as Promise<PageState | null>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);

    if (!state) return '';

    return formatPageState(state);
  } catch {
    return '';
  }
}
