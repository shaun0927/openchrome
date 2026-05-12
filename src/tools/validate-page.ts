/**
 * Validate Page Tool — composite "is this page healthy?" check.
 *
 * Collapses the common navigate → wait → console-capture → read DOM loop
 * into a single tool call. Designed for agents that need to verify a
 * frontend renders without errors, not for general-purpose page reading.
 *
 * Returns: { tabId, url, title, status, durationMs, console: { errors, warnings, total },
 *           summary: { interactiveCount, formCount, hasCanvas, hasIframe, bodyTextSample } }
 *
 * Token budget target: ~600 tokens vs ~4000 for the equivalent multi-call sequence.
 */

import type { CDPSession, Page } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { smartGoto } from '../utils/smart-goto';
import { safeTitle } from '../utils/safe-title';
import { assertDomainAllowed } from '../security/domain-guard';

interface ConsoleLogEntry {
  type: string;
  text: string;
  location?: string;
}

interface CDPConsoleAPICalledEvent {
  type: string;
  args: Array<{ type: string; value?: unknown; description?: string }>;
  stackTrace?: { callFrames: Array<{ url: string }> };
}

interface CDPExceptionThrownEvent {
  exceptionDetails: {
    text: string;
    exception?: { description?: string; value?: unknown };
    url?: string;
    stackTrace?: { callFrames: Array<{ url: string }> };
  };
}

const MAX_CAPTURE_MS = 10_000;
const DEFAULT_CAPTURE_MS = 1_500;
const MAX_BODY_SAMPLE = 2_000;
const DEFAULT_BODY_SAMPLE = 500;
const MAX_RETURNED_ERRORS = 20;
const NAV_TIMEOUT_MS = 15_000;

const CAPTURED_TYPES = new Set(['error', 'warning', 'assert']);

