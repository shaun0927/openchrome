/**
 * JavaScript Tool - Execute JavaScript in page context
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, throwIfAborted } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { assertDomainAllowed } from '../security/domain-guard';
import { withTimeout } from '../utils/with-timeout';
import { wrapMutatingHandler } from '../utils/snapshot-cache-helper';

const definition: MCPToolDefinition = {
  name: 'javascript_tool',
  description: 'Execute JavaScript in page context. Supports await, async IIFE, and shadow-DOM helpers via __pierce.\n\nWhen to use: Custom DOM queries, data extraction, or triggering JS APIs not reachable via other tools.\nWhen NOT to use: Use interact or act for UI interactions, or extract_data for structured schema-based extraction.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute code in',
      },
      code: {
        type: 'string',
        description: 'JS code. Last expression returned',
      },
      text: {
        type: 'string',
        description: 'Deprecated. Use "code" instead',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms. Default: 30000',
      },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.javascript_tool,
};

export interface CDPEvalResult {
  result: {
    type: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    className?: string;
    objectId?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

/**
 * Interface for the CDP client needed by formatCDPResult to do lazy value fetching.
 */
export interface CDPSender {
  send<T = unknown>(
    page: unknown,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T>;
}

export const JAVASCRIPT_HELPER_INJECTION = `(() => {
  const oc = globalThis.__openchrome || {};
  const querySelectorAllDeep = function(selector, root) {
    const start = root || document;
    const results = [];
    const visit = function(node) {
      if (!node || typeof node.querySelectorAll !== 'function') return;
      try {
        const matched = node.querySelectorAll(selector);
        for (let i = 0; i < matched.length; i++) results.push(matched[i]);
      } catch (e) {
        return;
      }

      if (node.shadowRoot) visit(node.shadowRoot);

      let all = [];
      try {
        all = node.querySelectorAll('*');
      } catch (e) {
        return;
      }
      for (let i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) visit(all[i].shadowRoot);
      }
    };
    visit(start);
    return results;
  };

  oc.querySelectorAllDeep = querySelectorAllDeep;
  globalThis.__openchrome = oc;
  globalThis.__pierce = querySelectorAllDeep;
})()`;

export function wrapInIIFE(code: string): string {
  const trimmed = code.trim();

  // Single expression without semicolons, newlines, or return: evaluate as-is
  // so the expression value is returned naturally by Runtime.evaluate.
  if (!trimmed.includes('\n') && !trimmed.includes(';') && !/\breturn\b/.test(trimmed)) {
    return trimmed;
  }

  // Multi-statement code or code with explicit return: wrap in async IIFE.
  // This fixes two common LLM errors:
  //   1. SyntaxError: Illegal return statement  (return outside a function)
  //   2. SyntaxError: Identifier 'x' has already been declared  (let/const redeclaration)
  //
  // If there is no explicit `return`, try to auto-return the last expression so
  // that `let x = 5;\nx` still returns 5 instead of undefined.
  if (!/\breturn\b/.test(trimmed)) {
    const lines = trimmed.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1]?.trim() ?? '';

    // Auto-return the last line if it looks like an expression (not a
    // declaration, control-flow statement, closing brace, or comment).
    const isAutoReturnable =
      lastLine.length > 0 &&
      !lastLine.startsWith('let ') &&
      !lastLine.startsWith('const ') &&
      !lastLine.startsWith('var ') &&
      !lastLine.startsWith('function ') &&
      !lastLine.startsWith('class ') &&
      !lastLine.startsWith('if') &&
      !lastLine.startsWith('else') &&
      !lastLine.startsWith('for') &&
      !lastLine.startsWith('while') &&
      !lastLine.startsWith('do') &&
      !lastLine.startsWith('switch') &&
      !lastLine.startsWith('try') &&
      !lastLine.startsWith('catch') &&
      !lastLine.startsWith('finally') &&
      !lastLine.startsWith('//') &&
      !lastLine.startsWith('/*') &&
      !lastLine.startsWith('}');

    if (isAutoReturnable) {
      const bodyLines = lines.slice(0, -1).join('\n');
      const body = bodyLines ? `${bodyLines}\nreturn ${lastLine}` : `return ${lastLine}`;
      return `(async () => { ${body}\n})()`;
    }
  }

  return `(async () => { ${code}\n})()`;
}

export function buildJavascriptExpression(code: string): string {
  return `${JAVASCRIPT_HELPER_INJECTION};\n${wrapInIIFE(code)}`;
}

