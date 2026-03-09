/**
 * Query DOM Tool - Unified CSS selector and XPath queries
 *
 * Replaces: selector_query, xpath_query
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import { getAllShadowRoots, querySelectorInShadowRoots } from '../utils/shadow-dom';

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
    'Query DOM elements via CSS selector or XPath. Returns tag, attributes, text, position. CSS results include a ref field for use in subsequent calls.',
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
        description: 'Query method: css or xpath',
      },
      selector: {
        type: 'string',
        description: '(css) CSS selector',
      },
      xpath: {
        type: 'string',
        description: '(xpath) XPath expression',
      },
      multiple: {
        type: 'boolean',
        description: 'Return all matches. Default: false',
      },
      pierceShadow: {
        type: 'boolean',
        description: 'Search inside shadow DOM when no results in light DOM. Default: true',
      },
      limit: {
        type: 'number',
        description: '(xpath, multiple) Max results to return',
      },
    },
    required: ['tabId', 'method'],
  },
};

// ---------------------------------------------------------------------------
// Diagnostics helper (reuses getPageDiagnostics from page-diagnostics.ts)
// ---------------------------------------------------------------------------

interface QueryDomDiagnostics {
  url: string;
  readyState: string;
  totalElements: number;
  framework: string | null;
  closestMatch: string | null;
}

async function gatherDiagnostics(
  page: import('puppeteer-core').Page,
  selector: string
): Promise<QueryDomDiagnostics | null> {
  try {
    // Single atomic evaluate to avoid race conditions if page navigates between calls
    return await withTimeout(page.evaluate((sel: string) => {
      const total = document.querySelectorAll('*').length;

      let framework: string | null = null;
      if (document.querySelector('[data-reactroot], #__next, #root[data-reactroot]')) framework = 'react';
      else if (document.querySelector('[data-v-], #app[data-v-]')) framework = 'vue';
      else if (document.querySelector('[ng-version], [_nghost]')) framework = 'angular';

      // CSS-specific: find closest partial match for compound selectors
      let closestMatch: string | null = null;
      const parts = sel.split(' ');
      if (parts.length > 1) {
        for (let i = parts.length - 1; i >= 0; i--) {
          const partial = parts.slice(0, i).join(' ');
          if (partial) {
            try {
              const count = document.querySelectorAll(partial).length;
              if (count > 0) {
                closestMatch = `"${partial}" (${count} matches)`;
                break;
              }
            } catch {
              // ignore invalid partial selectors
            }
          }
        }
      }

      return {
        url: location.href,
        readyState: document.readyState,
        totalElements: total,
        framework,
        closestMatch,
      };
    }, selector), 15000, 'query_dom');
  } catch (err) {
    console.error('[query_dom] diagnostics failed:', err);
    return null;
  }
}

function formatDiagnosticsMessage(selector: string, diag: QueryDomDiagnostics | null, plural: boolean): string {
  const base = plural
    ? `No elements found matching "${selector}"`
    : `No element found matching "${selector}"`;
  if (!diag) return base;

  const hostname = (() => {
    try { return new URL(diag.url).hostname; } catch { return diag.url; }
  })();
  const frameworkPart = diag.framework ? `, ${diag.framework}` : '';
  const statePart = `${hostname} (${diag.readyState}${frameworkPart}), ${diag.totalElements} elements`;
  const closestPart = diag.closestMatch ? `. Closest: ${diag.closestMatch}` : '';

  return `${base}. Page: ${statePart}${closestPart}`;
}

/**
 * Shadow DOM fallback for CSS queries.
 * Searches inside shadow roots via CDP when light DOM returns no results.
 */
