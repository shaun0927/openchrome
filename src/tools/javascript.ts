/**
 * JavaScript Tool - Execute JavaScript in page context
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { assertDomainAllowed } from '../security/domain-guard';

const definition: MCPToolDefinition = {
  name: 'javascript_tool',
  description: 'Execute JavaScript in page context. Supports top-level await.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute code in',
      },
      text: {
        type: 'string',
        description: 'JS code to execute. Last expression returned.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms. Default: 30000',
      },
    },
    required: ['text', 'tabId'],
  },
};

interface CDPEvalResult {
  result: {
    type: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    className?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

function formatCDPResult(evalResult: CDPEvalResult['result']): string {
  const { type, subtype, value, description, className } = evalResult;

  if (type === 'undefined') {
    return 'undefined';
  }

  if (subtype === 'null') {
    return 'null';
  }

  if (type === 'function') {
    return description || '[Function]';
  }

  if (type === 'symbol') {
    return description || '[Symbol]';
  }

  // DOM element: returnByValue can't serialize nodes, use description
  // description for DOM nodes is like "div#id.class" — reformat to match old output
  if (subtype === 'node' || className?.startsWith('HTML')) {
    if (description) {
      // description format from V8: "div#myId.myClass" or "span.foo.bar"
      const match = description.match(/^([a-z][a-z0-9]*)(#[^\s.>]*)?(\.[^\s>]*)?$/i);
      if (match) {
        const tag = match[1].toLowerCase();
        const idPart = match[2] ? ` id="${match[2].slice(1)}"` : '';
        // class part may contain dots: ".foo.bar" -> "foo bar"
        const classPart = match[3] ? ` class="${match[3].slice(1).replace(/\./g, ' ')}"` : '';
        return `<${tag}${idPart}${classPart}>`;
      }
      return description;
    }
    return `[${className || type}]`;
  }

  // NodeList / HTMLCollection
  if (className === 'NodeList' || className === 'HTMLCollection') {
    if (description) {
      // description is like "NodeList(3)" — extract count
      const countMatch = description.match(/\((\d+)\)/);
      if (countMatch) {
        return `[${countMatch[1]} elements]`;
      }
    }
    return description || `[${className}]`;
  }

  if (value !== undefined) {
    if (typeof value === 'object' && value !== null) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  return description || `[${type}]`;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const code = args.text as string;
  const timeout = (args.timeout as number) || 30000;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!code) {
    return {
      content: [{ type: 'text', text: 'Error: text (JavaScript code) is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'javascript_tool');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found. Hint: The tab may have been closed or the session expired. Use navigate() to open a new tab.` }],
        isError: true,
      };
    }

    // Domain blocklist check
    assertDomainAllowed(page.url());

    const cdpClient = sessionManager.getCDPClient();

    let jsTid: ReturnType<typeof setTimeout>;
    const cdpResult = await Promise.race([
      cdpClient
        .send<CDPEvalResult>(page, 'Runtime.evaluate', {
          expression: code,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
          replMode: true,
        })
        .finally(() => clearTimeout(jsTid)),
      new Promise<never>((_, reject) => {
        jsTid = setTimeout(
          () => reject(new Error(`JS execution timed out after ${timeout}ms`)),
          timeout
        );
      }),
    ]);

    if (cdpResult.exceptionDetails) {
      const errorMsg =
        cdpResult.exceptionDetails.exception?.description ||
        cdpResult.exceptionDetails.text ||
        'Unknown error';
      return {
        content: [{ type: 'text', text: `JavaScript error: ${errorMsg}` }],
        isError: true,
      };
    }

    const output = formatCDPResult(cdpResult.result);

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `JavaScript execution error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerJavascriptTool(server: MCPServer): void {
  server.registerTool('javascript_tool', handler, definition);
}
