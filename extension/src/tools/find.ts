/**
 * Find tool for MCP - Find elements on the page using natural language
 */

import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { SessionManager } from '../session-manager';

interface FoundElement {
  ref: string;
  role: string;
  name?: string;
  description?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export function createFindTool(sessionManager: SessionManager) {
  return {
    handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
      const tabId = params.tabId as number;
      const query = params.query as string;

      if (!sessionId) {
        return {
          content: [{ type: 'text', text: 'Error: sessionId is required' }],
          isError: true,
        };
      }

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

      // Validate tab ownership
      if (!sessionManager.validateTabOwnership(sessionId, tabId)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Tab ${tabId} does not belong to session ${sessionId}`,
            },
          ],
          isError: true,
        };
      }

      try {
        // Parse the query to determine what to look for
        const queryLower = query.toLowerCase();

        // Use JavaScript to search the DOM
        const result = await sessionManager.executeCDP<{ result: { value: FoundElement[] } }>(
          sessionId,
          tabId,
          'Runtime.evaluate',
          {
            expression: `
              (() => {
                const query = ${JSON.stringify(queryLower)};
                const results = [];
                let refCounter = 1;

                // Define element types to search based on query
                const elementTypes = [];

                if (query.includes('button') || query.includes('btn')) {
                  elementTypes.push('button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]');
                }
                if (query.includes('link')) {
                  elementTypes.push('a[href]');
                }
                if (query.includes('input') || query.includes('text') || query.includes('field') || query.includes('box')) {
                  elementTypes.push('input[type="text"]', 'input:not([type])', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'textarea');
                }
                if (query.includes('search')) {
                  elementTypes.push('input[type="search"]', '[role="search"]', 'input[name*="search"]', 'input[placeholder*="search" i]');
                }
                if (query.includes('checkbox')) {
                  elementTypes.push('input[type="checkbox"]');
                }
                if (query.includes('radio')) {
                  elementTypes.push('input[type="radio"]');
                }
                if (query.includes('select') || query.includes('dropdown')) {
                  elementTypes.push('select', '[role="combobox"]', '[role="listbox"]');
                }
                if (query.includes('image') || query.includes('img')) {
                  elementTypes.push('img', '[role="img"]');
                }

                // If no specific type matched, search all interactive elements
                if (elementTypes.length === 0) {
                  elementTypes.push(
                    'button', '[role="button"]',
                    'a[href]',
                    'input', 'textarea', 'select',
                    '[onclick]', '[role="link"]', '[role="tab"]',
                    '[role="menuitem"]', '[role="option"]'
                  );
                }

                // Query for elements
                const selector = elementTypes.join(', ');
                const elements = document.querySelectorAll(selector);

                for (const element of elements) {
                  // Get element text content for matching
                  const text = (
                    element.textContent ||
                    element.getAttribute('aria-label') ||
                    element.getAttribute('title') ||
                    element.getAttribute('placeholder') ||
                    element.getAttribute('alt') ||
                    element.getAttribute('value') ||
                    ''
                  ).toLowerCase();

                  const name = element.getAttribute('name')?.toLowerCase() || '';
                  const id = element.id?.toLowerCase() || '';
                  const className = element.className?.toLowerCase() || '';

                  // Extract search terms from query (remove common words)
                  const searchTerms = query
                    .replace(/button|link|input|field|box|search|bar|text/g, '')
                    .trim()
                    .split(/\\s+/)
                    .filter(t => t.length > 1);

                  // Check if element matches
                  let matches = searchTerms.length === 0; // If no specific terms, include all

                  for (const term of searchTerms) {
                    if (
                      text.includes(term) ||
                      name.includes(term) ||
                      id.includes(term) ||
                      className.includes(term)
                    ) {
                      matches = true;
                      break;
                    }
                  }

                  if (matches && results.length < 20) {
                    const rect = element.getBoundingClientRect();
                    const role = element.getAttribute('role') || element.tagName.toLowerCase();
                    const displayName =
                      element.textContent?.trim()?.slice(0, 50) ||
                      element.getAttribute('aria-label') ||
                      element.getAttribute('title') ||
                      element.getAttribute('placeholder') ||
                      element.getAttribute('alt') ||
                      element.getAttribute('value') ||
                      '';

                    results.push({
                      ref: 'ref_' + refCounter++,
                      role,
                      name: displayName,
                      boundingBox: {
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                      }
                    });
                  }
                }

                return results;
              })()
            `,
            returnByValue: true,
          }
        );

        const foundElements = result.result.value as FoundElement[];

        if (foundElements.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No elements found matching: "${query}"`,
              },
            ],
          };
        }

        // Format results
        let output = `Found ${foundElements.length} elements:\n\n`;
        for (const el of foundElements) {
          output += `[${el.ref}] ${el.role}`;
          if (el.name) output += `: "${el.name}"`;
          if (el.boundingBox) {
            output += ` at (${el.boundingBox.x}, ${el.boundingBox.y})`;
            output += ` size ${el.boundingBox.width}x${el.boundingBox.height}`;
          }
          output += '\n';
        }

        if (foundElements.length >= 20) {
          output += '\n(More than 20 matches found. Use a more specific query.)';
        }

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Find error: ${message}` }],
          isError: true,
        };
      }
    },

    definition: {
      name: 'find',
      description:
        'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content. Returns up to 20 matching elements with references.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID for isolation',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to search in',
          },
          query: {
            type: 'string',
            description:
              'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")',
          },
        },
        required: ['sessionId', 'tabId', 'query'],
      },
    } as MCPToolDefinition,
  };
}