async function shadowCSSFallback(
  page: import('puppeteer-core').Page,
  selector: string,
  multiple: boolean,
): Promise<CSSElementInfo[] | null> {
  const sessionManager = getSessionManager();
  const cdpClient = sessionManager.getCDPClient();
  try {
    const { shadowRoots } = await getAllShadowRoots(page, cdpClient);
    if (shadowRoots.length === 0) return null;

    const backendNodeIds = await querySelectorInShadowRoots(page, cdpClient, selector, shadowRoots);
    if (backendNodeIds.length === 0) return null;

    const MAX = multiple ? 50 : 1;
    const results: CSSElementInfo[] = [];

    for (let i = 0; i < Math.min(backendNodeIds.length, MAX); i++) {
      try {
        const { object } = await cdpClient.send<{ object: { objectId?: string } }>(
          page, 'DOM.resolveNode', { backendNodeId: backendNodeIds[i] },
        );
        if (!object?.objectId) continue;

        const { result } = await cdpClient.send<{ result: { value?: CSSElementInfo } }>(
          page, 'Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function() {
              var el = this;
              var rect = el.getBoundingClientRect();
              var style = window.getComputedStyle(el);
              var isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
              var attributes = {};
              for (var j = 0; j < el.attributes.length; j++) { attributes[el.attributes[j].name] = el.attributes[j].value; }
              return {
                ref: '',
                tagName: el.tagName.toLowerCase(),
                id: el.id || null,
                className: typeof el.className === 'string' ? el.className : '',
                attributes: attributes,
                textContent: (el.textContent || '').trim().slice(0, 100),
                isVisible: isVisible,
                boundingBox: rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
              };
            }`,
            returnByValue: true,
          },
        );

        if (result?.value) {
          result.value.ref = `el_${i}`;
          results.push(result.value);
        }
      } catch {
        // skip elements that can't be resolved
      }
    }

    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

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
  const pierceShadow = (args.pierceShadow as boolean) ?? true;

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
      // Shadow DOM fallback: search inside shadow roots via CDP
      if (pierceShadow) {
        const shadowResults = await shadowCSSFallback(page, selector, true);
        if (shadowResults) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'query_dom',
                  method: 'css',
                  selector,
                  multiple: true,
                  elements: shadowResults,
                  count: shadowResults.length,
                  shadowDOM: true,
                }),
              },
            ],
          };
        }
      }

      const diag = await gatherDiagnostics(page, selector);
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
              message: formatDiagnosticsMessage(selector, diag, true),
              ...(diag && { diagnostics: diag }),
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
      const info = await withTimeout(page.evaluate(
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
            ref: `el_${index}`,
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
      ), 2000, 'query_dom'
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
      // Shadow DOM fallback: search inside shadow roots via CDP
      if (pierceShadow) {
        const shadowResults = await shadowCSSFallback(page, selector, false);
        if (shadowResults && shadowResults.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'query_dom',
                  method: 'css',
                  selector,
                  multiple: false,
                  element: shadowResults[0],
                  shadowDOM: true,
                }),
              },
            ],
          };
        }
      }

      const diag = await gatherDiagnostics(page, selector);
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
              message: formatDiagnosticsMessage(selector, diag, false),
              ...(diag && { diagnostics: diag }),
            }),
          },
        ],
      };
    }

    const info = await withTimeout(page.evaluate((el: Element): CSSElementInfo => {
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
        ref: 'el_0',
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
    }, element), 15000, 'query_dom');

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
    const result = await withTimeout(page.evaluate(
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

        // Collect from light DOM
        const allNodes: Element[] = [];
        try {
          const xpathResult = document.evaluate(
            xpathExpr, document, null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
          );
          for (let i = 0; i < xpathResult.snapshotLength; i++) {
            const node = xpathResult.snapshotItem(i);
            if (node instanceof Element) allNodes.push(node);
          }
        } catch { /* invalid xpath */ }

        // Deep search: open shadow roots
        const shadowXPath = xpathExpr.startsWith('//') ? '.' + xpathExpr : xpathExpr;
        function walkShadowRoots(root: Element | Document | ShadowRoot) {
          const allEls = root.querySelectorAll('*');
          for (let j = 0; j < allEls.length; j++) {
            if (allEls[j].shadowRoot) {
              try {
                const sr = allEls[j].shadowRoot!;
                const srResult = document.evaluate(
                  shadowXPath, sr, null,
                  XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
                );
                for (let k = 0; k < srResult.snapshotLength; k++) {
                  const srNode = srResult.snapshotItem(k);
                  if (srNode instanceof Element) allNodes.push(srNode);
                }
                walkShadowRoots(sr);
              } catch { /* skip */ }
            }
          }
        }
        walkShadowRoots(document);

        const limited = allNodes.slice(0, maxResults);
        const elements: ReturnType<typeof extractElementInfo>[] = limited.map(
          (el, idx) => extractElementInfo(el, `(${xpathExpr})[${idx + 1}]`)
        );

        return {
          elements,
          totalCount: allNodes.length,
        };
      },
      xpath,
      limit
    ), 15000, 'query_dom');

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
    const element = await withTimeout(page.evaluate((xpathExpr: string) => {
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

      // Light DOM first
      const xpathResult = document.evaluate(
        xpathExpr, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      const node = xpathResult.singleNodeValue;
      if (node && node instanceof Element) {
        return extractElementInfo(node, xpathExpr);
      }

      // Deep search: open shadow roots
      const shadowXPath = xpathExpr.startsWith('//') ? '.' + xpathExpr : xpathExpr;
      function findInShadowRoots(root: Element | Document | ShadowRoot): Element | null {
        const allEls = root.querySelectorAll('*');
        for (let j = 0; j < allEls.length; j++) {
          if (allEls[j].shadowRoot) {
            try {
              const sr = allEls[j].shadowRoot!;
              const srResult = document.evaluate(
                shadowXPath, sr, null,
                XPathResult.FIRST_ORDERED_NODE_TYPE, null
              );
              const srNode = srResult.singleNodeValue;
              if (srNode && srNode instanceof Element) return srNode as Element;
              const deeper = findInShadowRoots(sr);
              if (deeper) return deeper;
            } catch { /* skip */ }
          }
        }
        return null;
      }
      const shadowNode = findInShadowRoots(document);
      if (shadowNode) return extractElementInfo(shadowNode, xpathExpr);

      return null;
    }, xpath), 15000, 'query_dom');

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
              message: `No element found matching XPath: ${xpath}`,
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
