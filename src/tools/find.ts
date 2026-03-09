/**
 * Find Tool - Find elements by natural language query
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { withTimeout } from '../utils/with-timeout';
import { discoverElements, cleanupTags, DISCOVERY_TAG } from '../utils/element-discovery';
import { FoundElement, scoreElement, tokenizeQuery } from '../utils/element-finder';

const definition: MCPToolDefinition = {
  name: 'find',
  description: 'Find elements by natural language query. Returns up to 20 matches with refs.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to search in',
      },
      query: {
        type: 'string',
        description: 'What to find, e.g. "search bar", "login button"',
      },
      waitForMs: {
        type: 'number',
        description: 'Polling timeout in ms for dynamic/SPA content (default: 3000). Set to 0 to disable polling.',
      },
      pollInterval: {
        type: 'number',
        description: 'How often to retry while waiting, in ms. Default 200, range 50-2000.',
      },
    },
    required: ['query', 'tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const query = args.query as string;
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
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'find');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const queryLower = query.toLowerCase();

    // Optional polling for dynamic/lazy content (default 3000ms; pass 0 to disable)
    const maxWait = Math.min(Math.max(waitForMs ?? 3000, 0), 30000);
    const startTime = Date.now();
    let output: string[] = [];

    const cdpClient = sessionManager.getCDPClient();

    do { // --- polling loop start ---
    let scored: FoundElement[];
    try {
      const results = await discoverElements(page, cdpClient, queryLower, {
        maxResults: 30,
        useCenter: false,
        timeout: 10000,
        toolName: 'find',
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
      let url = 'unknown', readyState = 'unknown', totalElements = 0;
      try {
        ({ url, readyState, totalElements } = await withTimeout(page.evaluate(() => ({
          url: document.location.href,
          readyState: document.readyState,
          totalElements: document.querySelectorAll('*').length,
        })), 5000, 'find'));
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
