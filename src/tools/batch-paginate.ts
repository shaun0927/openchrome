/**
 * Batch Paginate Tool - Capture multiple pages from a paginated viewer in a single MCP call
 *
 * Eliminates N LLM round-trips by executing the pagination loop server-side.
 * Supports keyboard navigation, click-based pagination, URL-based parallel extraction,
 * and infinite scroll.
 */

import { KeyInput } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { DEFAULT_SCREENSHOT_QUALITY, MAX_OUTPUT_CHARS } from '../config/defaults';

const definition: MCPToolDefinition = {
  name: 'batch_paginate',
  description:
    'Extract content from multiple pages of a paginated viewer (PDF, slides, articles) in a single call. ' +
    'Supports keyboard navigation, click-based pagination, URL-based parallel extraction, and infinite scroll.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID of the paginated viewer',
      },
      strategy: {
        type: 'string',
        enum: ['keyboard', 'click', 'url', 'scroll'],
        description:
          'Pagination strategy: "keyboard" (ArrowRight/ArrowDown), "click" (CSS selector), "url" (parallel multi-tab), "scroll" (infinite scroll)',
      },
      totalPages: {
        type: 'number',
        description: 'Total number of pages to capture. Required for keyboard/click strategies.',
      },
      startPage: {
        type: 'number',
        description:
          'Starting page number (default: 1). Useful when resuming from a specific page.',
      },
      captureMode: {
        type: 'string',
        enum: ['screenshot', 'text', 'dom', 'both'],
        description:
          'What to capture per page: "screenshot" (base64 image), "text" (accessibility text), "dom" (compact DOM), "both" (screenshot + text). Default: "text".',
      },
      keyAction: {
        type: 'string',
        description: '(keyboard strategy) Key to press for next page. Default: "ArrowRight".',
      },
      nextSelector: {
        type: 'string',
        description: '(click strategy) CSS selector for the "next page" button.',
      },
      urlTemplate: {
        type: 'string',
        description:
          '(url strategy) URL template with {N}, {page}, or {offset} placeholder for page number, e.g. "https://example.com/page/{N}".',
      },
      waitBetweenPages: {
        type: 'number',
        description:
          'Milliseconds to wait between page transitions for rendering. Default: 500.',
      },
      scrollAmount: {
        type: 'number',
        description: '(scroll strategy) Viewport heights to scroll per step. Default: 1.',
      },
      maxScrolls: {
        type: 'number',
        description: '(scroll strategy) Maximum number of scroll steps. Default: 50.',
      },
    },
    required: ['tabId', 'strategy'],
  },
};

interface PageResult {
  pageNumber: number;
  text?: string;
  screenshot?: string; // base64
  dom?: string;
  error?: string;
}

