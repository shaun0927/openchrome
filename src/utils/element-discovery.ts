/**
 * Element Discovery - Shared element search and CDP resolution utilities
 *
 * Extracts the duplicated element discovery logic from find, click_element,
 * interact, wait_and_click, and fill_form tools into a single reusable module.
 *
 * Flow: in-page search (page.evaluate) → batched CDP backendNodeId resolution
 */

import { Page } from 'puppeteer-core';
import { CDPClient } from '../cdp/client';
import { FoundElement } from './element-finder';
import { discoverShadowElements } from './shadow-dom';
import { withTimeout } from './with-timeout';

/**
 * Options for element discovery.
 */
export interface DiscoverOptions {
  /** Maximum number of candidates to collect (default: 30) */
  maxResults?: number;
  /** Return center coordinates instead of top-left (default: false) */
  useCenter?: boolean;
  /** Timeout in ms for the page.evaluate call (default: 10000) */
  timeout?: number;
  /** Tool name for timeout error messages */
  toolName?: string;
}

/**
 * Form field discovered on the page.
 */
export interface FormField {
  backendDOMNodeId: number;
  fieldName: string;
  tagName: string;
  type?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  label?: string;
  rect: { x: number; y: number; width: number; height: number };
}

// Internal type alias for the element shape returned by page.evaluate
type RawElement = Omit<FoundElement, 'score'>;

/**
 * Tag property name used to mark discovered elements in the DOM.
 * Tools can use this to re-find elements after scroll/reposition.
 */
export const DISCOVERY_TAG = '__elDiscIdx';

/**
 * Tag property name used to mark discovered form fields in the DOM.
 */
export const FORM_FIELD_TAG = '__formFieldIdx';

/**
 * Discover elements matching a query on the page.
 *
 * Handles the complete flow:
 * 1. In-page search via page.evaluate (interactive selectors + TreeWalker text match)
 * 2. Batched CDP resolution of backendDOMNodeIds
 *
 * Returns elements WITHOUT scores - callers should use scoreElement() from
 * element-finder.ts to score and sort results.
 *
 * @example
 * ```ts
 * const results = await discoverElements(page, cdpClient, 'login button', { useCenter: true });
 * const scored = results
 *   .map(el => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens) }))
 *   .sort((a, b) => b.score - a.score);
 * ```
 */
