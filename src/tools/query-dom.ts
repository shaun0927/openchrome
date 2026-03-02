/**
 * Query DOM Tool - Unified CSS selector and XPath queries
 *
 * Replaces: selector_query, xpath_query
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface CSSElementInfo {
  ref: string;
  tagName: string;
  id: string | null;
  className: string;
  attributes: Record<string, string>;
  textContent: string;
  isVisible: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

interface XPathElementInfo {
  tagName: string;
  id?: string;
  className?: string;
  text?: string;
  attributes: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  xpath: string;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const definition: MCPToolDefinition = {
  name: 'query_dom',
  description:
    'Query DOM elements using CSS selectors or XPath expressions. Returns element information including tag, attributes, text, and position.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to query',
      },
      method: {
        type: 'string',
        enum: ['css', 'xpath'],
        description: 'Query method: "css" for CSS selectors, "xpath" for XPath expressions',
      },
      selector: {
        type: 'string',
        description: '(css) CSS selector to query (e.g., "#search", ".button", "input[type=text]")',
      },
      xpath: {
        type: 'string',
        description: '(xpath) XPath expression to evaluate',
      },
      multiple: {
        type: 'boolean',
        description:
          'If true, returns all matching elements. If false, returns only the first match. Default: false',
      },
      limit: {
        type: 'number',
        description: '(xpath, multiple: true) Maximum number of results to return',
      },
    },
    required: ['tabId', 'method'],
  },
};

// ---------------------------------------------------------------------------
// CSS handler
// ---------------------------------------------------------------------------

async function handleCSS(
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> {
  const tabId = args.tabId as string;
  const selector = args.selector as string;
  const multiple = (args.multiple as boolean) ?? false;

  if (!selector) {
    return {
      content: [{ type: 'text', text: 'Error: selector is required for css method' }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();
  const page = await sessionManager.getPage(sessionId, tabId, undefined, 'query_dom');
  if (!page) {
    return {
      content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
      isError: true,
    };
  }

  if (multiple) {
    const elements = await page.$$(selector);

    if (elements.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'query_dom',
              method: 'css',
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

    const MAX_SELECTOR_RESULTS = 50;
    const totalCount = elements.length;
    const limitedElements = elements.slice(0, MAX_SELECTOR_RESULTS);
    const elementInfos: CSSElementInfo[] = [];

    for (let i = 0; i < limitedElements.length; i++) {
      const element = limitedElements[i];
      const info = await page.evaluate(
        (el: Element, index: number): CSSElementInfo => {
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

    const result: Record<string, unknown> = {
      action: 'query_dom',
      method: 'css',
      selector,
      multiple: true,
      elements: elementInfos,
      count: elementInfos.length,
    };
    if (totalCount > MAX_SELECTOR_RESULTS) {
      result.totalCount = totalCount;
      result.note = `Results limited to first ${MAX_SELECTOR_RESULTS} of ${totalCount} matching elements`;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } else {
    const element = await page.$(selector);

    if (!element) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'query_dom',
              method: 'css',
              selector,
              multiple: false,
              element: null,
              message: `No element found matching "${selector}"`,
            }),
          },
        ],
      };
    }

    const info = await page.evaluate((el: Element): CSSElementInfo => {
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
            action: 'query_dom',
            method: 'css',
            selector,
            multiple: false,
            element: info,
          }),
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// XPath handler
// ---------------------------------------------------------------------------

async function handleXPath(
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> {
  const tabId = args.tabId as string;
  const xpath = args.xpath as string;
  const multiple = (args.multiple as boolean | undefined) ?? false;
  const limit = (args.limit as number | undefined) ?? 50;

  if (!xpath) {
    return {
      content: [{ type: 'text', text: 'Error: xpath is required for xpath method' }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();
  const page = await sessionManager.getPage(sessionId, tabId, undefined, 'query_dom');
  if (!page) {
    return {
      content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
      isError: true,
    };
  }

  if (multiple) {
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
            action: 'query_dom',
            method: 'xpath',
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
              action: 'query_dom',
              method: 'xpath',
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
            action: 'query_dom',
            method: 'xpath',
            xpath,
            multiple: false,
            result: element,
            message: `Found element: <${element.tagName}${element.id ? ` id="${element.id}"` : ''}>`,
          }),
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const method = args.method as string;

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    switch (method) {
      case 'css':
        return await handleCSS(sessionId, args);
      case 'xpath':
        return await handleXPath(sessionId, args);
      default:
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown method "${method}". Use "css" or "xpath".`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for XPath syntax errors
    if (method === 'xpath' && (errorMessage.includes('XPath') || errorMessage.includes('syntax'))) {
      return {
        content: [{ type: 'text', text: `XPath syntax error: ${errorMessage}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `DOM query error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerQueryDomTool(server: MCPServer): void {
  server.registerTool('query_dom', handler, definition);
}
