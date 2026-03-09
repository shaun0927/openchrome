/**
 * Wait and Click Tool - Waits for an element to appear and then clicks it
 *
 * Useful for dynamic content that loads after page interaction.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { DEFAULT_DOM_SETTLE_DELAY_MS } from '../config/defaults';
import { withDomDelta } from '../utils/dom-delta';
import { discoverElements, getTaggedElementRect, cleanupTags, DISCOVERY_TAG } from '../utils/element-discovery';
import { FoundElement, scoreElement, tokenizeQuery } from '../utils/element-finder';

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
    const queryTokens = tokenizeQuery(query);

    const startTime = Date.now();
    let bestMatch: (FoundElement & { _origIdx: number }) | null = null;

    const cdpClient = sessionManager.getCDPClient();

    // Poll for the element
    while (Date.now() - startTime < timeout) {
      try {
        const results = await discoverElements(page, cdpClient, queryLower, {
          maxResults: 30,
          useCenter: true,
          timeout: 10000,
          toolName: 'wait_and_click',
        });

        // Score and find best match
        const scored = results
          .map((el, i) => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens), _origIdx: i }))
          .sort((a, b) => b.score - a.score);

        if (scored.length > 0 && scored[0].score >= 20) {
          bestMatch = scored[0] as FoundElement & { _origIdx: number };
          break;
        }
      } catch {
        // CDP evaluate timed out (e.g. dialog blocked) — retry on next poll iteration
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
    if (bestMatch.backendDOMNodeId) {
      try {
        await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
          backendNodeId: bestMatch.backendDOMNodeId,
        });
        await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

        // Re-get position after scroll
        const newRect = await getTaggedElementRect(page, cdpClient, DISCOVERY_TAG, bestMatch._origIdx, true);
        if (newRect) {
          bestMatch.rect.x = newRect.x;
          bestMatch.rect.y = newRect.y;
        }
      } catch {
        // Continue with original coordinates
      }
    }

    // Click the element with DOM delta capture
    const clickX = Math.round(bestMatch.rect.x);
    const clickY = Math.round(bestMatch.rect.y);
    const { delta } = await withDomDelta(page, () => page.mouse.click(clickX, clickY));

    // Clean up discovery tags
    await cleanupTags(page, DISCOVERY_TAG);

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

    const textSample = bestMatch.textContent?.slice(0, 50) || bestMatch.name.slice(0, 50);
    const textPart = textSample ? ` "${textSample}"` : '';
    const refPart = refId ? ` [${refId}]` : '';
    return {
      content: [
        {
          type: 'text',
          text: `\u2713 Waited ${waitTime}ms, clicked ${bestMatch.tagName}${textPart}${refPart}${delta}`,
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
