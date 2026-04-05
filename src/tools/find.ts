/**
 * Find Tool - Find elements by natural language query
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { withTimeout } from '../utils/with-timeout';
import { discoverElements, cleanupTags, DISCOVERY_TAG } from '../utils/element-discovery';
import { FoundElement, normalizeQuery, scoreElement, tokenizeQuery } from '../utils/element-finder';
import { resolveElementsByAXTree, MATCH_LEVEL_LABELS } from '../utils/ax-element-resolver';
import { getCircuitBreaker } from '../utils/ralph/circuit-breaker';
import { analyzeScreenshot, formatElementMapAsText } from '../vision/screenshot-analyzer';
import { getVisionMode } from '../vision/config';

const definition: MCPToolDefinition = {
  name: 'find',
  description: 'Find elements by query. Returns up to 20 matches with refs.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to search in',
      },
      query: {
        type: 'string',
        description: 'What to find (natural language)',
      },
      waitForMs: {
        type: 'number',
        description: 'Poll timeout in ms. Default: 3000. 0 to disable',
      },
      pollInterval: {
        type: 'number',
        description: 'Poll interval in ms. Default: 200',
      },
      vision_fallback: {
        type: 'boolean',
        description: 'Use vision-based screenshot analysis if DOM discovery finds nothing. Default: follows OPENCHROME_VISION_MODE env.',
      },
    },
    required: ['query', 'tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const query = args.query as string;
  const waitForMs = args.waitForMs as number | undefined;
  const pollInterval = Math.min(Math.max((args.pollInterval as number) || 200, 50), 2000);
  const visionFallback = args.vision_fallback as boolean | undefined;
  const visionMode = getVisionMode();

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
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'find');
    if (!page) {
      const available = await sessionManager.getAvailableTargets(sessionId);
      const availableInfo = available.length > 0
        ? `\nAvailable tabs:\n${available.map(t => `  - tabId: ${t.tabId} | ${t.url} | ${t.title}`).join('\n')}`
        : '\nNo tabs available. Call navigate without tabId to create a new tab.';
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.${availableInfo}` }],
        isError: true,
      };
    }

    const queryNorm = normalizeQuery(query);
    const queryLower = queryNorm;

    // Optional polling for dynamic/lazy content (default 3000ms; pass 0 to disable)
    const maxWait = Math.min(Math.max(waitForMs ?? 3000, 0), 30000);
    const startTime = Date.now();
    let output: string[] = [];

    const cdpClient = sessionManager.getCDPClient();

    // ─── AX-First Resolution ───
    try {
      const axMatches = await resolveElementsByAXTree(page, cdpClient, query, {
        useCenter: false,
        maxResults: 20,
      });

      if (axMatches.length > 0) {
        const axOutput: string[] = [];
        for (const el of axMatches) {
          const refId = refIdManager.generateRef(
            sessionId, tabId, el.backendDOMNodeId,
            el.role, el.name, undefined, undefined
          );
          const scoreLabel = el.matchLevel === 1 ? '\u2605\u2605\u2605' : el.matchLevel === 2 ? '\u2605\u2605' : '\u2605';
          axOutput.push(
            `[${refId}] ${el.role}: "${el.name}" at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)}) ${scoreLabel} [AX]`
          );
        }

        await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

        return {
          content: [{
            type: 'text' as const,
            text: `Found ${axOutput.length} elements matching "${query}" [via AX tree]:\n\n${axOutput.join('\n')}`,
          }],
        };
      }
    } catch {
      // AX non-fatal — fall through to CSS
    }

    // Budget check before expensive CSS discovery
    if (context && !hasBudget(context, 15_000)) {
      return {
        content: [{ type: 'text', text: `find: deadline approaching — skipped CSS fallback for "${query}"` }],
        isError: true,
      };
    }
    // ─── CSS Fallback ───
    const cb = getCircuitBreaker();
    do { // --- polling loop start ---
    let scored: FoundElement[];
    try {
      const results = await discoverElements(page, cdpClient, queryLower, {
        maxResults: 30,
        useCenter: false,
        timeout: 10000,
        toolName: 'find',
        circuitBreaker: {
          check: (_pageUrl: string) => !cb.check(tabId, queryLower).allowed,
          recordFailure: (_pageUrl: string) => cb.recordElementFailure(tabId, queryLower),
          recordSuccess: (_pageUrl: string) => cb.recordElementSuccess(tabId, queryLower),
        },
      });

      const queryTokens = tokenizeQuery(query);
      scored = results
        .map(el => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens) }))
        .filter(el => el.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
    } catch {
      // CDP evaluate timed out — retry if budget remains
      if (maxWait > 0 && Date.now() - startTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      scored = [];
    }

    // Generate refs for found elements (already sorted by score)
    output = [];
    for (const el of scored) {
      if (el.backendDOMNodeId) {
        const refId = refIdManager.generateRef(
          sessionId,
          tabId,
          el.backendDOMNodeId,
          el.role,
          el.name,
          el.tagName,
          el.textContent
        );

        // Include score in output for transparency
        const scoreLabel = el.score >= 100 ? '★★★' : el.score >= 50 ? '★★' : el.score >= 20 ? '★' : '';
        output.push(
          `[${refId}] ${el.role}: "${el.name}" at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)}) ${scoreLabel}`.trim()
        );
      }
    }

    if (output.length > 0) {
      break;
    }

    if (maxWait > 0 && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } else {
      break;
    }
    } while (Date.now() - startTime < maxWait); // --- polling loop end ---

    // Clean up discovery tags to prevent stale properties
    await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

    if (output.length === 0) {
      // ─── Vision Fallback ───
      const shouldUseVision = visionMode !== 'off' &&
        (visionFallback === true || visionMode === 'fallback' || visionMode === 'auto');
      if (shouldUseVision && context && hasBudget(context, 10_000)) {
        try {
          console.error(`[find] DOM discovery found nothing for "${query}" — trying vision fallback`);
          const visionResult = await analyzeScreenshot(page, {
            interactiveOnly: true,
            showBoundingBoxes: true,
          });

          if (visionResult.elementCount > 0) {
            const textMap = formatElementMapAsText(visionResult.elementMap);
            console.error(`[find] Vision fallback found ${visionResult.elementCount} elements for "${query}"`);
            return {
              content: [
                {
                  type: 'text',
                  text: `DOM found nothing for "${query}" — vision fallback found ${visionResult.elementCount} elements:\n\n${textMap}`,
                },
                {
                  type: 'image',
                  data: visionResult.screenshot,
                  mimeType: visionResult.mimeType,
                },
              ],
            };
          }
        } catch (visionError) {
          console.error(`[find] Vision fallback failed: ${visionError instanceof Error ? visionError.message : String(visionError)}`);
        }
      }

      let url = 'unknown', readyState = 'unknown', totalElements = 0;
      try {
        ({ url, readyState, totalElements } = await withTimeout(page.evaluate(() => ({
          url: document.location.href,
          readyState: document.readyState,
          totalElements: document.querySelectorAll('*').length,
        })), 5000, 'find', context));
      } catch {
        // Page may have navigated — use defaults
      }
      return {
        content: [
          {
            type: 'text',
            text: `No elements found matching "${query}". Page: ${url} (${readyState}), ${totalElements} elements.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Found ${output.length} elements matching "${query}":\n\n${output.join('\n')}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Find error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerFindTool(server: MCPServer): void {
  server.registerTool('find', handler, definition);
}
