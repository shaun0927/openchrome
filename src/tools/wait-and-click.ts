/**
 * Wait and Click Tool - Waits for an element to appear and then clicks it
 *
 * Useful for dynamic content that loads after page interaction.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { withDomDelta } from '../utils/dom-delta';

const definition: MCPToolDefinition = {
  name: 'wait_and_click',
  description: 'Wait for an element to appear, then click it. For dynamic/lazy content.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      query: {
        type: 'string',
        description: 'Element to wait for and click (natural language)',
      },
      timeout: {
        type: 'number',
        description: 'Max wait in ms. Default: 5000, max: 30000',
      },
      poll_interval: {
        type: 'number',
        description: 'Poll interval in ms. Default: 200',
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
  textContent?: string;
  rect: { x: number; y: number; width: number; height: number };
  score: number;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const query = args.query as string;
  const timeout = Math.min(Math.max((args.timeout as number) || 5000, 100), 30000);
  const pollInterval = Math.min(Math.max((args.poll_interval as number) || 200, 50), 2000);

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
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'wait_and_click');
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

    const startTime = Date.now();
    let bestMatch: FoundElement | null = null;

    // Poll for the element
    while (Date.now() - startTime < timeout) {
      const result = await page.evaluate((searchQuery: string, tokens: string[]): FoundElement | null => {
        function scoreElement(el: Element, rect: DOMRect): number {
          let score = 0;
          const inputEl = el as HTMLInputElement;
          const text = el.textContent?.toLowerCase() || '';
          const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
          const name = ariaLabel || el.getAttribute('title')?.toLowerCase() || text.slice(0, 100);
          const role = el.getAttribute('role') ||
            (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' : el.tagName.toLowerCase());

          const searchLower = searchQuery.toLowerCase();

          // Exact match
          if (name === searchLower || text.trim() === searchLower) score += 100;

          // Contains full query
          if (name.includes(searchLower) || text.includes(searchLower)) score += 50;
          if (ariaLabel.includes(searchLower)) score += 45;

          // Token matching
          const combinedText = `${name} ${text} ${ariaLabel}`;
          for (const token of tokens) {
            if (combinedText.includes(token)) score += 15;
          }

          // Role matching
          if (searchLower.includes('button') && (role === 'button' || el.tagName === 'BUTTON')) score += 30;
          if (searchLower.includes('link') && (role === 'link' || el.tagName === 'A')) score += 30;

          // Interactive bonus
          if (['button', 'link', 'menuitem', 'tab'].includes(role)) score += 20;

          // Size bonus
          if (rect.width > 50 && rect.height > 20) score += 10;

          return score;
        }

        const selectors = [
          'button',
          '[role="button"]',
          'a',
          '[role="link"]',
          'input[type="submit"]',
          'input[type="button"]',
          '[role="menuitem"]',
          '[role="tab"]',
          '[onclick]',
        ];

        let best: { el: Element; rect: DOMRect; score: number } | null = null;

        // First pass: interactive elements
        for (const selector of selectors) {
          try {
            for (const el of document.querySelectorAll(selector)) {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;

              const style = window.getComputedStyle(el);
              if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

              const score = scoreElement(el, rect);
              if (score > 20 && (!best || score > best.score)) {
                best = { el, rect, score };
              }
            }
          } catch {
            // Skip invalid selector
          }
        }

        // Second pass: any element with matching text
        if (!best || best.score < 50) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          let node = walker.nextNode();
          while (node) {
            const el = node as Element;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const style = window.getComputedStyle(el);
              if (style.visibility !== 'hidden' && style.display !== 'none') {
                const score = scoreElement(el, rect);
                if (score > 40 && (!best || score > best.score)) {
                  best = { el, rect, score };
                }
              }
            }
            node = walker.nextNode();
          }
        }

        if (!best || best.score < 20) return null;

        // Tag the element for CDP reference
        (best.el as unknown as { __waitClickTarget: boolean }).__waitClickTarget = true;

        const inputEl = best.el as HTMLInputElement;
        return {
          backendDOMNodeId: 0,
          role: best.el.getAttribute('role') ||
            (best.el.tagName === 'BUTTON' ? 'button' : best.el.tagName === 'A' ? 'link' : best.el.tagName.toLowerCase()),
          name: best.el.getAttribute('aria-label') ||
            best.el.getAttribute('title') ||
            best.el.textContent?.trim().slice(0, 100) || '',
          tagName: best.el.tagName.toLowerCase(),
          textContent: best.el.textContent?.trim().slice(0, 50),
          rect: {
            x: best.rect.x + best.rect.width / 2,
            y: best.rect.y + best.rect.height / 2,
            width: best.rect.width,
            height: best.rect.height,
          },
          score: best.score,
        };
      }, queryLower, queryTokens);

      if (result && result.score >= 20) {
        // Get backend DOM node ID
        const cdpClient = sessionManager.getCDPClient();
        try {
          const { result: objResult } = await cdpClient.send<{
            result: { objectId?: string };
          }>(page, 'Runtime.evaluate', {
            expression: `document.querySelectorAll('*').find(el => el.__waitClickTarget === true)`,
            returnByValue: false,
          });

          if (objResult.objectId) {
            const { node } = await cdpClient.send<{
              node: { backendNodeId: number };
            }>(page, 'DOM.describeNode', {
              objectId: objResult.objectId,
            });
            result.backendDOMNodeId = node.backendNodeId;
          }
        } catch {
          // Continue without backend node ID
        }

        bestMatch = result;
        break;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    if (!bestMatch) {
      return {
        content: [
          {
            type: 'text',
            text: `Timeout: No element matching "${query}" appeared within ${timeout}ms`,
          },
        ],
        isError: true,
      };
    }

    const waitTime = Date.now() - startTime;

    // Scroll into view if needed
    const cdpClient = sessionManager.getCDPClient();
    if (bestMatch.backendDOMNodeId) {
      try {
        await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
          backendNodeId: bestMatch.backendDOMNodeId,
        });
        await new Promise(resolve => setTimeout(resolve, 50));

        // Re-get position after scroll
        const { result: posResult } = await cdpClient.send<{
          result: { value: { x: number; y: number } | null };
        }>(page, 'Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelectorAll('*').find(el => el.__waitClickTarget === true);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
          })()`,
          returnByValue: true,
        });

        if (posResult.value) {
          bestMatch.rect.x = posResult.value.x;
          bestMatch.rect.y = posResult.value.y;
        }
      } catch {
        // Continue with original coordinates
      }
    }

    // Click the element with DOM delta capture
    const clickX = Math.round(bestMatch.rect.x);
    const clickY = Math.round(bestMatch.rect.y);
    const { delta } = await withDomDelta(page, () => page.mouse.click(clickX, clickY));

    // Clean up marker
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('*')).find((e: Element) => (e as unknown as { __waitClickTarget: boolean }).__waitClickTarget);
      if (el) delete (el as unknown as { __waitClickTarget?: boolean }).__waitClickTarget;
    });

    // Generate ref
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

    return {
      content: [
        {
          type: 'text',
          text: `Waited ${waitTime}ms, then clicked ${bestMatch.role} "${bestMatch.name.slice(0, 50)}" at (${clickX}, ${clickY})${refId ? ` [${refId}]` : ''}${delta}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Wait and click error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerWaitAndClickTool(server: MCPServer): void {
  server.registerTool('wait_and_click', handler, definition);
}
