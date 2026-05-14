/**
 * Wait For Tool - Wait for various conditions
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { safeTitle } from '../utils/safe-title';
import { getMetricsCollector } from '../metrics/collector';

const definition: MCPToolDefinition = {
  name: 'wait_for',
  description: "Wait for a condition. Strongly prefer 'function', 'selector', or 'url_match' — they return as soon as the condition is true (1 round-trip). Use 'timeout' only as a last resort: it blocks for a fixed duration and returns no information, forcing you to poll with another tool afterwards.",
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to wait on',
      },
      type: {
        type: 'string',
        enum: ['selector', 'selector_hidden', 'function', 'navigation', 'url_match', 'timeout'],
        description: "Condition. PREFER: 'selector' (element appears), 'selector_hidden', 'function' (custom JS predicate, e.g. value=\"document.querySelectorAll('.error').length>0\"), 'url_match', 'navigation'. AVOID 'timeout' — it just sleeps.",
      },
      value: {
        type: 'string',
        description: 'Selector, JS function, URL pattern, or ms',
      },
      timeout: {
        type: 'number',
        description: 'Max wait in ms. Default: 30000',
      },
      visible: {
        type: 'boolean',
        description: 'Require visibility (selector). Default: false',
      },
      pollIntervalMs: {
        type: 'number',
        description: 'Function mode only: predicate polling interval in ms for main-frame evaluation. Default 200, min 50, max 5000.',
      },
    },
    required: ['tabId', 'type'],
  },
  annotations: TOOL_ANNOTATIONS.wait_for,
};

function clampPollInterval(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 200;
  return Math.min(5000, Math.max(50, n));
}

function classifyFunctionWaitError(error: unknown): 'timeout' | 'navigation_lost' | 'predicate_error' {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timeout') || message.includes('Timeout') || message.includes('timed out') || /waiting failed:.*exceeded/i.test(message)) {
    return 'timeout';
  }
  if (/navigation|execution context.*destroyed|frame.*detached|target.*closed|session closed/i.test(message)) {
    return 'navigation_lost';
  }
  return 'predicate_error';
}

function recordFunctionWaitMetric(result: 'matched' | 'timeout' | 'predicate_error' | 'navigation_lost', elapsedMs: number): void {
  try {
    const metrics = getMetricsCollector();
    metrics.inc('openchrome_wait_predicate_total', { result });
    metrics.observe('openchrome_wait_predicate_elapsed_ms', { result }, elapsedMs);
  } catch {
    // Best-effort telemetry only.
  }
}

function buildFunctionWaitFact(
  result: 'matched' | 'timeout' | 'predicate_error' | 'navigation_lost',
  elapsedMs: number,
  pollIntervalMs: number,
  error?: unknown,
): MCPResult {
  const err = error instanceof Error
    ? { name: error.name || 'Error', message: error.message }
    : error === undefined
      ? undefined
      : { name: 'Error', message: String(error) };
  const payload = {
    action: 'wait_for',
    type: 'function',
    matched: result === 'matched',
    result,
    elapsedMs,
    pollIntervalMs,
    ...(err ? { error: err } : {}),
    message: result === 'matched'
      ? `Function returned truthy after ${elapsedMs}ms`
      : `Function wait completed as ${result} after ${elapsedMs}ms`,
  };
  recordFunctionWaitMetric(result, elapsedMs);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const type = args.type as string;
  const value = args.value as string | undefined;
  const timeout = (args.timeout as number) ?? 30000;
  const visible = (args.visible as boolean) ?? false;
  const pollIntervalMs = clampPollInterval(args.pollIntervalMs);

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!type) {
    return {
      content: [{ type: 'text', text: 'Error: type is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'wait_for');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const startTime = Date.now();

    switch (type) {
      case 'selector': {
        if (!value) {
          return {
            content: [{ type: 'text', text: 'Error: value (CSS selector) is required for selector type' }],
            isError: true,
          };
        }

        await page.waitForSelector(value, {
          timeout,
          visible,
        });

        const elapsed = Date.now() - startTime;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'selector',
                selector: value,
                visible,
                elapsed,
                message: `Element "${value}" found after ${elapsed}ms`,
              }),
            },
          ],
        };
      }

      case 'selector_hidden': {
        if (!value) {
          return {
            content: [{ type: 'text', text: 'Error: value (CSS selector) is required for selector_hidden type' }],
            isError: true,
          };
        }

        await page.waitForSelector(value, {
          timeout,
          hidden: true,
        });

        const elapsed = Date.now() - startTime;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'selector_hidden',
                selector: value,
                elapsed,
                message: `Element "${value}" hidden/removed after ${elapsed}ms`,
              }),
            },
          ],
        };
      }

      case 'function': {
        if (!value) {
          return {
            content: [{ type: 'text', text: 'Error: value (JavaScript function) is required for function type' }],
            isError: true,
          };
        }

        try {
          await page.waitForFunction(value, { timeout, polling: pollIntervalMs });
          const elapsed = Date.now() - startTime;
          return buildFunctionWaitFact('matched', elapsed, pollIntervalMs);
        } catch (error) {
          const elapsed = Date.now() - startTime;
          const result = classifyFunctionWaitError(error);
          return buildFunctionWaitFact(result, elapsed, pollIntervalMs, error);
        }
      }

      case 'url_match': {
        if (!value) {
          return {
            content: [{ type: 'text', text: 'Error: value (URL pattern) is required for url_match type' }],
            isError: true,
          };
        }

        // Use waitForFunction to poll the URL - works even if navigation already completed
        await page.waitForFunction(
          (pattern: string) => {
            try {
              const regex = new RegExp(pattern);
              return regex.test(window.location.href);
            } catch {
              // If not a valid regex, do substring match
              return window.location.href.includes(pattern);
            }
          },
          { timeout },
          value
        );

        const elapsed = Date.now() - startTime;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'url_match',
                pattern: value,
                url: page.url(),
                title: await safeTitle(page),
                elapsed,
                message: `URL matched pattern "${value}" after ${elapsed}ms`,
              }),
            },
          ],
        };
      }

      case 'navigation': {
        await page.waitForNavigation({
          timeout,
          waitUntil: 'domcontentloaded',
        });

        const elapsed = Date.now() - startTime;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'navigation',
                url: page.url(),
                title: await safeTitle(page),
                elapsed,
                message: `Navigation completed after ${elapsed}ms`,
              }),
            },
          ],
        };
      }

      case 'timeout': {
        const delay = value ? parseInt(value, 10) : 1000;

        if (isNaN(delay) || delay < 0) {
          return {
            content: [{ type: 'text', text: 'Error: value must be a valid positive number for timeout type' }],
            isError: true,
          };
        }

        if (delay > 60000) {
          return {
            content: [{ type: 'text', text: 'Error: timeout value cannot exceed 60000ms (1 minute)' }],
            isError: true,
          };
        }

        await new Promise(resolve => setTimeout(resolve, delay));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'wait_for',
                type: 'timeout',
                delay,
                message: `Waited ${delay}ms`,
              }),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown type "${type}". Use: selector, selector_hidden, function, navigation, url_match, or timeout`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Detect timeout errors including Puppeteer's "Waiting failed: Xms exceeded" format
    const isTimeout =
      errorMessage.includes('timeout') ||
      errorMessage.includes('Timeout') ||
      errorMessage.includes('timed out') ||
      /waiting failed:.*exceeded/i.test(errorMessage);

    if (isTimeout) {
      // Navigation timeout may leave useful partial state (DOM partially loaded).
      // All wait_for timeouts are isError:true (condition not met), but navigation
      // includes a recoverable hint so the LLM can try read_page for partial content.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'wait_for',
              type,
              error: 'timeout',
              message: `Wait timed out after ${timeout}ms`,
              ...(type === 'navigation' && {
                recoverable: true,
                hint: 'Navigation timeout — the page may be partially loaded. Try read_page to check available content.',
              }),
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Wait error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerWaitForTool(server: MCPServer): void {
  server.registerTool('wait_for', handler, definition);
}