export async function formatCDPResult(
  evalResult: CDPEvalResult['result'],
  cdpClient?: CDPSender,
  page?: unknown
): Promise<string> {
  const { type, subtype, value, description, className, objectId } = evalResult;

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

  if (type === 'object' && (subtype === 'promise' || className === 'Promise')) {
    if (objectId) {
      releaseObject(cdpClient, page, objectId);
    }
    return [
      description || 'Promise',
      'Diagnostic: CDP returned a Promise remote object even though Runtime.evaluate used awaitPromise: true.',
      'Return or await the promise directly so javascript_tool can show the resolved value.',
    ].join('\n');
  }

  // NodeList / HTMLCollection / DOMTokenList / Map / Set — non-serializable collections.
  // IMPORTANT: This check must come BEFORE the DOM element check because
  // HTMLCollection starts with "HTML" and would match className?.startsWith('HTML').
  if (
    className === 'NodeList' ||
    className === 'HTMLCollection' ||
    className === 'DOMTokenList' ||
    className === 'Map' ||
    className === 'Set'
  ) {
    if (objectId) {
      releaseObject(cdpClient, page, objectId);
    }
    if (description) {
      // description is like "NodeList(3)" or "Map(2)" — extract count
      const countMatch = description.match(/\((\d+)\)/);
      if (countMatch) {
        return `[${countMatch[1]} elements]`;
      }
    }
    return description || `[${className}]`;
  }

  // DOM element: returnByValue can't serialize nodes, use description
  // description for DOM nodes is like "div#id.class" — reformat to match old output
  if (subtype === 'node' || className?.startsWith('HTML')) {
    if (objectId) {
      releaseObject(cdpClient, page, objectId);
    }
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

  // Primitives: with returnByValue: false, primitives still have value populated
  if (type === 'number' || type === 'string' || type === 'boolean' || type === 'bigint') {
    if (objectId) {
      releaseObject(cdpClient, page, objectId);
    }
    if (value !== undefined) {
      return String(value);
    }
    return description || `[${type}]`;
  }

  // Plain objects and arrays: lazy-fetch via CDP callFunctionOn to serialize
  if (type === 'object' && objectId && cdpClient && page) {
    try {
      const serialized = await cdpClient.send<{ result: { value?: unknown } }>(
        page,
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration:
            'function() { try { return JSON.stringify(this, null, 2); } catch(e) { return String(this); } }',
          returnByValue: true,
        }
      );
      releaseObject(cdpClient, page, objectId);
      if (serialized.result?.value !== undefined) {
        return String(serialized.result.value);
      }
    } catch {
      releaseObject(cdpClient, page, objectId);
    }
  }

  // Fallback: if value is still populated (e.g. returnByValue was true), use it
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

  if (objectId) {
    releaseObject(cdpClient, page, objectId);
  }
  return description || `[${type}]`;
}

/**
 * Release a remote object reference to prevent memory leaks.
 * Fire-and-forget: errors are silently ignored.
 */
function releaseObject(
  cdpClient: CDPSender | undefined,
  page: unknown,
  objectId: string
): void {
  if (cdpClient && page && objectId) {
    cdpClient
      .send(page, 'Runtime.releaseObject', { objectId })
      .catch(() => {});
  }
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  throwIfAborted(context);
  const tabId = args.tabId as string;
  const code = (args.code as string) || (args.text as string);
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
      content: [{ type: 'text', text: 'Error: code is required (JS code to execute)' }],
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
      const available = await sessionManager.getAvailableTargets(sessionId);
      const availableInfo = available.length > 0
        ? `\nAvailable tabs:\n${available.map(t => `  - tabId: ${t.tabId} | ${t.url} | ${t.title}`).join('\n')}`
        : '\nNo tabs available. Call navigate without tabId to create a new tab.';
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.${availableInfo}` }],
        isError: true,
      };
    }

    // Domain blocklist check
    assertDomainAllowed(page.url());

    const cdpClient = sessionManager.getCDPClient();

    const cdpResult = await withTimeout(
      cdpClient.send<CDPEvalResult>(page, 'Runtime.evaluate', {
        expression: buildJavascriptExpression(code),
        returnByValue: false,
        awaitPromise: true,
        userGesture: true,
        replMode: true,
      }),
      timeout,
      'javascript_tool',
      context,
    );

    if (cdpResult.exceptionDetails) {
      const errorMsg =
        cdpResult.exceptionDetails.exception?.description ||
        cdpResult.exceptionDetails.text ||
        'Unknown error';
      const diagnostic =
        cdpResult.exceptionDetails.text && cdpResult.exceptionDetails.text !== errorMsg
          ? `\nDiagnostic: ${cdpResult.exceptionDetails.text}`
          : '';
      return {
        content: [{ type: 'text', text: `JavaScript error: ${errorMsg}${diagnostic}` }],
        isError: true,
      };
    }

    const output = await formatCDPResult(cdpResult.result, cdpClient, page);

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
  // Snapshot-cache (#879): conservative bump — `javascript_tool` cannot
  // statically know whether the eval mutated the DOM, so we bump
  // docEpoch unconditionally on a successful eval. A subsequent
  // `read_page` therefore always recomputes.
  const sm = getSessionManager();
  const wrapped = wrapMutatingHandler(handler, (sid, tid) =>
    tid ? sm.getPage(sid, tid, undefined, 'javascript_tool') : Promise.resolve(null),
  );
  server.registerTool('javascript_tool', wrapped, definition);
}
