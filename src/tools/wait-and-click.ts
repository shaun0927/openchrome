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
import { resolveElementsByAXTree, invalidateAXCache, AXResolvedElement } from '../utils/ax-element-resolver';
import { getTargetId } from '../utils/puppeteer-helpers';

const definition: MCPToolDefinition = {
  name: 'wait_and_click',
  description: 'Wait for element to appear, then click it.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      query: {
        type: 'string',
        description: 'Element to find and click (natural language)',
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

    // Poll for the element (AX-first, CSS fallback)
    let axMatch: AXResolvedElement | null = null;
    while (Date.now() - startTime < timeout) {
      // Try AX tree first
      try {
        const axMatches = await resolveElementsByAXTree(page, cdpClient, query, {
          useCenter: true, maxResults: 1,
        });
        if (axMatches.length > 0 && axMatches[0].axScore >= 60) {
          axMatch = axMatches[0];
          break;
        }
      } catch { /* AX non-fatal */ }

      // CSS fallback
      try {
        const results = await discoverElements(page, cdpClient, queryLower, {
          maxResults: 30,
          useCenter: true,
          timeout: 10000,
          toolName: 'wait_and_click',
        });

        const scored = results
          .map((el, i) => ({ ...el, score: scoreElement(el as FoundElement, queryLower, queryTokens), _origIdx: i }))
          .sort((a, b) => b.score - a.score);

        if (scored.length > 0 && scored[0].score >= 20) {
          bestMatch = scored[0] as FoundElement & { _origIdx: number };
          break;
        }
      } catch {
        // CDP evaluate timed out — retry on next poll iteration
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // ─── AX Match Path ───
    if (axMatch) {
      const waitTime = Date.now() - startTime;
      try {
        await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: axMatch.backendDOMNodeId });
        await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));
        const { model } = await cdpClient.send<{ model: { content: number[] } }>(
          page, 'DOM.getBoxModel', { backendNodeId: axMatch.backendDOMNodeId }
        );
        if (model?.content && model.content.length >= 8) {
          const bx = model.content[0], by = model.content[1];
          const bw = model.content[2] - bx, bh = model.content[5] - by;
          if (bw > 0 && bh > 0) axMatch.rect = { x: bx + bw / 2, y: by + bh / 2, width: bw, height: bh };
        }
      } catch { /* use original coords */ }

      const axX = Math.round(axMatch.rect.x), axY = Math.round(axMatch.rect.y);
      const { delta: axDelta } = await withDomDelta(page, () => page.mouse.click(axX, axY));

      invalidateAXCache(getTargetId(page.target()));
      await cleanupTags(page, DISCOVERY_TAG).catch(() => {});

      const axRef = refIdManager.generateRef(sessionId, tabId, axMatch.backendDOMNodeId, axMatch.role, axMatch.name, undefined, undefined);

      return {
        content: [{
          type: 'text' as const,
          text: `\u2713 Clicked ${axMatch.role} "${axMatch.name}" [${axRef}] [via AX tree, score: ${axMatch.axScore}/100] (waited ${waitTime}ms)${axDelta}`,
        }],
      };
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