export function normalizeUrl(raw: string): string {
  let target = raw;
  const schemeMatch = target.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!['http', 'https'].includes(scheme)) {
      throw new Error(`"${schemeMatch[1]}://" URLs are not supported. Only http:// and https:// can be navigated.`);
    }
    target = scheme + '://' + target.slice(schemeMatch[0].length);
  } else {
    target = 'https://' + target;
  }
  const parsed = new URL(target);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Invalid protocol "${parsed.protocol}". Only http and https are allowed.`);
  }
  if (!parsed.hostname) {
    throw new Error('Invalid URL — missing hostname');
  }
  return target;
}

function argText(arg: { type: string; value?: unknown; description?: string }): string {
  if (arg.value !== undefined) return String(arg.value);
  if (arg.description) return arg.description;
  return `[${arg.type}]`;
}

const definition: MCPToolDefinition = {
  name: 'validate_page',
  description:
    'Composite health check: navigate, wait, capture console errors, return structured summary (title, errors, interactive count, body sample).\n\nWhen to use: Verifying a page renders correctly without errors in a single call instead of chaining navigate + wait_for + console_capture + read_page.\nWhen NOT to use: Use navigate + read_page when you need full DOM content, not just a health summary.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to validate. http:// and https:// schemes only.',
      },
      tabId: {
        type: 'string',
        description: 'Reuse an existing tab. Omit to create a new tab.',
      },
      waitForSelector: {
        type: 'string',
        description: 'Optional CSS selector that must appear before the page is considered ready.',
      },
      captureConsoleMs: {
        type: 'number',
        description: `How long to listen for console errors after navigation completes. Default: ${DEFAULT_CAPTURE_MS}, max: ${MAX_CAPTURE_MS}.`,
      },
      bodyTextSampleChars: {
        type: 'number',
        description: `How much visible body text to include in the summary. Default: ${DEFAULT_BODY_SAMPLE}, max: ${MAX_BODY_SAMPLE}.`,
      },
    },
    required: ['url'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const rawUrl = args.url as string | undefined;
  const tabIdArg = args.tabId as string | undefined;
  const waitForSelector = args.waitForSelector as string | undefined;
  const captureConsoleMs = Math.min(
    Math.max((args.captureConsoleMs as number) ?? DEFAULT_CAPTURE_MS, 0),
    MAX_CAPTURE_MS,
  );
  const bodyTextSampleChars = Math.min(
    Math.max((args.bodyTextSampleChars as number) ?? DEFAULT_BODY_SAMPLE, 0),
    MAX_BODY_SAMPLE,
  );

  if (!rawUrl) {
    return {
      content: [{ type: 'text', text: 'Error: url is required' }],
      isError: true,
    };
  }

  let targetUrl: string;
  try {
    targetUrl = normalizeUrl(rawUrl);
    assertDomainAllowed(targetUrl);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();
  const startTime = Date.now();

  // Resolve or create a tab
  let page: Page | null = null;
  let tabId = tabIdArg;
  let created = false;
  try {
    if (tabId) {
      page = await sessionManager.getPage(sessionId, tabId, undefined, 'validate_page');
      if (!page) {
        return {
          content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
          isError: true,
        };
      }
    } else {
      const result = await sessionManager.createTarget(sessionId, undefined);
      page = result.page;
      tabId = result.targetId;
      created = true;
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error preparing tab: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }

  // Attach CDP console listeners BEFORE navigation
  const errors: ConsoleLogEntry[] = [];
  const warnings: ConsoleLogEntry[] = [];
  let totalErrors = 0;
  let totalWarnings = 0;

  let cdpSession: CDPSession | null = null;
  let consoleHandler: ((event: CDPConsoleAPICalledEvent) => void) | null = null;
  let exceptionHandler: ((event: CDPExceptionThrownEvent) => void) | null = null;

  try {
    cdpSession = await page.createCDPSession();
    await cdpSession.send('Runtime.enable');

    consoleHandler = (event: CDPConsoleAPICalledEvent) => {
      if (!CAPTURED_TYPES.has(event.type)) return;
      const text = event.args.map(argText).join(' ').slice(0, 300);
      const location = event.stackTrace?.callFrames?.[0]?.url;
      const entry: ConsoleLogEntry = { type: event.type, text, ...(location && { location }) };
      if (event.type === 'warning') {
        totalWarnings++;
        if (warnings.length < MAX_RETURNED_ERRORS) warnings.push(entry);
      } else {
        totalErrors++;
        if (errors.length < MAX_RETURNED_ERRORS) errors.push(entry);
      }
    };

    exceptionHandler = (event: CDPExceptionThrownEvent) => {
      const details = event.exceptionDetails;
      const text = (
        details.exception?.description ||
        (details.exception?.value !== undefined ? String(details.exception.value) : '') ||
        details.text ||
        'Unknown error'
      ).slice(0, 300);
      const location = details.stackTrace?.callFrames?.[0]?.url || details.url;
      const entry: ConsoleLogEntry = { type: 'error', text, ...(location && { location }) };
      totalErrors++;
      if (errors.length < MAX_RETURNED_ERRORS) errors.push(entry);
    };

    cdpSession.on('Runtime.consoleAPICalled', consoleHandler as (...args: unknown[]) => void);
    cdpSession.on('Runtime.exceptionThrown', exceptionHandler as (...args: unknown[]) => void);
  } catch {
    // Best-effort — proceed without console capture
  }

  // Navigate
  let status: 'ok' | 'navigation_failed' | 'timeout' | 'auth_redirect_required' = 'ok';
  let navError: string | undefined;
  let authRedirect: { from: string; to: string; host: string } | undefined;
  try {
    const gotoResult = await smartGoto(page, targetUrl, { timeout: NAV_TIMEOUT_MS });
    if (gotoResult.authRedirect) {
      authRedirect = gotoResult.authRedirect;
      status = 'auth_redirect_required';
      navError = `Authentication redirect detected — page redirected from ${authRedirect.from} to ${authRedirect.host}. Sign in via the browser, then retry.`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    navError = msg;
    status = /timeout|timed out|exceeded/i.test(msg) ? 'timeout' : 'navigation_failed';
  }

  // Optional readiness gate
  if (status === 'ok' && waitForSelector) {
    try {
      await page.waitForSelector(waitForSelector, { timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      navError = `waitForSelector "${waitForSelector}" failed: ${msg}`;
      status = /timeout|timed out|exceeded/i.test(msg) ? 'timeout' : 'navigation_failed';
    }
  }

  // Drain late console errors
  if (captureConsoleMs > 0) {
    await new Promise(resolve => setTimeout(resolve, captureConsoleMs));
  }

  // Detach console listeners
  if (cdpSession) {
    try {
      if (consoleHandler) {
        cdpSession.off('Runtime.consoleAPICalled', consoleHandler as (...args: unknown[]) => void);
      }
      if (exceptionHandler) {
        cdpSession.off('Runtime.exceptionThrown', exceptionHandler as (...args: unknown[]) => void);
      }
      await cdpSession.send('Runtime.disable').catch(() => {});
      await cdpSession.detach().catch(() => {});
    } catch {
      // Ignore — page might be gone
    }
  }

  // Gather DOM summary
  let summary = {
    interactiveCount: 0,
    formCount: 0,
    hasCanvas: false,
    hasIframe: false,
    bodyTextSample: '',
  };
  let title = '';
  try {
    title = await safeTitle(page);
  } catch {
    // ignore
  }
  try {
    summary = await page.evaluate((sampleChars: number) => {
      const interactiveCount = document.querySelectorAll(
        'button, a[href], input, select, textarea, [role="button"]',
      ).length;
      const formCount = document.forms.length;
      const hasCanvas = !!document.querySelector('canvas');
      const hasIframe = !!document.querySelector('iframe');
      const bodyTextSample = (document.body?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, sampleChars);
      return { interactiveCount, formCount, hasCanvas, hasIframe, bodyTextSample };
    }, bodyTextSampleChars);
  } catch {
    // Page might be unreachable — keep defaults
  }

  const durationMs = Date.now() - startTime;
  const finalUrl = (() => {
    try {
      return page.url();
    } catch {
      return targetUrl;
    }
  })();

  const summaryLine =
    status === 'ok'
      ? `validate_page ok — ${totalErrors} error(s), ${totalWarnings} warning(s), ${summary.interactiveCount} interactive elements (${durationMs}ms)`
      : status === 'auth_redirect_required'
        ? `validate_page auth_redirect_required — redirected to ${authRedirect?.host ?? 'unknown'}`
        : `validate_page ${status}${navError ? ': ' + navError : ''}`;

  return {
    content: [{ type: 'text', text: summaryLine }],
    tabId,
    created,
    url: finalUrl,
    title,
    status,
    durationMs,
    console: {
      errors,
      warnings,
      totalErrors,
      totalWarnings,
    },
    summary,
    ...(authRedirect && {
      authRedirect: true,
      redirectedFrom: authRedirect.from,
      authRedirectHost: authRedirect.host,
    }),
    ...(navError && { error: navError }),
  };
};

export function registerValidatePageTool(server: MCPServer): void {
  server.registerTool('validate_page', handler, definition);
}
