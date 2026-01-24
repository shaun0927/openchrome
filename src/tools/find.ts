/**
 * Find Tool - Find elements by natural language query
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';

const definition: MCPToolDefinition = {
  name: 'find',
  description:
    'Find elements on the page using natural language. Returns up to 20 matching elements with references.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to search in',
      },
      query: {
        type: 'string',
        description: 'Natural language description of what to find (e.g., "search bar", "login button")',
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
    const page = await sessionManager.getPage(sessionId, tabId);
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Use page.evaluate to search for elements
    const queryLower = query.toLowerCase();

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
    }

    const results = await page.evaluate((searchQuery: string): FoundElement[] => {
      const elements: FoundElement[] = [];
      const maxResults = 20;

      // Helper to get element info
      function getElementInfo(el: Element): FoundElement | null {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;

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
          backendDOMNodeId: 0, // Will be filled later via CDP
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
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      }

      // Search by common patterns
      const searchLower = searchQuery.toLowerCase();

      // Strategy 1: Search by role/type keywords
      const roleSelectors: string[] = [];
      if (searchLower.includes('button')) {
        roleSelectors.push('button', '[role="button"]', 'input[type="submit"]');
      }
      if (searchLower.includes('link')) {
        roleSelectors.push('a', '[role="link"]');
      }
      if (
        searchLower.includes('search') ||
        searchLower.includes('input') ||
        searchLower.includes('text')
      ) {
        roleSelectors.push(
          'input[type="text"]',
          'input[type="search"]',
          'input:not([type])',
          'textarea',
          '[role="textbox"]',
          '[role="searchbox"]'
        );
      }
      if (searchLower.includes('checkbox')) {
        roleSelectors.push('input[type="checkbox"]', '[role="checkbox"]');
      }
      if (searchLower.includes('radio')) {
        roleSelectors.push('input[type="radio"]', '[role="radio"]');
      }
      if (searchLower.includes('select') || searchLower.includes('dropdown')) {
        roleSelectors.push('select', '[role="combobox"]', '[role="listbox"]');
      }
      if (searchLower.includes('image') || searchLower.includes('img')) {
        roleSelectors.push('img', '[role="img"]');
      }

      // Strategy 2: Search by text content
      const textMatches: Element[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node && textMatches.length < maxResults) {
        const el = node as Element;
        const inputEl = el as HTMLInputElement;
        const text = el.textContent?.toLowerCase() || '';
        const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
        const placeholder = inputEl.placeholder?.toLowerCase() || '';
        const title = el.getAttribute('title')?.toLowerCase() || '';

        if (
          text.includes(searchLower) ||
          ariaLabel.includes(searchLower) ||
          placeholder.includes(searchLower) ||
          title.includes(searchLower)
        ) {
          const info = getElementInfo(el);
          if (info) textMatches.push(el);
        }
        node = walker.nextNode();
      }

      // Combine results
      const seen = new Set<Element>();

      // First add role-matched elements
      for (const selector of roleSelectors) {
        if (elements.length >= maxResults) break;
        try {
          const matched = document.querySelectorAll(selector);
          for (const el of matched) {
            if (seen.has(el)) continue;
            if (elements.length >= maxResults) break;
            const info = getElementInfo(el);
            if (info) {
              seen.add(el);
              // Store element for later CDP resolution
              (el as unknown as { __findIndex: number }).__findIndex = elements.length;
              elements.push(info);
            }
          }
        } catch {
          // Invalid selector
        }
      }

      // Then add text matches
      for (const el of textMatches) {
        if (elements.length >= maxResults) break;
        if (seen.has(el)) continue;
        const info = getElementInfo(el);
        if (info) {
          seen.add(el);
          (el as unknown as { __findIndex: number }).__findIndex = elements.length;
          elements.push(info);
        }
      }

      return elements;
    }, queryLower);

    // Get backend DOM node IDs for the found elements
    const cdpClient = sessionManager.getCDPClient();

    for (let i = 0; i < results.length; i++) {
      try {
        // Get DOM node via runtime evaluation
        const { result } = await cdpClient.send<{
          result: { objectId?: string };
        }>(page, 'Runtime.evaluate', {
          expression: `document.querySelectorAll('*').find(el => el.__findIndex === ${i})`,
          returnByValue: false,
        });

        if (result.objectId) {
          const { node } = await cdpClient.send<{
            node: { backendNodeId: number };
          }>(page, 'DOM.describeNode', {
            objectId: result.objectId,
          });
          results[i].backendDOMNodeId = node.backendNodeId;
        }
      } catch {
        // Skip if we can't get the backend node ID
      }
    }

    // Generate refs for found elements
    const output: string[] = [];
    for (const el of results) {
      if (el.backendDOMNodeId) {
        const refId = refIdManager.generateRef(
          sessionId,
          tabId,
          el.backendDOMNodeId,
          el.role,
          el.name
        );

        output.push(
          `[${refId}] ${el.role}: "${el.name}" at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)})`
        );
      }
    }

    if (output.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No elements found matching "${query}"`,
          },
        ],
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
