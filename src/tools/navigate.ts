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
import { simulatePresence } from '../stealth/human-behavior';
import type { Page } from 'puppeteer-core';

/** Compute readiness data for navigate responses. Non-critical — returns defaults on failure. */
async function getReadiness(page: Page): Promise<{ readyState: string; domStable: boolean; framework: string }> {
  try {
    const readyState = await withTimeout(page.evaluate(() => document.readyState), 3000, 'readyState');
    let framework = 'none';
    try {
      framework = await withTimeout(page.evaluate(() => {
        if ((window as any).__NEXT_DATA__ || document.querySelector('#__next')) return 'next';
        if ((window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]')) return 'react';
        if ((window as any).__VUE__) return 'vue';
        if ((window as any).__ANGULAR_DEVTOOLS_BACKEND_API__) return 'angular';
        return 'none';
      }), 2000, 'framework');
    } catch { /* ignore */ }
    return { readyState, domStable: true, framework };
  } catch {
    return { readyState: 'unknown', domStable: false, framework: 'unknown' };
  }
}

const definition: MCPToolDefinition = {
  name: 'navigate',
  description: 'Navigate to URL or go forward/back. Omit tabId for new tab.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID. Omit for new tab',
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
        description: 'How long to wait (ms) before attaching CDP in stealth mode. Default: 8000. Range: 1000-30000.',
      },
      profileDirectory: {
        type: 'string',
        description: 'Chrome profile directory name (e.g., "Profile 1"). Use list_profiles to see available profiles. Launches a separate Chrome instance for each profile. If omitted, uses the server default. Cannot be combined with workerId.',
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
  const profileDirectory = args.profileDirectory as string | undefined;
  // P1-6: reject workerId + profileDirectory combination
  if (args.workerId && profileDirectory) {
    return {
      content: [{ type: 'text', text: 'Error: workerId and profileDirectory cannot be used together. Use profileDirectory alone (a worker is auto-created per profile).' }],
      isError: true,
    };
  }
  // Auto-generate a profile-scoped workerId when profileDirectory is specified
  const workerId = (args.workerId as string | undefined) || (profileDirectory ? `profile:${profileDirectory}` : undefined);
  const stealth = args.stealth as boolean | undefined;
  const stealthSettleMs = Math.min(Math.max((args.stealthSettleMs as number) || 8000, 1000), 30000);
  const stealthIgnoredWarning = stealth && tabId ? 'stealth mode only works when creating new tabs (omit tabId). The stealth parameter was ignored for this navigation.' : undefined;
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
      // Detect non-http schemes before normalization to prevent https:// prepending
      const schemeMatch = targetUrl.match(/^([a-z][a-z0-9+.-]*):\/\//i);
      if (schemeMatch && !['http', 'https'].includes(schemeMatch[1].toLowerCase())) {
        return {
          content: [{
            type: 'text',
            text: `Navigation error: "${schemeMatch[1]}://" URLs are not supported. Only http:// and https:// URLs can be navigated.`,
          }],
          isError: true,
        };
      }
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
      if (existingTargets.length === 1 && !stealth) {
        const existingTabId = existingTargets[0];
        if (await sessionManager.isTargetValid(existingTabId)) {
          const page = await sessionManager.getPage(sessionId, existingTabId, undefined, 'navigate');
          if (page) {
            const { authRedirect } = await withTimeout(
              smartGoto(page, targetUrl, { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }),
              DEFAULT_NAVIGATION_TIMEOUT_MS + 5000,
              `navigate to ${targetUrl}`
            );
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
            const reuseReadiness = await getReadiness(page);
            const reuseResultText = JSON.stringify({
              action: 'navigate',
              url: page.url(),
              title: await safeTitle(page),
              tabId: existingTabId,
              workerId: resolvedWorkerId,
              reused: true,
              elementCount: reuseElementCount,
              readiness: reuseReadiness,
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
        ? await sessionManager.createTargetStealth(sessionId, targetUrl, workerId, stealthSettleMs, profileDirectory)
        : await sessionManager.createTarget(sessionId, targetUrl, workerId, profileDirectory);

      // Stealth mode: simulate human presence to generate behavioral telemetry
      // that enterprise anti-bot sensors (Radware, PerimeterX, Akamai) require.
      if (stealth) {
        await simulatePresence(page);
      }

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
      const newTabReadiness = await getReadiness(page);
      const newTabResultText = JSON.stringify({
        action: 'navigate',
        url: page.url(),
        title: await safeTitle(page),
        tabId: targetId,
        workerId: assignedWorkerId,
        created: true,
        elementCount: newTabElementCount,
        readiness: newTabReadiness,
        ...(stealth && { stealth: true }),
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
              ? `Navigation timed out — the page at ${url} did not finish loading within 30s. The page may still be partially loaded. Try read_page to check if content is available, or retry navigation.`
              : `Error creating tab: ${errMsg}`,
          },
        ],
        isError: true,
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
      const available = await sessionManager.getAvailableTargets(sessionId);
      const availableInfo = available.length > 0
        ? `\nAvailable tabs:\n${available.map(t => `  - tabId: ${t.tabId} | ${t.url} | ${t.title}`).join('\n')}`
        : '\nNo tabs available. Call navigate without tabId to create a new tab.';
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.${availableInfo}` }],
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
        ...(stealthIgnoredWarning && { warning: stealthIgnoredWarning }),
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
        ...(stealthIgnoredWarning && { warning: stealthIgnoredWarning }),
      });
      return {
        content: [{ type: 'text', text: fwdResultText }],
      };
    }

    // Normalize URL
    let targetUrl = url;
    // Detect non-http schemes before normalization to prevent https:// prepending
    const schemeMatch = targetUrl.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (schemeMatch && !['http', 'https'].includes(schemeMatch[1].toLowerCase())) {
      return {
        content: [{
          type: 'text',
          text: `Navigation error: "${schemeMatch[1]}://" URLs are not supported. Only http:// and https:// URLs can be navigated.`,
        }],
        isError: true,
      };
    }
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
    const { authRedirect } = await withTimeout(
      smartGoto(page, targetUrl, { timeout: DEFAULT_NAVIGATION_TIMEOUT_MS }),
      DEFAULT_NAVIGATION_TIMEOUT_MS + 5000,
      `navigate to ${targetUrl}`
    );

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
    const navReadiness = await getReadiness(page);
    const navResultText = JSON.stringify({
      action: 'navigate',
      url: page.url(),
      title: await safeTitle(page),
      elementCount: navElementCount,
      readiness: navReadiness,
      ...(navSummary && { visualSummary: navSummary }),
      ...(navBlocking && { blockingPage: navBlocking }),
      ...(stealthIgnoredWarning && { warning: stealthIgnoredWarning }),
    });
    return {
      content: [{ type: 'text', text: navResultText }],
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const isTimeout = errMsg.includes('timeout') || errMsg.includes('Timeout');

    if (isTimeout && tabId) {
      // Check if the page has usable content despite timeout
      try {
        const timeoutPage = await sessionManager.getPage(sessionId, tabId, undefined, 'navigate');
        if (timeoutPage) {
          const timeoutReadiness = await getReadiness(timeoutPage);
          let timeoutElementCount = 0;
          try {
            timeoutElementCount = await withTimeout(
              timeoutPage.evaluate(() => document.querySelectorAll('*').length),
              3000, 'elementCount'
            );
          } catch { /* ignore */ }

          const hasContent = (timeoutReadiness.readyState === 'interactive' || timeoutReadiness.readyState === 'complete') && timeoutElementCount > 10;
          if (hasContent) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  action: 'navigate',
                  url: timeoutPage.url(),
                  title: await safeTitle(timeoutPage),
                  tabId,
                  elementCount: timeoutElementCount,
                  readiness: { ...timeoutReadiness, domStable: false },
                  warning: 'Navigation load event timed out, but page has usable content. Proceed with caution.',
                }),
              }],
            };
          }
        }
      } catch { /* page might be gone — fall through to error */ }
    }

    return {
      content: [
        {
          type: 'text',
          text: isTimeout
            ? `Navigation timed out — the page did not finish loading within 30s. The page may still be partially loaded or the server may be unresponsive. Try read_page to check if content is available, or retry navigation.`
            : `Navigation error: ${errMsg}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerNavigateTool(server: MCPServer): void {
  server.registerTool('navigate', handler, definition, { timeoutRecoverable: true });
}
