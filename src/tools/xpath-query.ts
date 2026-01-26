/**
 * XPath Query Tool - Query elements using XPath expressions
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

interface ElementInfo {
  tagName: string;
  id?: string;
  className?: string;
  text?: string;
  attributes: Record<string, string>;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  xpath: string;
}

const definition: MCPToolDefinition = {
  name: 'xpath_query',
  description: `Query elements on the page using XPath expressions.
Returns element information including tag, attributes, text, and position.
Examples:
- //button[contains(text(), 'Submit')]
- //div[@class='product']//span[@class='price']
- //input[@type='text'][@name='email']`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to query',
      },
      xpath: {
        type: 'string',
        description: 'XPath expression to evaluate',
      },
      multiple: {
        type: 'boolean',
        description: 'Whether to return multiple results (default: false)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (for multiple: true)',
      },
    },
    required: ['tabId', 'xpath'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const xpath = args.xpath as string;
  const multiple = (args.multiple as boolean | undefined) ?? false;
  const limit = (args.limit as number | undefined) ?? 50;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!xpath) {
    return {
      content: [{ type: 'text', text: 'Error: xpath is required' }],
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
      // Return multiple results
      const result = await page.evaluate(
        (xpathExpr: string, maxResults: number) => {
          function extractElementInfo(element: Element, xpathStr: string) {
            const tagName = element.tagName.toLowerCase();
            const id = element.id || undefined;
            const classNameAttr = element.getAttribute('class');
            const className = classNameAttr || undefined;
            const text = element.textContent?.trim().slice(0, 200) || undefined;

            const attributes: Record<string, string> = {};
            for (let i = 0; i < element.attributes.length; i++) {
              const attr = element.attributes[i];
              if (attr.name !== 'id' && attr.name !== 'class') {
                attributes[attr.name] = attr.value.slice(0, 100);
              }
            }

            const rect = element.getBoundingClientRect();

            return {
              tagName,
              id,
              className,
              text,
              attributes,
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              xpath: xpathStr,
            };
          }

          const xpathResult = document.evaluate(
            xpathExpr,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null
          );

          const elements: ReturnType<typeof extractElementInfo>[] = [];
          const count = Math.min(xpathResult.snapshotLength, maxResults);

          for (let i = 0; i < count; i++) {
            const node = xpathResult.snapshotItem(i);
            if (node instanceof Element) {
              const simpleXpath = `(${xpathExpr})[${i + 1}]`;
              elements.push(extractElementInfo(node, simpleXpath));
            }
          }

          return {
            elements,
            totalCount: xpathResult.snapshotLength,
          };
        },
        xpath,
        limit
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'xpath_query',
              xpath,
              multiple: true,
              results: result.elements,
              count: result.elements.length,
              totalCount: result.totalCount,
              message:
                result.elements.length > 0
                  ? `Found ${result.totalCount} element(s), returned ${result.elements.length}`
                  : 'No elements found',
            }),
          },
        ],
      };
    } else {
      // Return single result
      const element = await page.evaluate((xpathExpr: string) => {
        function extractElementInfo(el: Element, xpathStr: string) {
          const tagName = el.tagName.toLowerCase();
          const id = el.id || undefined;
          const classNameAttr = el.getAttribute('class');
          const className = classNameAttr || undefined;
          const text = el.textContent?.trim().slice(0, 200) || undefined;

          const attributes: Record<string, string> = {};
          for (let i = 0; i < el.attributes.length; i++) {
            const attr = el.attributes[i];
            if (attr.name !== 'id' && attr.name !== 'class') {
              attributes[attr.name] = attr.value.slice(0, 100);
            }
          }

          const rect = el.getBoundingClientRect();

          return {
            tagName,
            id,
            className,
            text,
            attributes,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            xpath: xpathStr,
          };
        }

        const xpathResult = document.evaluate(
          xpathExpr,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );

        const node = xpathResult.singleNodeValue;
        if (!node || !(node instanceof Element)) {
          return null;
        }

        return extractElementInfo(node, xpathExpr);
      }, xpath);

      if (!element) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'xpath_query',
                xpath,
                multiple: false,
                result: null,
                message: 'No element found matching XPath',
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'xpath_query',
              xpath,
              multiple: false,
              result: element,
              message: `Found element: <${element.tagName}${element.id ? ` id="${element.id}"` : ''}>`,
            }),
          },
        ],
      };
    }
  } catch (error) {
    // Check for XPath syntax errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('XPath') || errorMessage.includes('syntax')) {
      return {
        content: [
          {
            type: 'text',
            text: `XPath syntax error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `XPath query error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerXpathQueryTool(server: MCPServer): void {
  server.registerTool('xpath_query', handler, definition);
}
