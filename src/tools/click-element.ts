/**
 * Click Element Tool - Composite tool that finds and clicks an element in one operation
 *
 * This reduces the typical find → get coordinates → click pattern into a single tool call.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { DEFAULT_SCREENSHOT_QUALITY, DEFAULT_VIEWPORT } from '../config/defaults';
import { withDomDelta } from '../utils/dom-delta';

const definition: MCPToolDefinition = {
  name: 'click_element',
  description: 'Find an element by natural language query and click it in one operation. Returns the clicked element info and optionally a verification screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      query: {
        type: 'string',
        description: 'Natural language description of the element to click (e.g., "Login button", "Save Changes")',
      },
      wait_after: {
        type: 'number',
        description: 'Milliseconds to wait after clicking (default: 100, max: 5000)',
      },
      verify: {
        type: 'boolean',
        description: 'If true, returns a screenshot after clicking to verify the action',
      },
      double_click: {
        type: 'boolean',
        description: 'If true, performs a double-click instead of single click',
      },
    },
    required: ['tabId', 'query'],
  },
};

interface FoundElement {
  backendDOMNodeId: number;
  role: string;
  name: string;
  tagName: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  textContent?: string;
  rect: { x: number; y: number; width: number; height: number };
  score: number;
}

/**
 * Score an element based on how well it matches the query
 */
