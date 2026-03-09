/**
 * Click Element Tool - Composite tool that finds and clicks an element in one operation
 *
 * This reduces the typical find → get coordinates → click pattern into a single tool call.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { DEFAULT_DOM_SETTLE_DELAY_MS, DEFAULT_SCREENSHOT_QUALITY, DEFAULT_SCREENSHOT_RACE_TIMEOUT_MS, DEFAULT_SCREENSHOT_TIMEOUT_MS, DEFAULT_VIEWPORT } from '../config/defaults';
import { withDomDelta } from '../utils/dom-delta';
import { generateVisualSummary } from '../utils/visual-summary';
import { AdaptiveScreenshot } from '../utils/adaptive-screenshot';
import { FoundElement, scoreElement, tokenizeQuery } from '../utils/element-finder';
import { discoverElements, getTaggedElementRect, cleanupTags, DISCOVERY_TAG } from '../utils/element-discovery';

const definition: MCPToolDefinition = {
  name: 'click_element',
  description: 'Find and click an element by natural language query in one call.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      query: {
        type: 'string',
        description: 'Element to click, e.g. "Login button"',
      },
      wait_after: {
        type: 'number',
        description: 'Wait after click in ms. Default: 100, max: 5000',
      },
      verify: {
        type: 'boolean',
        description: 'Return screenshot after click for verification',
      },
      double_click: {
        type: 'boolean',
        description: 'Perform double-click instead of single',
      },
      waitForMs: {
        type: 'number',
        description: 'Max time to wait for element to appear. 0 = no waiting (default). Max 30000.',
      },
      pollInterval: {
        type: 'number',
        description: 'How often to retry while waiting, in ms. Default 200, range 50-2000.',
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
  const waitAfter = Math.min(Math.max((args.wait_after as number) || 100, 0), 5000);
  const verify = args.verify as boolean | undefined;
  const doubleClick = args.double_click as boolean | undefined;
  const waitForMs = args.waitForMs as number | undefined;
  const pollInterval = Math.min(Math.max((args.pollInterval as number) || 200, 50), 2000);

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
    const queryTokens = tokenizeQuery(query);

    // Optional polling for dynamic/lazy content
    const maxWait = waitForMs ? Math.min(Math.max(waitForMs, 100), 30000) : 0;
    let bestMatch: (FoundElement & { _origIdx: number }) | null = null;
    const startTime = Date.now();
    const cdpClient = sessionManager.getCDPClient();

    do { // --- polling loop start ---
    // Find elements matching the query
    let rawResults: Omit<FoundElement, 'score'>[];
    try {
      rawResults = await discoverElements(page, cdpClient, queryLower, {
        maxResults: 30,
        useCenter: true,
        timeout: 10000,
        toolName: 'click_element',
      });
    } catch {
      // CDP evaluate timed out — retry on next poll iteration if budget remains
      if (maxWait > 0 && Date.now() - startTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      rawResults = [];
    }

    if (rawResults.length === 0) {
      if (maxWait > 0 && Date.now() - startTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      const pageUrl = page.url();
      return {
        content: [
          {
            type: 'text',
            text: `No clickable elements found matching "${query}" on ${pageUrl}`,
          },
        ],
        isError: true,
      };
    }

    // Score and sort elements, tracking original discovery index for re-positioning
    const scoredResults: (FoundElement & { _origIdx: number })[] = rawResults
      .map((el, i) => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens), _origIdx: i }))
      .sort((a, b) => b.score - a.score);

    if (scoredResults.length > 0 && scoredResults[0].score >= 10) {
      bestMatch = scoredResults[0];
      break;
    }

    if (maxWait > 0 && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } else {
      // No polling or timeout reached — use best available even if low score
      if (scoredResults.length > 0) {
        bestMatch = scoredResults[0];
      }
      break;
    }
    } while (Date.now() - startTime < maxWait); // --- polling loop end ---

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
        await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

        // Re-get position after scroll using the shared getTaggedElementRect helper
        const newRect = await getTaggedElementRect(page, cdpClient, DISCOVERY_TAG, bestMatch._origIdx, true);
        if (newRect) {
          bestMatch.rect.x = newRect.x;
          bestMatch.rect.y = newRect.y;
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

    // Clean up discovery tags to prevent stale properties
    await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

    // Reset adaptive screenshot on click (page state changes)
    AdaptiveScreenshot.getInstance().reset(tabId);

    const clickType = doubleClick ? 'Double-clicked' : 'Clicked';
    const confidenceNote = bestMatch.score < 50 ? ` (low confidence: ${bestMatch.score}/100)` : '';
    const summary = await generateVisualSummary(page);
    const summaryText = summary ? `\n${summary}` : '';
    const resultText = `${clickType} ${bestMatch.role} "${bestMatch.name.slice(0, 50)}" at (${finalX}, ${finalY})${refId ? ` [${refId}]` : ''}${confidenceNote}${delta}${summaryText}`;

    // Optional verification screenshot — WebP via CDP for speed and consistency
    if (verify) {
      try {
        const screenshotResult = await Promise.race([
          (async () => {
            const cdpSession = await (page as any).target().createCDPSession();
            try {
              const { data } = await cdpSession.send('Page.captureScreenshot', {
                format: 'webp',
                quality: DEFAULT_SCREENSHOT_QUALITY,
                optimizeForSpeed: true,
              });
              return data as string;
            } finally {
              await cdpSession.detach().catch(() => {});
            }
          })(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), DEFAULT_SCREENSHOT_RACE_TIMEOUT_MS)),
        ]);

        if (screenshotResult !== null) {
          return {
            content: [
              { type: 'text', text: resultText },
              { type: 'image', data: screenshotResult, mimeType: 'image/webp' },
            ],
          };
        }
        // Timeout — fall through to fallback
        throw new Error('Screenshot timed out');
      } catch {
        // Fall back to Puppeteer PNG with timeout to prevent hangs on dialog-blocked pages
        let fallbackTimer: NodeJS.Timeout;
        const screenshot = await Promise.race([
          page.screenshot({
            encoding: 'base64',
            type: 'png',
            fullPage: false,
            clip: {
              x: 0,
              y: 0,
              width: Math.min(page.viewport()?.width || DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.width),
              height: Math.min(page.viewport()?.height || DEFAULT_VIEWPORT.height, DEFAULT_VIEWPORT.height),
            },
          }).finally(() => clearTimeout(fallbackTimer)),
          new Promise<never>((_, reject) => {
            fallbackTimer = setTimeout(() => reject(new Error('Fallback screenshot timed out')), DEFAULT_SCREENSHOT_TIMEOUT_MS);
          }),
        ]);

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