/**
 * Simple concurrency limiter
 */
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) {
        const next = queue.shift()!;
        next();
      }
    }
  };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const strategy = args.strategy as string;
  const totalPages = args.totalPages as number | undefined;
  const startPage = (args.startPage as number) || 1;
  const captureMode = (args.captureMode as string) || 'text';
  const keyAction = (args.keyAction as string) || 'ArrowRight';
  const nextSelector = args.nextSelector as string | undefined;
  const urlTemplate = args.urlTemplate as string | undefined;
  const waitBetweenPages = (args.waitBetweenPages as number) ?? 500;
  const scrollAmount = (args.scrollAmount as number) || 1;
  const maxScrolls = (args.maxScrolls as number) || 50;

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!strategy) {
    return {
      content: [{ type: 'text', text: 'Error: strategy is required' }],
      isError: true,
    };
  }

  // Validate strategy-specific params
  if ((strategy === 'keyboard' || strategy === 'click') && !totalPages) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: totalPages is required for strategy "${strategy}"`,
        },
      ],
      isError: true,
    };
  }

  if (strategy === 'click' && !nextSelector) {
    return {
      content: [{ type: 'text', text: 'Error: nextSelector is required for strategy "click"' }],
      isError: true,
    };
  }

  if (strategy === 'url' && !urlTemplate) {
    return {
      content: [{ type: 'text', text: 'Error: urlTemplate is required for strategy "url"' }],
      isError: true,
    };
  }

  if (strategy === 'url' && !totalPages) {
    return {
      content: [{ type: 'text', text: 'Error: totalPages is required for strategy "url"' }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();
  const startTime = Date.now();
  const pages: PageResult[] = [];

  /**
   * Capture content from the current page state
   */
  async function capturePageContent(
    page: import('puppeteer-core').Page,
    pageNumber: number
  ): Promise<PageResult> {
    const result: PageResult = { pageNumber };

    try {
      if (captureMode === 'screenshot' || captureMode === 'both') {
        try {
          const cdpSession = await (page as any).target().createCDPSession();
          try {
            const { data } = await cdpSession.send('Page.captureScreenshot', {
              format: 'webp',
              quality: DEFAULT_SCREENSHOT_QUALITY,
              optimizeForSpeed: true,
            });
            result.screenshot = data;
          } finally {
            await cdpSession.detach().catch(() => {});
          }
        } catch {
          // Fallback to Puppeteer PNG
          const screenshotData = await page.screenshot({ encoding: 'base64', type: 'png' });
          result.screenshot = screenshotData as string;
        }
      }

      if (captureMode === 'text' || captureMode === 'both') {
        result.text = await page.evaluate(() => document.body.innerText);
      }

      if (captureMode === 'dom') {
        const rawHtml = await page.evaluate(() => document.body.innerHTML);
        // Trim to avoid huge payloads
        result.dom = rawHtml.length > MAX_OUTPUT_CHARS ? rawHtml.slice(0, MAX_OUTPUT_CHARS) + '...[truncated]' : rawHtml;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  try {
    // ----------------------------------------------------------------
    // KEYBOARD STRATEGY
    // ----------------------------------------------------------------
    if (strategy === 'keyboard') {
      const page = await sessionManager.getPage(sessionId, tabId, undefined, 'batch_paginate');
      if (!page) {
        return {
          content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
          isError: true,
        };
      }

      let failureCount = 0;

      for (let i = startPage; i <= totalPages!; i++) {
        const pageResult = await capturePageContent(page, i);
        pages.push(pageResult);

        if (pageResult.error) {
          failureCount++;
          if (failureCount >= (totalPages! - startPage + 1) * 0.5) {
            // More than 50% failing, abort early
            break;
          }
        }

        // Navigate to next page (don't press on last page)
        if (i < totalPages!) {
          await page.keyboard.press(keyAction as KeyInput);
          await new Promise((r) => setTimeout(r, waitBetweenPages));
        }
      }
    }

    // ----------------------------------------------------------------
    // CLICK STRATEGY
    // ----------------------------------------------------------------
    else if (strategy === 'click') {
      const page = await sessionManager.getPage(sessionId, tabId, undefined, 'batch_paginate');
      if (!page) {
        return {
          content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
          isError: true,
        };
      }

      let failureCount = 0;

      for (let i = startPage; i <= totalPages!; i++) {
        const pageResult = await capturePageContent(page, i);
        pages.push(pageResult);

        if (pageResult.error) {
          failureCount++;
          if (failureCount >= (totalPages! - startPage + 1) * 0.5) {
            break;
          }
        }

        // Click next button (don't click on last page)
        if (i < totalPages!) {
          try {
            const nextButton = await page.$(nextSelector!);
            if (!nextButton) {
              pages.push({
                pageNumber: i + 1,
                error: `Next button selector "${nextSelector}" not found on page ${i}`,
              });
              break;
            }
            await nextButton.click();
            await new Promise((r) => setTimeout(r, waitBetweenPages));
          } catch (err) {
            pages.push({
              pageNumber: i + 1,
              error: `Failed to click next button: ${err instanceof Error ? err.message : String(err)}`,
            });
            break;
          }
        }
      }
    }

    // ----------------------------------------------------------------
    // SCROLL STRATEGY (infinite scroll)
    // ----------------------------------------------------------------
    else if (strategy === 'scroll') {
      const page = await sessionManager.getPage(sessionId, tabId, undefined, 'batch_paginate');
      if (!page) {
        return {
          content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
          isError: true,
        };
      }

      let lastScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      let stepNumber = 1;

      // Capture initial view
      const initialResult = await capturePageContent(page, stepNumber);
      pages.push(initialResult);

      for (let step = 1; step <= maxScrolls; step++) {
        // Scroll and measure in a single CDP round-trip
        const { newScrollHeight, atBottom } = await page.evaluate((amount: number) => {
          window.scrollBy(0, window.innerHeight * amount);
          const scrollHeight = document.documentElement.scrollHeight;
          const scrollTop = window.scrollY;
          const viewportHeight = window.innerHeight;
          return {
            newScrollHeight: scrollHeight,
            atBottom: scrollTop + viewportHeight >= scrollHeight - 10,
          };
        }, scrollAmount);

        await new Promise((r) => setTimeout(r, waitBetweenPages));

        stepNumber++;
        const stepResult = await capturePageContent(page, stepNumber);
        pages.push(stepResult);

        // Stop if reached bottom and height didn't change
        if (atBottom && newScrollHeight === lastScrollHeight) {
          break;
        }

        lastScrollHeight = newScrollHeight;
      }
    }

    // ----------------------------------------------------------------
    // URL STRATEGY (parallel multi-tab)
    // ----------------------------------------------------------------
    else if (strategy === 'url') {
      const limiter = createLimiter(5); // max 5 parallel tabs
      const pageNumbers = Array.from(
        { length: totalPages! - startPage + 1 },
        (_, i) => startPage + i
      );

      const urlResults = await Promise.all(
        pageNumbers.map((pageNum) =>
          limiter(async (): Promise<PageResult> => {
            const url = urlTemplate!.replace(/\{N\}|\{page\}|\{offset\}/g, String(pageNum));
            let newTabId: string | null = null;

            try {
              // Create a new tab for this page
              const { targetId, page: newPage } = await sessionManager.createTarget(
                sessionId,
                url
              );
              newTabId = targetId;

              // Wait for page to settle
              await new Promise((r) => setTimeout(r, waitBetweenPages));

              const result = await capturePageContent(newPage, pageNum);

              // Close the tab
              await sessionManager.closeTarget(sessionId, targetId);

              return result;
            } catch (err) {
              // Attempt cleanup if tab was created
              if (newTabId) {
                try {
                  await sessionManager.closeTarget(sessionId, newTabId);
                } catch {
                  // ignore cleanup errors
                }
              }
              return {
                pageNumber: pageNum,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          })
        )
      );

      // Sort by page number (parallel execution may deliver out-of-order)
      urlResults.sort((a, b) => a.pageNumber - b.pageNumber);
      pages.push(...urlResults);
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Unknown strategy "${strategy}". Must be one of: keyboard, click, url, scroll`,
          },
        ],
        isError: true,
      };
    }

    const durationMs = Date.now() - startTime;
    const capturedCount = pages.filter((p) => !p.error).length;
    const failedCount = pages.filter((p) => p.error).length;
    const estimatedSequentialMs = capturedCount * 5000; // rough 5s per round-trip estimate
    const savedMs = Math.max(0, estimatedSequentialMs - durationMs);

    // Build summary text
    const summaryText =
      capturedCount > 0
        ? `Captured ${capturedCount} pages in ${(durationMs / 1000).toFixed(1)}s` +
          (savedMs > 1000
            ? ` (vs ~${(estimatedSequentialMs / 1000).toFixed(0)}s sequential — saved ~${(savedMs / 1000).toFixed(0)}s)`
            : '')
        : `No pages captured`;

    // For large screenshot sets, omit the actual data and note it's available
    const tooManyScreenshots =
      (captureMode === 'screenshot' || captureMode === 'both') && capturedCount > 10;

    const pagesForOutput: PageResult[] = tooManyScreenshots
      ? pages.map((p) => ({
          ...p,
          screenshot: p.screenshot ? '[screenshot omitted — >10 pages]' : undefined,
        }))
      : pages;

    const output = {
      totalCaptured: capturedCount,
      totalFailed: failedCount,
      strategy,
      captureMode,
      durationMs,
      summary: summaryText,
      pages: pagesForOutput,
    };

    const content: import('../types/mcp').MCPContent[] = [
      { type: 'text', text: JSON.stringify(output, null, 2) },
    ];

    // Include screenshots inline only when count is manageable
    if ((captureMode === 'screenshot' || captureMode === 'both') && !tooManyScreenshots) {
      for (const p of pages) {
        if (p.screenshot) {
          content.push({
            type: 'image',
            data: p.screenshot,
            mimeType: 'image/webp',
          });
        }
      }
    }

    return { content };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `batch_paginate error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerBatchPaginateTool(server: MCPServer): void {
  server.registerTool('batch_paginate', handler, definition);
}
