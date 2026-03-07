/**
 * Lightweight Scroll Tool - JavaScript-based scrolling without screenshots
 *
 * Eliminates the CDP screenshot serialization bottleneck that caused
 * 185-second timeouts under high concurrency (20+ tabs).
 *
 * Performance impact: Scroll from 185s (timeout) to <5ms per call
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import { retryWithFallback } from '../utils/retry-with-fallback';

const definition: MCPToolDefinition = {
  name: 'lightweight_scroll',
  description: 'Scroll page via JS without screenshot. Returns new scroll position.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to scroll',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction',
      },
      amount: {
        type: 'number',
        description: 'Scroll amount in pixels. Default: 300',
      },
      smooth: {
        type: 'boolean',
        description: 'Smooth scrolling animation. Default: false',
      },
      selector: {
        type: 'string',
        description: 'Element to scroll (CSS selector). Default: window',
      },
      scrollToEnd: {
        type: 'boolean',
        description: 'Scroll to end in given direction. Default: false',
      },
      waitAfterMs: {
        type: 'number',
        description: 'Wait after scroll for lazy content in ms. Default: 0',
      },
    },
    required: ['tabId', 'direction'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const direction = args.direction as string;
  const amount = (args.amount as number) || 300;
  const smooth = (args.smooth as boolean) || false;
  const selector = args.selector as string | undefined;
  const scrollToEnd = (args.scrollToEnd as boolean) || false;
  const waitAfterMs = (args.waitAfterMs as number) || 0;

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!direction || !['up', 'down', 'left', 'right'].includes(direction)) {
    return {
      content: [{ type: 'text', text: 'Error: direction must be one of: up, down, left, right' }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'lightweight_scroll');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    type ScrollResult = {
      success: boolean;
      scrollX: number;
      scrollY: number;
      scrollHeight: number;
      scrollWidth: number;
      clientHeight: number;
      clientWidth: number;
      atEnd: boolean;
      error?: string;
    };

    // Primary: page.evaluate scroll (JS-based, fast path)
    const primaryScroll = (): Promise<ScrollResult> => withTimeout(page.evaluate(
      (params: {
        direction: string;
        amount: number;
        smooth: boolean;
        selector: string | null;
        scrollToEnd: boolean;
        waitAfterMs: number;
      }): Promise<ScrollResult> => {
        return new Promise((resolve) => {
          try {
            const target = params.selector
              ? document.querySelector(params.selector)
              : null;

            if (params.selector && !target) {
              resolve({
                success: false,
                scrollX: 0,
                scrollY: 0,
                scrollHeight: 0,
                scrollWidth: 0,
                clientHeight: 0,
                clientWidth: 0,
                atEnd: false,
                error: `Selector "${params.selector}" not found`,
              });
              return;
            }

            const scrollTarget = target || document.documentElement;
            const behavior = params.smooth ? 'smooth' : 'instant';

            if (params.scrollToEnd) {
              // Scroll to the very end
              switch (params.direction) {
                case 'down':
                  (target || window).scrollTo({
                    top: scrollTarget.scrollHeight,
                    behavior,
                  });
                  break;
                case 'up':
                  (target || window).scrollTo({ top: 0, behavior });
                  break;
                case 'right':
                  (target || window).scrollTo({
                    left: scrollTarget.scrollWidth,
                    behavior,
                  });
                  break;
                case 'left':
                  (target || window).scrollTo({ left: 0, behavior });
                  break;
              }
            } else {
              // Scroll by amount
              let deltaX = 0;
              let deltaY = 0;
              switch (params.direction) {
                case 'down':
                  deltaY = params.amount;
                  break;
                case 'up':
                  deltaY = -params.amount;
                  break;
                case 'right':
                  deltaX = params.amount;
                  break;
                case 'left':
                  deltaX = -params.amount;
                  break;
              }
              (target || window).scrollBy({ left: deltaX, top: deltaY, behavior });
            }

            // Dispatch scroll event to trigger lazy loaders / infinite scroll handlers
            const eventTarget = target || document;
            eventTarget.dispatchEvent(new Event('scroll', { bubbles: true }));

            const finalize = () => {
              const el = target || document.documentElement;
              const sx = target ? el.scrollLeft : window.scrollX;
              const sy = target ? el.scrollTop : window.scrollY;
              const sh = el.scrollHeight;
              const sw = el.scrollWidth;
              const ch = el.clientHeight;
              const cw = el.clientWidth;

              // Check if at the end in the scroll direction
              let atEnd = false;
              switch (params.direction) {
                case 'down':
                  atEnd = sy + ch >= sh - 1;
                  break;
                case 'up':
                  atEnd = sy <= 0;
                  break;
                case 'right':
                  atEnd = sx + cw >= sw - 1;
                  break;
                case 'left':
                  atEnd = sx <= 0;
                  break;
              }

              resolve({
                success: true,
                scrollX: Math.round(sx),
                scrollY: Math.round(sy),
                scrollHeight: sh,
                scrollWidth: sw,
                clientHeight: ch,
                clientWidth: cw,
                atEnd,
              });
            };

            if (params.waitAfterMs > 0) {
              setTimeout(finalize, params.waitAfterMs);
            } else {
              // Small delay for scroll to settle
              requestAnimationFrame(() => finalize());
            }
          } catch (e) {
            resolve({
              success: false,
              scrollX: 0,
              scrollY: 0,
              scrollHeight: 0,
              scrollWidth: 0,
              clientHeight: 0,
              clientWidth: 0,
              atEnd: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        });
      },
      {
        direction,
        amount,
        smooth,
        selector: selector || null,
        scrollToEnd,
        waitAfterMs,
      }
    ), 10000, 'lightweight_scroll');

    // Fallback: Input.dispatchMouseEvent mouseWheel via CDP
    const fallbackScroll = async (): Promise<ScrollResult> => {
      const cdpClient = sessionManager.getCDPClient();
      const viewport = page.viewport();
      const x = viewport ? viewport.width / 2 : 512;
      const y = viewport ? viewport.height / 2 : 384;

      let deltaX = 0;
      let deltaY = 0;
      switch (direction) {
        case 'down': deltaY = amount; break;
        case 'up': deltaY = -amount; break;
        case 'right': deltaX = amount; break;
        case 'left': deltaX = -amount; break;
      }

      await withTimeout(
        cdpClient.send(page, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x, y,
          deltaX, deltaY,
        }),
        5000,
        'scroll-fallback'
      );

      // Do NOT call page.evaluate here — it has the same failure mode as primary.
      // Return success with position unknown indicator.
      return {
        success: true,
        scrollX: -1,
        scrollY: -1,
        scrollHeight: 0,
        scrollWidth: 0,
        clientHeight: 0,
        clientWidth: 0,
        atEnd: false,
      };
    };

    const { result: scrollResult, recovered, method: recoveryMethod } = await retryWithFallback(
      primaryScroll,
      [fallbackScroll],
      { label: 'lightweight_scroll', retryDelayMs: 500 }
    );

    if (!scrollResult.success) {
      return {
        content: [{ type: 'text', text: `Scroll error: ${scrollResult.error}` }],
        isError: true,
      };
    }

    const targetDesc = selector ? ` (${selector})` : '';
    const endIndicator = scrollResult.atEnd ? ' [END REACHED]' : '';
    const recoveryNote = recovered ? ` [recovered:${recoveryMethod}]` : '';
    const positionUnknown = scrollResult.scrollX === -1 && scrollResult.scrollY === -1;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            scrolled: `${direction} ${scrollToEnd ? 'to end' : amount + 'px'}${targetDesc}${endIndicator}${recoveryNote}`,
            position: positionUnknown
              ? { unknown: true, note: 'Position unavailable after fallback scroll. Use read_page to check current state.' }
              : { x: scrollResult.scrollX, y: scrollResult.scrollY },
            dimensions: positionUnknown
              ? undefined
              : {
                  scrollHeight: scrollResult.scrollHeight,
                  scrollWidth: scrollResult.scrollWidth,
                  clientHeight: scrollResult.clientHeight,
                  clientWidth: scrollResult.clientWidth,
                },
            atEnd: scrollResult.atEnd,
          }),
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMsg.includes('timed out');
    return {
      content: [
        {
          type: 'text',
          text: isTimeout
            ? `Scroll may not have completed — page appears busy or unresponsive. Use read_page to verify current scroll position.`
            : `Lightweight scroll error: ${errorMsg}`,
        },
      ],
      isError: !isTimeout,
    };
  }
};

export function registerLightweightScrollTool(server: MCPServer): void {
  server.registerTool('lightweight_scroll', handler, definition);
}
