/**
 * Selector Query Tool - Query DOM elements using CSS selectors
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'selector_query',
  description: `Query DOM elements using CSS selectors.
Returns element information including tag, id, classes, attributes, and a reference ID for use with other tools.
Use "multiple: true" to find all matching elements.`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to query',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to query (e.g., "#search", ".button", "input[type=text]")',
      },
      multiple: {
        type: 'boolean',
        description: 'If true, returns all matching elements. If false, returns only the first match. Default: false',
      },
    },
    required: ['tabId', 'selector'],
  },
};

interface ElementInfo {
  ref: string;
  tagName: string;
  id: string | null;
  className: string;
  attributes: Record<string, string>;
  textContent: string;
  isVisible: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const selector = args.selector as string;
  const multiple = (args.multiple as boolean) ?? false;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!selector) {
    return {
      content: [{ type: 'text', text: 'Error: selector is required' }],
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

    if (multiple) {
      // Query all matching elements
      const elements = await page.$$(selector);

      if (elements.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'selector_query',
                selector,
                multiple: true,
                elements: [],
                count: 0,
                message: `No elements found matching "${selector}"`,
              }),
            },
          ],
        };
      }

      const elementInfos: ElementInfo[] = [];

      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        const info = await page.evaluate(
          (el: Element, index: number): ElementInfo => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible =
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0' &&
              rect.width > 0 &&
              rect.height > 0;

            const attributes: Record<string, string> = {};
            for (const attr of el.attributes) {
              attributes[attr.name] = attr.value;
            }

            return {
              ref: `ref_${index}`,
              tagName: el.tagName.toLowerCase(),
              id: el.id || null,
              className: el.className,
              attributes,
              textContent: (el.textContent || '').trim().slice(0, 100),
              isVisible,
              boundingBox:
                rect.width > 0 && rect.height > 0
                  ? {
                      x: Math.round(rect.x),
                      y: Math.round(rect.y),
                      width: Math.round(rect.width),
                      height: Math.round(rect.height),
                    }
                  : null,
            };
          },
          element,
          i
        );
        elementInfos.push(info);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'selector_query',
              selector,
              multiple: true,
              elements: elementInfos,
              count: elementInfos.length,
            }),
          },
        ],
      };
    } else {
      // Query single element
      const element = await page.$(selector);

      if (!element) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'selector_query',
                selector,
                multiple: false,
                element: null,
                message: `No element found matching "${selector}"`,
              }),
            },
          ],
        };
      }

      const info = await page.evaluate((el: Element): ElementInfo => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isVisible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0;

        const attributes: Record<string, string> = {};
        for (const attr of el.attributes) {
          attributes[attr.name] = attr.value;
        }

        return {
          ref: 'ref_0',
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          className: el.className,
          attributes,
          textContent: (el.textContent || '').trim().slice(0, 100),
          isVisible,
          boundingBox:
            rect.width > 0 && rect.height > 0
              ? {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                }
              : null,
        };
      }, element);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'selector_query',
              selector,
              multiple: false,
              element: info,
            }),
          },
        ],
      };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Selector query error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerSelectorQueryTool(server: MCPServer): void {
  server.registerTool('selector_query', handler, definition);
}