export async function discoverElements(
  page: Page,
  cdpClient: CDPClient,
  query: string,
  options?: DiscoverOptions,
): Promise<RawElement[]> {
  const maxResults = options?.maxResults ?? 30;
  const useCenter = options?.useCenter ?? false;
  const timeout = options?.timeout ?? 10000;
  const toolName = options?.toolName ?? 'element-discovery';

  // Step 1: In-page element search
  const results = await withTimeout(
    page.evaluate(
      (searchQuery: string, maxRes: number, centerCoords: boolean, tagProp: string): RawElement[] => {
        const elements: RawElement[] = [];
        const searchLower = searchQuery.toLowerCase();
        const queryTokens = searchLower
          .split(/\s+/)
          .filter(t => t.length > 1)
          .filter(t => !['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or'].includes(t));

        function getElementInfo(el: Element): RawElement | null {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;

          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
            return null;
          }

          const inputEl = el as HTMLInputElement;
          const isContentEditable = el.getAttribute('contenteditable') === 'true';
          const role =
            el.getAttribute('role') ||
            (el.tagName === 'BUTTON'
              ? 'button'
              : el.tagName === 'A'
                ? 'link'
                : el.tagName === 'INPUT'
                  ? inputEl.type || 'textbox'
                  : isContentEditable
                    ? 'textbox'
                    : el.tagName.toLowerCase());

          return {
            backendDOMNodeId: 0,
            role,
            name:
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              el.textContent?.trim().slice(0, 100) ||
              '',
            tagName: el.tagName.toLowerCase(),
            type: inputEl.type,
            placeholder: inputEl.placeholder,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            textContent: el.textContent?.trim().slice(0, 50),
            rect: {
              x: centerCoords ? rect.x + rect.width / 2 : rect.x,
              y: centerCoords ? rect.y + rect.height / 2 : rect.y,
              width: rect.width,
              height: rect.height,
            },
          };
        }

        const interactiveSelectors = [
          'button',
          '[role="button"]',
          'a',
          '[role="link"]',
          'input[type="submit"]',
          'input[type="button"]',
          'input[type="radio"]',
          'input[type="checkbox"]',
          '[role="radio"]',
          '[role="checkbox"]',
          '[role="menuitem"]',
          '[role="tab"]',
          '[role="option"]',
          '[onclick]',
          '[tabindex]',
          '[contenteditable="true"]',
          '[role="combobox"]',
          '[role="listbox"]',
          '[role="switch"]',
          '[role="slider"]',
          '[role="treeitem"]',
          '[role="dialog"] [aria-label]',
          '[role="alertdialog"] [aria-label]',
          '[data-testid]',
        ];

        const seen = new Set<Element>();

        // First pass: interactive elements matching query text
        for (const selector of interactiveSelectors) {
          if (elements.length >= maxRes) break;
          try {
            for (const el of document.querySelectorAll(selector)) {
              if (seen.has(el) || elements.length >= maxRes) continue;
              const info = getElementInfo(el);
              if (info) {
                const combinedText =
                  `${info.name} ${info.textContent || ''} ${info.ariaLabel || ''} ${info.placeholder || ''}`.toLowerCase();
                if (
                  queryTokens.some(token => combinedText.includes(token)) ||
                  combinedText.includes(searchLower)
                ) {
                  seen.add(el);
                  (el as unknown as Record<string, number>)[tagProp] = elements.length;
                  elements.push(info);
                }
              }
            }
          } catch {
            // Invalid selector
          }
        }

        // Second pass: text content search on all elements via TreeWalker
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node && elements.length < maxRes) {
          const el = node as Element;
          if (!seen.has(el)) {
            const info = getElementInfo(el);
            if (info) {
              const combinedText =
                `${info.name} ${info.textContent || ''} ${info.ariaLabel || ''} ${info.placeholder || ''}`.toLowerCase();
              if (
                combinedText.includes(searchLower) ||
                queryTokens.some(token => combinedText.includes(token))
              ) {
                seen.add(el);
                (el as unknown as Record<string, number>)[tagProp] = elements.length;
                elements.push(info);
              }
            }
          }
          node = walker.nextNode();
        }

        return elements;
      },
      query.toLowerCase(),
      maxResults,
      useCenter,
      DISCOVERY_TAG,
    ),
    timeout,
    toolName,
  );

  // Step 2: Resolve backend DOM node IDs via batched CDP
  await resolveBackendNodeIds(page, cdpClient, DISCOVERY_TAG, results);

  // Step 3: CDP shadow root element search
  // Only runs when there are remaining slots — avoids overhead on non-shadow pages
  const remainingSlots = maxResults - results.length;
  if (remainingSlots > 0) {
    try {
      const jsBackendIds = new Set(
        results.filter(r => r.backendDOMNodeId > 0).map(r => r.backendDOMNodeId),
      );
      const shadowElements = await discoverShadowElements(page, cdpClient, query, {
        maxResults: remainingSlots,
        useCenter,
        excludeBackendIds: jsBackendIds,
      });

      for (const sel of shadowElements) {
        if (results.length >= maxResults) break;
        results.push({
          backendDOMNodeId: sel.backendDOMNodeId,
          role: sel.role,
          name: sel.name,
          tagName: sel.tagName,
          type: sel.type,
          placeholder: sel.placeholder,
          ariaLabel: sel.ariaLabel,
          textContent: sel.textContent,
          rect: sel.rect,
        });
      }
    } catch {
      // Shadow search failure is non-fatal — JS results are still valid
    }
  }

  return results;
}

/**
 * Discover form fields on the page.
 *
 * Searches for input, textarea, select, and contenteditable elements,
 * resolving associated labels and backend node IDs.
 */
export async function discoverFormFields(
  page: Page,
  cdpClient: CDPClient,
  options?: { timeout?: number; toolName?: string },
): Promise<FormField[]> {
  const timeout = options?.timeout ?? 10000;
  const toolName = options?.toolName ?? 'fill_form';

  const results = await withTimeout(
    page.evaluate((tagProp: string): FormField[] => {
      const fields: FormField[] = [];

      function getLabel(el: Element): string | undefined {
        const inputEl = el as HTMLInputElement;
        if (inputEl.id) {
          const label = document.querySelector(`label[for="${inputEl.id}"]`);
          if (label) return label.textContent?.trim();
        }
        const parent = el.closest('label');
        if (parent) {
          const labelText = parent.textContent?.trim() || '';
          const inputText = el.textContent?.trim() || '';
          return labelText.replace(inputText, '').trim();
        }
        const prev = el.previousElementSibling;
        if (prev?.tagName === 'LABEL') {
          return prev.textContent?.trim();
        }
        return undefined;
      }

      const selectors = [
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"])',
        'textarea',
        'select',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[role="combobox"]',
      ];

      let index = 0;
      for (const selector of selectors) {
        try {
          for (const el of document.querySelectorAll(selector)) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

            const inputEl = el as HTMLInputElement;

            fields.push({
              backendDOMNodeId: 0,
              fieldName:
                getLabel(el) ||
                inputEl.name ||
                inputEl.placeholder ||
                inputEl.getAttribute('aria-label') ||
                `field_${index}`,
              tagName: el.tagName.toLowerCase(),
              type: inputEl.type,
              name: inputEl.name,
              placeholder: inputEl.placeholder,
              ariaLabel: el.getAttribute('aria-label') || undefined,
              label: getLabel(el),
              rect: {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                width: rect.width,
                height: rect.height,
              },
            });

            (el as unknown as Record<string, number>)[tagProp] = index++;
          }
        } catch {
          // Invalid selector
        }
      }

      return fields;
    }, FORM_FIELD_TAG),
    timeout,
    toolName,
  );

  // Resolve backend node IDs via batched CDP
  await resolveBackendNodeIds(page, cdpClient, FORM_FIELD_TAG, results);

  return results;
}

