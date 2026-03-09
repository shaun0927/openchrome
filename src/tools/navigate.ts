/**
 * Navigate Tool - Navigate to URLs
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { smartGoto } from '../utils/smart-goto';
import { safeTitle } from '../utils/safe-title';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';
import { generateVisualSummary } from '../utils/visual-summary';
import { AdaptiveScreenshot } from '../utils/adaptive-screenshot';
import { assertDomainAllowed } from '../security/domain-guard';
import { detectBlockingPage } from '../utils/page-diagnostics';
import { withTimeout } from '../utils/with-timeout';

const definition: MCPToolDefinition = {
  name: 'navigate',
  description: 'Navigate to URL or go forward/back. No tabId = new tab. workerId for parallel ops.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to navigate. No tabId = new tab',
      },
      url: {
        type: 'string',
        description: 'URL, "forward", or "back"',
      },
      workerId: {
        type: 'string',
        description: 'Worker ID for parallel ops. Default: default',
      },
      stealth: {
        type: 'boolean',
        description: 'CDP-free mode: opens tab via Chrome debug API without CDP attachment during page load. Use for Cloudflare Turnstile or similar anti-bot pages. CDP attaches after page settles.',
      },
      stealthSettleMs: {
        type: 'number',
        description: 'How long to wait (ms) before attaching CDP in stealth mode. Default: 5000. Range: 1000-30000.',
      },
    },
    required: ['url'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string | undefined;
  const url = args.url as string;
  const workerId = args.workerId as string | undefined;
  const stealth = args.stealth as boolean | undefined;
  const stealthSettleMs = Math.min(Math.max((args.stealthSettleMs as number) || 5000, 1000), 30000);
  const sessionManager = getSessionManager();

  if (!url) {
    return {
      content: [{ type: 'text', text: 'Error: url is required' }],
      isError: true,
    };
  }

  // If no tabId provided and not a history navigation, create a new tab with the URL
  if (!tabId && url !== 'back' && url !== 'forward') {
    try {
      // Normalize URL first
      let targetUrl = url;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }

      // Validate URL before creating tab
      try {
        const parsedUrl = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Invalid protocol "${parsedUrl.protocol}". Only http and https are allowed.`,
              },
            ],
            isError: true,
          };
        }
        if (!parsedUrl.hostname || parsedUrl.hostname.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: Invalid URL - missing hostname' }],
            isError: true,
          };
        }
      } catch (urlError) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Invalid URL format - ${urlError instanceof Error ? urlError.message : 'malformed URL'}`,
            },
          ],
          isError: true,
        };
      }

      // Domain blocklist check on normalized URL
      assertDomainAllowed(targetUrl);

      // Tab reuse: if worker has exactly 1 existing tab, reuse it instead of creating new
      const resolvedWorkerId = workerId || 'default';
      const existingTargets = sessionManager.getWorkerTargetIds(sessionId, resolvedWorkerId);
      if (existingTargets.length === 1) {
        const existingTabId = existingTargets[0];
        if (await sessionManager.isTargetValid(existingTabId)) {
          const page = await sessionManager.getPage(sessionId, existingTabId, undefined, 'navigate');
          if (page) {
            const { authRedirect } = await smartGoto(page, targetUrl, { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
            if (authRedirect) {
              AdaptiveScreenshot.getInstance().reset(existingTabId);
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    action: 'navigate',
                    url: page.url(),
                    title: await safeTitle(page),
                    tabId: existingTabId,
                    workerId: resolvedWorkerId,
                    authRedirect: true,
                    redirectedFrom: authRedirect.from,
                    authRedirectHost: authRedirect.host,
                    message: 'ACTION_REQUIRED: Authentication redirect detected — page redirected from ' + authRedirect.from + ' to ' + authRedirect.host +
                      '. The user must log in manually in their Chrome browser. ' +
                      'Inform the user and wait for confirmation before retrying navigation. ' +
                      'Do NOT attempt to authenticate programmatically.',
                  }),
                }],
                isError: false,
              };
            }
            AdaptiveScreenshot.getInstance().reset(existingTabId);
            const [summary, reuseBlocking] = await Promise.all([
              generateVisualSummary(page),
              Promise.race([
                detectBlockingPage(page),
                new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
              ]).catch(e => { console.error('[navigate] detectBlockingPage error (tab-reuse):', e); return null; }),
            ]);
            // Get element count for SPA readiness visibility
            let reuseElementCount = 0;
            try {
              reuseElementCount = await withTimeout(
                page.evaluate(() => document.querySelectorAll('*').length),
                3000, 'elementCount'
              );
            } catch {
              // Non-critical — proceed without count
            }
            const reuseResultText = JSON.stringify({
              action: 'navigate',
              url: page.url(),
              title: await safeTitle(page),
              tabId: existingTabId,
              workerId: resolvedWorkerId,
              reused: true,
              elementCount: reuseElementCount,
              ...(summary && { visualSummary: summary }),
              ...(reuseBlocking && { blockingPage: reuseBlocking }),
            });
            return {
              content: [{ type: 'text', text: reuseResultText }],
            };
          }
        }
      }

      // Create new tab with URL directly (in specified worker or default)
      // Use stealth mode (CDP-free load) when requested, e.g. for Cloudflare Turnstile pages
      const { targetId, page, workerId: assignedWorkerId } = stealth
        ? await sessionManager.createTargetStealth(sessionId, targetUrl, workerId, stealthSettleMs)
        : await sessionManager.createTarget(sessionId, targetUrl, workerId);

      AdaptiveScreenshot.getInstance().reset(targetId);
      const [newTabSummary, newTabBlocking] = await Promise.all([
        generateVisualSummary(page),
        Promise.race([
          detectBlockingPage(page),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
        ]).catch(e => { console.error('[navigate] detectBlockingPage error (new-tab):', e); return null; }),
      ]);
      // Get element count for SPA readiness visibility
      let newTabElementCount = 0;
      try {
        newTabElementCount = await withTimeout(
          page.evaluate(() => document.querySelectorAll('*').length),
          3000, 'elementCount'
        );
      } catch {
        // Non-critical — proceed without count
      }
      const newTabResultText = JSON.stringify({
        action: 'navigate',
        url: page.url(),
        title: await safeTitle(page),
        tabId: targetId,
        workerId: assignedWorkerId,
        created: true,
        elementCount: newTabElementCount,
        ...(newTabSummary && { visualSummary: newTabSummary }),
        ...(newTabBlocking && { blockingPage: newTabBlocking }),
      });
      return {
        content: [{ type: 'text', text: newTabResultText }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const isTimeout = errMsg.includes('timeout') || errMsg.includes('Timeout');
      return {
        content: [
          {
            type: 'text',
            text: isTimeout
              ? `Navigation timed out — the page at ${url} did not finish loading within 30s. The page may still be loading. Try read_page to check if content is available, or retry navigation.`
              : `Error creating tab: ${errMsg}`,
          },
        ],
        isError: !isTimeout,
      };
    }
  }

  // tabId is required for history navigation
  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required for back/forward navigation' }],
      isError: true,
    };
  }

  try {
    // Validate target is still valid
    if (!await sessionManager.isTargetValid(tabId)) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} is no longer available` }],
        isError: true,
      };
    }

    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'navigate');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Handle history navigation
    if (url === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
      AdaptiveScreenshot.getInstance().reset(tabId);
      const [backSummary, backBlocking] = await Promise.all([
        generateVisualSummary(page),
        Promise.race([
          detectBlockingPage(page),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
        ]).catch(e => { console.error('[navigate] detectBlockingPage error (back):', e); return null; }),
      ]);
      // Get element count for SPA readiness visibility
      let backElementCount = 0;
      try {
        backElementCount = await withTimeout(
          page.evaluate(() => document.querySelectorAll('*').length),
          3000, 'elementCount'
        );
      } catch {
        // Non-critical — proceed without count
      }
      const backResultText = JSON.stringify({
        action: 'back',
        url: page.url(),
        title: await safeTitle(page),
        elementCount: backElementCount,
        ...(backSummary && { visualSummary: backSummary }),
        ...(backBlocking && { blockingPage: backBlocking }),
      });
      return {
        content: [{ type: 'text', text: backResultText }],
      };
    }

    if (url === 'forward') {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
      AdaptiveScreenshot.getInstance().reset(tabId);
      const [fwdSummary, fwdBlocking] = await Promise.all([
        generateVisualSummary(page),
        Promise.race([
          detectBlockingPage(page),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
        ]).catch(e => { console.error('[navigate] detectBlockingPage error (forward):', e); return null; }),
      ]);
      // Get element count for SPA readiness visibility
      let fwdElementCount = 0;
      try {
        fwdElementCount = await withTimeout(
          page.evaluate(() => document.querySelectorAll('*').length),
          3000, 'elementCount'
        );
      } catch {
        // Non-critical — proceed without count
      }
      const fwdResultText = JSON.stringify({
        action: 'forward',
        url: page.url(),
        title: await safeTitle(page),
        elementCount: fwdElementCount,
        ...(fwdSummary && { visualSummary: fwdSummary }),
        ...(fwdBlocking && { blockingPage: fwdBlocking }),
      });
      return {
        content: [{ type: 'text', text: fwdResultText }],
      };
    }

    // Normalize URL
    let targetUrl = url;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    // Validate URL
    try {
      const parsedUrl = new URL(targetUrl);

      // Only allow http and https protocols
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Invalid protocol "${parsedUrl.protocol}". Only http and https are allowed.`,
            },
          ],
          isError: true,
        };
      }

      // Check for valid hostname
      if (!parsedUrl.hostname || parsedUrl.hostname.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Invalid URL - missing hostname',
            },
          ],
          isError: true,
        };
      }
    } catch (urlError) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Invalid URL format - ${urlError instanceof Error ? urlError.message : 'malformed URL'}`,
          },
        ],
        isError: true,
      };
    }

    // Domain blocklist check on normalized URL (existing-tab path)
    assertDomainAllowed(targetUrl);

    // Navigate with smart auth redirect detection
    const { authRedirect } = await smartGoto(page, targetUrl, { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });

    // Auth redirect = fail-fast with clear error
    if (authRedirect) {
      AdaptiveScreenshot.getInstance().reset(tabId);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            action: 'navigate',
            url: page.url(),
            title: await safeTitle(page),
            authRedirect: true,
            redirectedFrom: authRedirect.from,
            authRedirectHost: authRedirect.host,
            message: 'ACTION_REQUIRED: Authentication redirect detected — page redirected from ' + authRedirect.from + ' to ' + authRedirect.host +
              '. The user must log in manually in their Chrome browser. ' +
              'Inform the user and wait for confirmation before retrying navigation. ' +
              'Do NOT attempt to authenticate programmatically.',
          }),
        }],
        isError: false,
      };
    }

    AdaptiveScreenshot.getInstance().reset(tabId);
    const [navSummary, navBlocking] = await Promise.all([
      generateVisualSummary(page),
      Promise.race([
        detectBlockingPage(page),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
      ]).catch(e => { console.error('[navigate] detectBlockingPage error (existing-tab):', e); return null; }),
    ]);
    // Get element count for SPA readiness visibility
    let navElementCount = 0;
    try {
      navElementCount = await withTimeout(
        page.evaluate(() => document.querySelectorAll('*').length),
        3000, 'elementCount'
      );
    } catch {
      // Non-critical — proceed without count
    }
    const navResultText = JSON.stringify({
      action: 'navigate',
      url: page.url(),
      title: await safeTitle(page),
      elementCount: navElementCount,
      ...(navSummary && { visualSummary: navSummary }),
      ...(navBlocking && { blockingPage: navBlocking }),
    });
    return {
      content: [{ type: 'text', text: navResultText }],
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const isTimeout = errMsg.includes('timeout') || errMsg.includes('Timeout');
    return {
      content: [
        {
          type: 'text',
          text: isTimeout
            ? `Navigation timed out — the page did not finish loading within 30s. The page may still be loading or the server may be unresponsive. Try read_page to check if content is available, or retry navigation.`
            : `Navigation error: ${errMsg}`,
        },
      ],
      isError: !isTimeout,
    };
  }
};

export function registerNavigateTool(server: MCPServer): void {
  server.registerTool('navigate', handler, definition, { timeoutRecoverable: true });
}