function scoreElement(element: FoundElement, queryLower: string, queryTokens: string[]): number {
  let score = 0;
  const nameLower = element.name.toLowerCase();
  const textLower = element.textContent?.toLowerCase() || '';
  const ariaLower = element.ariaLabel?.toLowerCase() || '';
  const placeholderLower = element.placeholder?.toLowerCase() || '';

  // Exact match bonus (highest priority)
  if (nameLower === queryLower || textLower === queryLower) {
    score += 100;
  }

  // Aria label exact match
  if (ariaLower === queryLower) {
    score += 90;
  }

  // Contains full query
  if (nameLower.includes(queryLower) || textLower.includes(queryLower)) {
    score += 50;
  }
  if (ariaLower.includes(queryLower)) {
    score += 45;
  }

  // Token matching (partial match for multi-word queries)
  const combinedText = `${nameLower} ${textLower} ${ariaLower} ${placeholderLower}`;
  const matchedTokens = queryTokens.filter(token => combinedText.includes(token));
  score += matchedTokens.length * 15;

  // Role matching bonus - if query mentions role
  if (queryLower.includes('button') && (element.role === 'button' || element.tagName === 'button')) {
    score += 30;
  }
  if (queryLower.includes('link') && (element.role === 'link' || element.tagName === 'a')) {
    score += 30;
  }
  if (queryLower.includes('radio') && (element.role === 'radio' || element.type === 'radio')) {
    score += 30;
  }
  if (queryLower.includes('checkbox') && (element.role === 'checkbox' || element.type === 'checkbox')) {
    score += 30;
  }
  if (queryLower.includes('input') && (element.tagName === 'input' || element.tagName === 'textarea')) {
    score += 30;
  }
  if (queryLower.includes('switch') && (element.role === 'switch')) {
    score += 30;
  }
  if (queryLower.includes('toggle') && (element.role === 'switch')) {
    score += 30;
  }
  if (queryLower.includes('dropdown') && (element.role === 'combobox' || element.role === 'listbox')) {
    score += 30;
  }
  if (queryLower.includes('select') && (element.role === 'combobox' || element.role === 'listbox')) {
    score += 30;
  }
  if (queryLower.includes('slider') && (element.role === 'slider')) {
    score += 30;
  }

  // Interactive element bonus
  if (['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'switch', 'combobox', 'listbox', 'slider', 'treeitem'].includes(element.role)) {
    score += 20;
  }

  // Visible size bonus (larger elements are usually more important)
  if (element.rect.width > 50 && element.rect.height > 20) {
    score += 10;
  }

  // Penalty for very small elements (likely icons or hidden)
  if (element.rect.width < 10 || element.rect.height < 10) {
    score -= 20;
  }

  return score;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const query = args.query as string;
  const waitAfter = Math.min(Math.max((args.wait_after as number) || 100, 0), 5000);
  const verify = args.verify as boolean | undefined;
  const doubleClick = args.double_click as boolean | undefined;

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
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'click_element');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const queryLower = query.toLowerCase();
    const queryTokens = queryLower
      .split(/\s+/)
      .filter(t => t.length > 1)
      .filter(t => !['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or'].includes(t));

    // Find elements matching the query
    const results = await page.evaluate((searchQuery: string): Omit<FoundElement, 'score'>[] => {
      const elements: Omit<FoundElement, 'score'>[] = [];
      const domElements: Element[] = []; // Parallel array of DOM references for batched node ID resolution
      const maxResults = 30; // Get more candidates for better scoring

      function getElementInfo(el: Element): Omit<FoundElement, 'score'> | null {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;

        // Skip invisible elements
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return null;
        }

        const inputEl = el as HTMLInputElement;
        const role =
          el.getAttribute('role') ||
          (el.tagName === 'BUTTON'
            ? 'button'
            : el.tagName === 'A'
              ? 'link'
              : el.tagName === 'INPUT'
                ? inputEl.type || 'textbox'
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
            x: rect.x + rect.width / 2, // Center point
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

      // Search for interactive elements
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
              const combinedText = `${info.name} ${info.textContent || ''} ${info.ariaLabel || ''} ${info.placeholder || ''}`.toLowerCase();
              // Check if any token matches
              if (queryTokens.some(token => combinedText.includes(token)) || combinedText.includes(searchLower)) {
                seen.add(el);
                (el as unknown as { __clickIndex: number }).__clickIndex = elements.length;
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
            const combinedText = `${info.name} ${info.textContent || ''} ${info.ariaLabel || ''} ${info.placeholder || ''}`.toLowerCase();
            if (combinedText.includes(searchLower) || queryTokens.some(token => combinedText.includes(token))) {
              seen.add(el);
              (el as unknown as { __clickIndex: number }).__clickIndex = elements.length;
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
        content: [
          {
            type: 'text',
            text: `No clickable elements found matching "${query}"`,
          },
        ],
        isError: true,
      };
    }

    // Get backend DOM node IDs — batched approach (single DOM walk + parallel DOM.describeNode)
    // Replaces per-candidate querySelectorAll('*').find() which is O(n) × candidates = O(30n)
    const cdpClient = sessionManager.getCDPClient();

    // Step 1: Single Runtime.evaluate to collect all tagged elements in index order
    const { result: batchResult } = await cdpClient.send<{
      result: { objectId?: string };
    }>(page, 'Runtime.evaluate', {
      expression: `(() => {
        const indexedEls = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while (node = walker.nextNode()) {
          const el = node;
          if (el.__clickIndex !== undefined) {
            indexedEls.push({ el, index: el.__clickIndex });
          }
        }
        indexedEls.sort((a, b) => a.index - b.index);
        return indexedEls.map(e => e.el);
      })()`,
      returnByValue: false,
    });

    if (batchResult.objectId) {
      // Step 2: Get array properties to obtain individual element object references
      const { result: properties } = await cdpClient.send<{
        result: Array<{ name: string; value: { objectId?: string } }>;
      }>(page, 'Runtime.getProperties', {
        objectId: batchResult.objectId,
        ownProperties: true,
      });

      // Step 3: Parallel DOM.describeNode for all candidates
      const describePromises: Promise<void>[] = [];
      for (const prop of properties) {
        const index = parseInt(prop.name, 10);
        if (isNaN(index) || index >= results.length || !prop.value?.objectId) continue;

        describePromises.push(
          cdpClient.send<{ node: { backendNodeId: number } }>(
            page,
            'DOM.describeNode',
            { objectId: prop.value.objectId }
          ).then(({ node }) => {
            results[index].backendDOMNodeId = node.backendNodeId;
          }).catch(() => {
            // Skip if we can't get the backend node ID
          })
        );
      }

      await Promise.all(describePromises);
    }

    // Score and sort elements
    const scoredResults: FoundElement[] = results
      .map(el => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens) }))
      .sort((a, b) => b.score - a.score);

    // Get the best match
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

    // Click the element at its center coordinates
    const clickX = Math.round(bestMatch.rect.x);
    const clickY = Math.round(bestMatch.rect.y);

    // Scroll into view first if needed
    if (bestMatch.backendDOMNodeId) {
      try {
        await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
          backendNodeId: bestMatch.backendDOMNodeId,
        });
        // Small delay after scroll
        await new Promise(resolve => setTimeout(resolve, 50));

        // Re-get position after scroll — use __clickIndex=0 on sorted best match
        // (best match was index 0 before sorting; use backendDOMNodeId instead to be precise)
        const { result: boxResult } = await cdpClient.send<{
          result: { value: { x: number; y: number; width: number; height: number } | null };
        }>(page, 'Runtime.evaluate', {
          expression: `(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node;
            while (node = walker.nextNode()) {
              const el = node;
              if (el.__clickIndex === 0) {
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

    // Perform the click with DOM delta capture (settleMs includes waitAfter)
    const { delta } = await withDomDelta(page, async () => {
      if (doubleClick) {
        await page.mouse.click(finalX, finalY, { clickCount: 2 });
      } else {
        await page.mouse.click(finalX, finalY);
      }
    }, { settleMs: Math.max(150, waitAfter) });

    // Generate ref for the clicked element
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

    const clickType = doubleClick ? 'Double-clicked' : 'Clicked';
    const resultText = `${clickType} ${bestMatch.role} "${bestMatch.name.slice(0, 50)}" at (${finalX}, ${finalY})${refId ? ` [${refId}]` : ''}${delta}`;

    // Optional verification screenshot — WebP via CDP for speed and consistency
    if (verify) {
      try {
        const cdpSession = await (page as any).target().createCDPSession();
        const { data } = await cdpSession.send('Page.captureScreenshot', {
          format: 'webp',
          quality: DEFAULT_SCREENSHOT_QUALITY,
          optimizeForSpeed: true,
        });
        await cdpSession.detach();

        return {
          content: [
            { type: 'text', text: resultText },
            { type: 'image', data, mimeType: 'image/webp' },
          ],
        };
      } catch {
        // Fall back to Puppeteer PNG if CDP session creation fails
        const screenshot = await page.screenshot({
          encoding: 'base64',
          type: 'png',
          fullPage: false,
          clip: {
            x: 0,
            y: 0,
            width: Math.min(page.viewport()?.width || DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.width),
            height: Math.min(page.viewport()?.height || DEFAULT_VIEWPORT.height, DEFAULT_VIEWPORT.height),
          },
        });

        return {
          content: [
            { type: 'text', text: resultText },
            { type: 'image', data: screenshot, mimeType: 'image/png' },
          ],
        };
      }
    }

    return {
      content: [{ type: 'text', text: resultText }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Click element error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerClickElementTool(server: MCPServer): void {
  server.registerTool('click_element', handler, definition);
}
