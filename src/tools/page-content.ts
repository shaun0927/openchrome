/**
 * Page Content Tool - Get HTML content from page
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { MAX_OUTPUT_CHARS, DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';
import { withTimeout } from '../utils/with-timeout';
import { mergeHeaderJson, isStateHeaderEnabled } from './_shared/state-header';

const definition: MCPToolDefinition = {
  name: 'page_content',
  description: 'Get HTML content from page or element.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to get content from',
      },
      selector: {
        type: 'string',
        description: 'CSS selector. Omit for full page',
      },
      outerHTML: {
        type: 'boolean',
        description: 'Return outerHTML vs innerHTML. Default: true',
      },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.page_content,
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const selector = args.selector as string | undefined;
  const outerHTML = (args.outerHTML as boolean) ?? true;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'page_content');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    if (selector) {
      // Get content from specific element
      const element = await page.$(selector);

      if (!element) {
        const missingBody = {
          action: 'page_content',
          selector,
          content: null,
          message: `No element found matching "${selector}"`,
        };
        const missingWithState = isStateHeaderEnabled()
          ? mergeHeaderJson(
              { url: page.url(), title: await page.title(), mode: 'html' as const, capturedAt: Date.now(), tabId },
              missingBody,
            )
          : missingBody;
        return {
          content: [{ type: 'text', text: JSON.stringify(missingWithState) }],
          isError: true,
        };
      }

      let html = await withTimeout(page.evaluate(
        (el: Element, getOuter: boolean) => {
          return getOuter ? el.outerHTML : el.innerHTML;
        },
        element,
        outerHTML
      ), 15000, 'page_content');

      const originalLength = html.length;
      if (html.length > MAX_OUTPUT_CHARS) {
        html = html.substring(0, MAX_OUTPUT_CHARS) + `\n\n[Truncated: ${originalLength} chars total, showing first ${MAX_OUTPUT_CHARS}]`;
      }

      const elementBody = {
        action: 'page_content',
        selector,
        outerHTML,
        contentLength: originalLength,
        content: html,
      };
      const elementWithState = isStateHeaderEnabled()
        ? mergeHeaderJson(
            { url: page.url(), title: await page.title(), mode: 'html' as const, capturedAt: Date.now(), tabId },
            elementBody,
          )
        : elementBody;
      return {
        content: [{ type: 'text', text: JSON.stringify(elementWithState) }],
      };
    } else {
      // Get full page content
      let html = await withTimeout(page.content(), DEFAULT_NAVIGATION_TIMEOUT_MS, 'page.content()');

      const originalLength = html.length;
      if (html.length > MAX_OUTPUT_CHARS) {
        html = html.substring(0, MAX_OUTPUT_CHARS) + `\n\n[Truncated: ${originalLength} chars total, showing first ${MAX_OUTPUT_CHARS}]`;
      }

      const fullPageBody = {
        action: 'page_content',
        selector: null,
        contentLength: originalLength,
        content: html,
      };
      const fullPageWithState = isStateHeaderEnabled()
        ? mergeHeaderJson(
            { url: page.url(), title: await page.title(), mode: 'html' as const, capturedAt: Date.now(), tabId },
            fullPageBody,
          )
        : fullPageBody;
      return {
        content: [{ type: 'text', text: JSON.stringify(fullPageWithState) }],
      };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Page content error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerPageContentTool(server: MCPServer): void {
  server.registerTool('page_content', handler, definition);
}