/**
 * Resolve backendDOMNodeIds for elements tagged with a property during page.evaluate.
 *
 * Uses batched approach for efficiency:
 * 1. Single Runtime.evaluate to collect all tagged elements
 * 2. Runtime.getProperties to get individual object references
 * 3. Parallel DOM.describeNode for all elements
 *
 * This replaces per-element resolution (O(n) round-trips) with batched resolution (O(1)).
 */
export async function resolveBackendNodeIds(
  page: Page,
  cdpClient: CDPClient,
  tagProperty: string,
  results: Array<{ backendDOMNodeId: number }>,
): Promise<void> {
  if (results.length === 0) return;

  // Skip if all elements already have valid backendDOMNodeIds (e.g., from CDP path)
  if (results.every(r => r.backendDOMNodeId > 0)) return;

  // Step 1: Single Runtime.evaluate to collect tagged elements in index order
  const { result: batchResult } = await cdpClient.send<{
    result: { objectId?: string };
  }>(page, 'Runtime.evaluate', {
    expression: `(() => {
      const indexedEls = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        const el = node;
        if (el.${tagProperty} !== undefined) {
          indexedEls.push({ el, index: el.${tagProperty} });
        }
      }
      indexedEls.sort((a, b) => a.index - b.index);
      return indexedEls.map(e => e.el);
    })()`,
    returnByValue: false,
  });

  if (!batchResult.objectId) return;

  // Step 2: Get array properties for individual element references
  const { result: properties } = await cdpClient.send<{
    result: Array<{ name: string; value: { objectId?: string } }>;
  }>(page, 'Runtime.getProperties', {
    objectId: batchResult.objectId,
    ownProperties: true,
  });

  // Step 3: Parallel DOM.describeNode for all elements
  const describePromises: Promise<void>[] = [];
  for (const prop of properties) {
    const index = parseInt(prop.name, 10);
    if (isNaN(index) || index >= results.length || !prop.value?.objectId) continue;
    if (results[index].backendDOMNodeId > 0) continue; // already resolved

    describePromises.push(
      cdpClient
        .send<{ node: { backendNodeId: number } }>(page, 'DOM.describeNode', {
          objectId: prop.value.objectId,
        })
        .then(({ node }) => {
          results[index].backendDOMNodeId = node.backendNodeId;
        })
        .catch(() => {
          // Skip elements that can't be resolved
        }),
    );
  }

  await Promise.all(describePromises);
}

/**
 * Get the current viewport-relative position of a tagged element.
 *
 * Useful for re-acquiring coordinates after DOM.scrollIntoViewIfNeeded,
 * since scrolling changes viewport-relative positions.
 */
export async function getTaggedElementRect(
  page: Page,
  cdpClient: CDPClient,
  tagProperty: string,
  tagIndex: number,
  useCenter: boolean = true,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const { result } = await cdpClient.send<{
    result: { value: { x: number; y: number; width: number; height: number } | null };
  }>(page, 'Runtime.evaluate', {
    expression: `(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while (node = walker.nextNode()) {
        const el = node;
        if (el.${tagProperty} === ${tagIndex}) {
          const rect = el.getBoundingClientRect();
          return {
            x: ${useCenter ? 'rect.x + rect.width / 2' : 'rect.x'},
            y: ${useCenter ? 'rect.y + rect.height / 2' : 'rect.y'},
            width: rect.width,
            height: rect.height,
          };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  return result.value;
}

/**
 * Clean up discovery tags from DOM elements.
 *
 * Call this after interaction is complete to avoid polluting the DOM.
 */
export async function cleanupTags(
  page: Page,
  tagProperty: string,
): Promise<void> {
  await page.evaluate((prop: string) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      const el = node as unknown as Record<string, unknown>;
      if (el[prop] !== undefined) {
        delete el[prop];
      }
      node = walker.nextNode();
    }
  }, tagProperty).catch(() => {
    // Non-fatal: page may have navigated
  });
}
