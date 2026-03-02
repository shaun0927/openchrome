/**
 * Interact Tool - Composite tool that finds an element, performs an action,
 * waits for stability, and returns a comprehensive state summary.
 *
 * Reduces multi-step find→click→screenshot sequences to a single call.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { withDomDelta } from '../utils/dom-delta';
import { FoundElement, scoreElement, tokenizeQuery } from '../utils/element-finder';

const definition: MCPToolDefinition = {
  name: 'interact',
  description: 'Find element, act, wait for stability, return state summary in one call.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      query: {
        type: 'string',
        description: 'Element to interact with (natural language)',
      },
      action: {
        type: 'string',
        enum: ['click', 'double_click', 'hover'],
        description: 'Action to perform. Default: click',
      },
      waitAfter: {
        type: 'number',
        description: 'Wait for DOM settle in ms. Default: 500',
      },
      returnFormat: {
        type: 'string',
        enum: ['state_summary', 'dom_delta', 'both'],
        description: 'Response content. Default: both',
      },
    },
    required: ['tabId', 'query'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const query = args.query as string;
  const action = (args.action as string) || 'click';
  const waitAfter = Math.min(Math.max((args.waitAfter as number) || 500, 0), 10000);
  const returnFormat = (args.returnFormat as string) || 'both';

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!query) {
    return {
      content: [{ type: 'text', text: 'Error: query is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'interact');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const queryLower = query.toLowerCase();
    const queryTokens = tokenizeQuery(query);

    // Find elements matching the query using same approach as click-element.ts
    const results = await page.evaluate((searchQuery: string): Omit<FoundElement, 'score'>[] => {
      const elements: Omit<FoundElement, 'score'>[] = [];
      const domElements: Element[] = [];
      const maxResults = 30;

      function getElementInfo(el: Element): Omit<FoundElement, 'score'> | null {
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
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            width: rect.width,
            height: rect.height,
          },
        };
      }

      const searchLower = searchQuery.toLowerCase();
      const queryTokens = searchLower
        .split(/\s+/)
        .filter(t => t.length > 1)
        .filter(t => !['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or'].includes(t));

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

      // First pass: interactive elements
      for (const selector of interactiveSelectors) {
        if (elements.length >= maxResults) break;
        try {
          for (const el of document.querySelectorAll(selector)) {
            if (seen.has(el) || elements.length >= maxResults) continue;
            const info = getElementInfo(el);
            if (info) {
              const combinedText =
                `${info.name} ${info.textContent || ''} ${info.ariaLabel || ''} ${info.placeholder || ''}`.toLowerCase();
              if (queryTokens.some(token => combinedText.includes(token)) || combinedText.includes(searchLower)) {
                seen.add(el);
                (el as unknown as { __interactIndex: number }).__interactIndex = elements.length;
                domElements.push(el);
                elements.push(info);
              }
            }
          }
        } catch {
          // Invalid selector
        }
      }

      // Second pass: text content search on all elements
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node && elements.length < maxResults) {
        const el = node as Element;
        if (!seen.has(el)) {
          const info = getElementInfo(el);
          if (info) {
            const combinedText =
              `${info.name} ${info.textContent || ''} ${info.ariaLabel || ''} ${info.placeholder || ''}`.toLowerCase();
            if (combinedText.includes(searchLower) || queryTokens.some(token => combinedText.includes(token))) {
              seen.add(el);
              (el as unknown as { __interactIndex: number }).__interactIndex = elements.length;
              domElements.push(el);
              elements.push(info);
            }
          }
        }
        node = walker.nextNode();
      }

      return elements;
    }, queryLower);

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No elements found matching "${query}"` }],
        isError: true,
      };
    }

    // Get backend DOM node IDs via batched CDP approach
    const cdpClient = sessionManager.getCDPClient();

    const { result: batchResult } = await cdpClient.send<{
      result: { objectId?: string };
    }>(page, 'Runtime.evaluate', {
      expression: `(() => {
        const indexedEls = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while (node = walker.nextNode()) {
          const el = node;
          if (el.__interactIndex !== undefined) {
            indexedEls.push({ el, index: el.__interactIndex });
          }
        }
        indexedEls.sort((a, b) => a.index - b.index);
        return indexedEls.map(e => e.el);
      })()`,
      returnByValue: false,
    });

    if (batchResult.objectId) {
      const { result: properties } = await cdpClient.send<{
        result: Array<{ name: string; value: { objectId?: string } }>;
      }>(page, 'Runtime.getProperties', {
        objectId: batchResult.objectId,
        ownProperties: true,
      });

      const describePromises: Promise<void>[] = [];
      for (const prop of properties) {
        const index = parseInt(prop.name, 10);
        if (isNaN(index) || index >= results.length || !prop.value?.objectId) continue;

        describePromises.push(
          cdpClient
            .send<{ node: { backendNodeId: number } }>(page, 'DOM.describeNode', {
              objectId: prop.value.objectId,
            })
            .then(({ node }) => {
              results[index].backendDOMNodeId = node.backendNodeId;
            })
            .catch(() => {
              // Skip if we can't get the backend node ID
            })
        );
      }

      await Promise.all(describePromises);
    }

    // Score and sort
    const scoredResults: FoundElement[] = results
      .map(el => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens) }))
      .sort((a, b) => b.score - a.score);

    const bestMatch = scoredResults[0];

    if (!bestMatch || bestMatch.score < 10) {
      return {
        content: [
          {
            type: 'text',
            text: `No good match found for "${query}". Best candidate was "${bestMatch?.name || 'unknown'}" with low confidence.`,
          },
        ],
        isError: true,
      };
    }

    // Scroll into view first if needed
    if (bestMatch.backendDOMNodeId) {
      try {
        await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
          backendNodeId: bestMatch.backendDOMNodeId,
        });
        await new Promise(resolve => setTimeout(resolve, 50));

        // Re-get position after scroll
        const { result: boxResult } = await cdpClient.send<{
          result: { value: { x: number; y: number; width: number; height: number } | null };
        }>(page, 'Runtime.evaluate', {
          expression: `(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node;
            while (node = walker.nextNode()) {
              const el = node;
              if (el.__interactIndex === 0) {
                const rect = el.getBoundingClientRect();
                return { x: rect.x + rect.width/2, y: rect.y + rect.height/2, width: rect.width, height: rect.height };
              }
            }
            return null;
          })()`,
          returnByValue: true,
        });

        if (boxResult.value) {
          bestMatch.rect.x = boxResult.value.x;
          bestMatch.rect.y = boxResult.value.y;
        }
      } catch {
        // Continue with original coordinates
      }
    }

    const finalX = Math.round(bestMatch.rect.x);
    const finalY = Math.round(bestMatch.rect.y);

    // Perform the action with DOM delta capture
    const { delta } = await withDomDelta(
      page,
      async () => {
        if (action === 'double_click') {
          await page.mouse.click(finalX, finalY, { clickCount: 2 });
        } else if (action === 'hover') {
          await page.mouse.move(finalX, finalY);
        } else {
          await page.mouse.click(finalX, finalY);
        }
      },
      { settleMs: Math.max(150, waitAfter) }
    );

    // Generate ref for the interacted element
    let refId = '';
    if (bestMatch.backendDOMNodeId) {
      refId = refIdManager.generateRef(
        sessionId,
        tabId,
        bestMatch.backendDOMNodeId,
        bestMatch.role,
        bestMatch.name,
        bestMatch.tagName,
        bestMatch.textContent
      );
    }

    // Build action label
    const actionLabel = action === 'double_click' ? 'double-clicked' : action === 'hover' ? 'hovered' : 'clicked';
    const interactedLine = `Interacted: ${actionLabel} on <${bestMatch.tagName}> "${bestMatch.name.slice(0, 50)}" at (${finalX}, ${finalY})${refId ? ` [${refId}]` : ''}`;

    // Gather state summary via page.evaluate
    const stateSummary = await page.evaluate(() => {
      const url = window.location.href;
      const title = document.title;
      const scrollX = Math.round(window.scrollX);
      const scrollY = Math.round(window.scrollY);

      // Active element info
      const active = document.activeElement;
      let activeInfo = 'none';
      if (active && active !== document.body) {
        const inputEl = active as HTMLInputElement;
        const role =
          active.getAttribute('role') ||
          (active.tagName === 'BUTTON'
            ? 'button'
            : active.tagName === 'INPUT'
              ? inputEl.type || 'textbox'
              : active.tagName.toLowerCase());
        const name =
          active.getAttribute('aria-label') ||
          active.getAttribute('title') ||
          active.textContent?.trim().slice(0, 40) ||
          '';
        activeInfo = `${role}${name ? ` "${name}"` : ''}`;
      }

      // Visible panel contents (first 80 chars each, max 3)
      const panels: string[] = [];
      const panelSelectors = [
        '[role="tabpanel"]',
        '[role="dialog"]',
        '[role="main"]',
        'main',
        '.panel',
        '[class*="panel"]',
        '[class*="content"]',
      ];
      for (const sel of panelSelectors) {
        if (panels.length >= 3) break;
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            if (panels.length >= 3) break;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const text = el.textContent?.trim().slice(0, 80) || '';
            if (text.length > 10) {
              panels.push(text);
            }
          }
        } catch {
          // skip bad selectors
        }
      }

      // Visible headings
      const headings: string[] = [];
      for (const hEl of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
        const rect = hEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(hEl);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = hEl.textContent?.trim().slice(0, 60) || '';
        if (text) headings.push(text);
        if (headings.length >= 3) break;
      }

      return { url, title, scrollX, scrollY, activeInfo, panels, headings };
    });

    // Build the response
    const lines: string[] = [interactedLine];

    if (returnFormat === 'dom_delta' || returnFormat === 'both') {
      if (delta) {
        lines.push(delta);
      }
    }

    if (returnFormat === 'state_summary' || returnFormat === 'both') {
      lines.push(
        `[State Summary] url: ${stateSummary.url} | scroll: ${stateSummary.scrollX},${stateSummary.scrollY} | active: ${stateSummary.activeInfo}`
      );

      if (stateSummary.headings.length > 0) {
        lines.push(`[Headings] ${stateSummary.headings.map(h => `"${h}"`).join(' | ')}`);
      }

      if (stateSummary.panels.length > 0) {
        const panelParts = stateSummary.panels.map((p, i) => `Panel ${i + 1}: "${p}"`);
        lines.push(`[Visible] ${panelParts.join(' | ')}`);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Interact error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerInteractTool(server: MCPServer): void {
  server.registerTool('interact', handler, definition);
}
