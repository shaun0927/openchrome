/**
 * Query DOM Tool - Unified CSS selector and XPath queries
 *
 * Replaces: selector_query, xpath_query
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import { getAllShadowRoots, querySelectorInShadowRoots } from '../utils/shadow-dom';
import { isSnapshotCacheEnabled } from '../utils/snapshot-cache-helper';
import { getCurrentLoaderId, mintNodeRefSync } from '../core/perception/node-ref';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface CSSElementInfo {
  ref: string;
  /**
   * Stable backend-node uid (#844). P2 contract: this field is always
   * present in the response shape. Value is `null` when
   * OPENCHROME_NODE_REF=0 OR when the element could not be resolved to a
   * backendNodeId in time.
   */
  nodeRef: string | null;
  /**
   * CDP backendNodeId of the element when available. Present alongside
   * `nodeRef` for one minor-version transition (#844 acceptance criteria).
   */
  backendNodeId?: number;
  tagName: string;
  id: string | null;
  className: string;
  attributes: Record<string, string>;
  textContent: string;
  isVisible: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const definition: MCPToolDefinition = {
  name: 'query_dom',
  description:
    'Query DOM elements via CSS selector or XPath. Returns tag, attributes, text, position. CSS results include a ref field for use in subsequent calls.\n\nWhen to use: Precise element lookup by CSS selector or XPath when you know the exact selector.\nWhen NOT to use: Use find for natural-language element search or read_page for full DOM structure.',
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
  annotations: TOOL_ANNOTATIONS.query_dom,
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

/**
 * Resolve the backendNodeId for a puppeteer ElementHandle via CDP, then
 * mint a stable nodeRef. Returns `{ nodeRef, backendNodeId }` with
 * `nodeRef=null` (and `backendNodeId` omitted) when resolution fails or
 * when the feature flag is off. Designed for the post-evaluate enrichment
 * pass — never throws.
 */
async function resolveNodeRefForHandle(
  page: import('puppeteer-core').Page,
  cdpClient: { send: (page: import('puppeteer-core').Page, method: string, params?: Record<string, unknown>) => Promise<unknown> },
  loaderId: string | null,
  handle: import('puppeteer-core').ElementHandle<Element>,
): Promise<{ nodeRef: string | null; backendNodeId?: number }> {
  try {
    const remoteObject = (handle as unknown as { remoteObject?: () => { objectId?: string } }).remoteObject?.();
    const objectId = remoteObject?.objectId;
    if (!objectId) return { nodeRef: null };
    const { node } = (await cdpClient.send(page, 'DOM.describeNode', {
      objectId,
    })) as { node?: { backendNodeId?: number } };
    const backendNodeId = node?.backendNodeId;
    if (!backendNodeId || backendNodeId <= 0) return { nodeRef: null };
    if (!loaderId) return { nodeRef: null, backendNodeId };
    const uid = mintNodeRefSync(page, loaderId, backendNodeId);
    return { nodeRef: uid, backendNodeId };
  } catch {
    return { nodeRef: null };
  }
}

async function gatherDiagnostics(
  page: import('puppeteer-core').Page,
  selector: string,
  context?: ToolContext
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
    }, selector), 15000, 'query_dom', context);
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
                // nodeRef is filled in post-evaluate; P2 contract requires
                // the key to always be present in the response shape.
                nodeRef: null,
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
          // Shadow fallback already has the backendNodeId. Avoid an extra
          // Page.getFrameTree CDP call here: shadow fallback tests and callers
          // rely on the resolveNode/callFunctionOn sequence staying stable.
          // The P2 contract is still preserved because nodeRef is present and
          // remains null when loaderId is not resolved in this fallback path.
          result.value.backendNodeId = backendNodeIds[i];
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
  args: Record<string, unknown>,
  context?: ToolContext
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

      const diag = await gatherDiagnostics(page, selector, context);
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
      // Budget check: return partial results if deadline is approaching
      if (context && !hasBudget(context, 10_000)) {
        break;
      }
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
            // nodeRef is populated post-evaluate via CDP enrichment below
            // (P2 contract: field is always present in the response shape).
            nodeRef: null as string | null,
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
      , context);
      elementInfos.push(info);
    }

    // Post-evaluate enrichment: mint a stable nodeRef per element (#844).
    // We do this outside the in-page evaluate because backendNodeId is only
    // observable via CDP, not via DOM-level APIs. Failures degrade to
    // nodeRef=null without affecting the rest of the response.
    {
      const cdpClient = sessionManager.getCDPClient();
      let loaderId: string | null = null;
      try {
        loaderId = await getCurrentLoaderId(page, cdpClient);
      } catch {
        loaderId = null;
      }
      const enrichments = await Promise.all(
        limitedElements
          .slice(0, elementInfos.length)
          .map((element) => resolveNodeRefForHandle(page, cdpClient, loaderId, element)),
      );
      for (let i = 0; i < enrichments.length; i++) {
        const { nodeRef, backendNodeId } = enrichments[i];
        elementInfos[i].nodeRef = nodeRef;
        if (backendNodeId !== undefined) elementInfos[i].backendNodeId = backendNodeId;
      }
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

      const diag = await gatherDiagnostics(page, selector, context);
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
        // nodeRef populated post-evaluate via CDP (P2 contract).
        nodeRef: null as string | null,
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
    }, element), 15000, 'query_dom', context);

    // Post-evaluate nodeRef enrichment (#844)
    try {
      const cdpClient2 = sessionManager.getCDPClient();
      const loaderId2 = await getCurrentLoaderId(page, cdpClient2).catch(() => null);
      const { nodeRef, backendNodeId } = await resolveNodeRefForHandle(
        page, cdpClient2, loaderId2, element,
      );
      info.nodeRef = nodeRef;
      if (backendNodeId !== undefined) info.backendNodeId = backendNodeId;
    } catch {
      // info.nodeRef already defaults to null
    }

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
  args: Record<string, unknown>,
  context?: ToolContext
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
    ), 15000, 'query_dom', context);

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
    }, xpath), 15000, 'query_dom', context);

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
  args: Record<string, unknown>,
  context?: ToolContext
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
        return await handleCSS(sessionId, args, context);
      case 'xpath':
        return await handleXPath(sessionId, args, context);
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

/**
 * Snapshot-cache wrapper (#879). See `src/tools/read-page.ts` for the
 * shared rationale.
 *
 * Kill-switch short-circuit runs FIRST so the wrapper introduces zero
 * extra `getPage` calls when the cache is disabled (the 1.12 default).
 */
const cachedHandler: ToolHandler = async (sessionId, args, context) => {
  // query_dom returns viewport-relative bounding boxes and runtime ref tokens.
  // Keep it uncached until scroll position and ref regeneration are part of
  // the cache identity/side effects; the flag check preserves the future seam.
  void isSnapshotCacheEnabled();
  return handler(sessionId, args, context);
};

export function registerQueryDomTool(server: MCPServer): void {
  server.registerTool('query_dom', cachedHandler, definition);
}
