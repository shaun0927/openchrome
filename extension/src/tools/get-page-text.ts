/**
 * Get page text tool for MCP - Extract raw text content from the page
 */

import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { SessionManager } from '../session-manager';

export function createGetPageTextTool(sessionManager: SessionManager) {
  return {
    handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
      const tabId = params.tabId as number;

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
        const result = await sessionManager.executeCDP<{ result: { value: string } }>(
          sessionId,
          tabId,
          'Runtime.evaluate',
          {
            expression: `
              (() => {
                // Try to find article content first
                const article = document.querySelector('article, [role="article"], main, .article, .content, .post');
                if (article) {
                  return article.innerText || article.textContent || '';
                }

                // Fall back to body text
                const body = document.body;
                if (!body) return '';

                // Remove script and style elements from consideration
                const clone = body.cloneNode(true);
                const scripts = clone.querySelectorAll('script, style, noscript, iframe, svg');
                scripts.forEach(el => el.remove());

                // Get text content
                let text = clone.innerText || clone.textContent || '';

                // Clean up whitespace
                text = text
                  .split('\\n')
                  .map(line => line.trim())
                  .filter(line => line.length > 0)
                  .join('\\n');

                return text;
              })()
            `,
            returnByValue: true,
          }
        );

        const text = result.result.value;

        if (!text || text.trim().length === 0) {
          return {
            content: [{ type: 'text', text: 'No text content found on the page.' }],
          };
        }

        // Truncate if too long
        const maxLength = 100000;
        let output = text;
        if (output.length > maxLength) {
          output = output.slice(0, maxLength) + '\n\n... (content truncated)';
        }

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error getting page text: ${message}` }],
          isError: true,
        };
      }
    },

    definition: {
      name: 'get_page_text',
      description:
        'Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID for isolation',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to extract text from',
          },
        },
        required: ['sessionId', 'tabId'],
      },
    } as MCPToolDefinition,
  };
}
