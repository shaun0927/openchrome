/**
 * Navigate Tool - Navigate to URLs
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { smartGoto } from '../utils/smart-goto';
import { safeTitle } from '../utils/safe-title';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';
import { generateVisualSummary } from '../utils/visual-summary';
import { AdaptiveScreenshot } from '../utils/adaptive-screenshot';
import { assertDomainAllowed } from '../security/domain-guard';
import { detectBlockingPage, BlockingInfo } from '../utils/page-diagnostics';
import { withTimeout } from '../utils/with-timeout';
import { simulatePresence } from '../stealth/human-behavior';
import { getHeadedFallback } from '../chrome/headed-fallback';
import { getGlobalConfig } from '../config/global';
import type { Page } from 'puppeteer-core';

/** Blocking types that warrant automatic stealth retry (#459) */
const RETRYABLE_BLOCK_TYPES: ReadonlySet<string> = new Set(['access-denied', 'bot-check', 'captcha']);

/** Compute readiness data for navigate responses. Non-critical — returns defaults on failure. */
async function getReadiness(page: Page, context?: ToolContext): Promise<{ readyState: string; domStable: boolean; framework: string }> {
  try {
    const readyState = await withTimeout(page.evaluate(() => document.readyState), 3000, 'readyState', context);
    let framework = 'none';
    try {
      framework = await withTimeout(page.evaluate(() => {
        if ((window as any).__NEXT_DATA__ || document.querySelector('#__next')) return 'next';
        if ((window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]')) return 'react';
        if ((window as any).__VUE__) return 'vue';
        if ((window as any).__ANGULAR_DEVTOOLS_BACKEND_API__) return 'angular';
        return 'none';
      }), 2000, 'framework', context);
    } catch { /* ignore */ }
    return { readyState, domStable: true, framework };
  } catch {
    return { readyState: 'unknown', domStable: false, framework: 'unknown' };
  }
}

/**
 * Auto-fallback: retry navigation with stealth mode when a CDN/WAF block is detected.
 * Closes the original blocked tab (if just created), creates a new stealth tab,
 * and returns the result with fallbackTier/fallbackReason metadata. (#459)
 */
async function stealthAutoRetry(
  sessionId: string,
  targetUrl: string,
  workerId: string | undefined,
  stealthSettleMs: number,
  profileDirectory: string | undefined,
  blockingInfo: BlockingInfo,
  closeTabId?: string,
  autoFallbackToHeaded: boolean = false,
  context?: ToolContext,
): Promise<MCPResult> {
  const sessionManager = getSessionManager();

  if (closeTabId) {
    await sessionManager.closeTarget(sessionId, closeTabId).catch(() => {});
  }

  console.error(`[navigate] Auto-fallback: block detected (${blockingInfo.type}), retrying with stealth...`);

  const { targetId, page, workerId: assignedWorkerId } =
    await sessionManager.createTargetStealth(sessionId, targetUrl, workerId, stealthSettleMs, profileDirectory);

  await simulatePresence(page);

  AdaptiveScreenshot.getInstance().reset(targetId);
  const [summary, blocking] = await Promise.all([
    (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
    Promise.race([
      detectBlockingPage(page),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
    ]).catch(() => null),
  ]);

  let elementCount = 0;
  try {
    elementCount = await withTimeout(
      page.evaluate(() => document.querySelectorAll('*').length),
      3000, 'elementCount', context);
  } catch { /* non-critical */ }

  const readiness = await getReadiness(page, context);
  const resultText = JSON.stringify({
    action: 'navigate',
    url: page.url(),
    title: await safeTitle(page),
    tabId: targetId,
    workerId: assignedWorkerId,
    created: true,
    elementCount,
    readiness,
    stealth: true,
    fallbackTier: 2,
    fallbackReason: blockingInfo.type,
    ...(summary && { visualSummary: summary }),
    ...(blocking && { blockingPage: blocking }),
  });
  // Tier 3: escalate to headed Chrome if stealth retry also got blocked
  // OR if stealth produced an empty/broken page (can't detect blocking in broken pages).
  // This is safe because we only reach here after Tier 1 already detected a block. (#459)
  const stealthBlocked = blocking && RETRYABLE_BLOCK_TYPES.has(blocking.type);
  const stealthBroken = elementCount === 0 || readiness.readyState === 'unknown';
  if (autoFallbackToHeaded && (stealthBlocked || stealthBroken)) {
    const headedResult = await headedAutoRetry(targetUrl, blocking || blockingInfo, sessionId);
    if (headedResult) return headedResult;
  }

  return { content: [{ type: 'text', text: resultText }] };
}

/** Worker ID used for all headed fallback tabs */
const HEADED_WORKER_ID = 'headed';

/**
 * Tier 3 fallback: retry navigation in headed Chrome when stealth also fails.
 * Headed Chrome has a real user-agent and TLS fingerprint, bypassing CDN/WAF detection. (#459)
 * Returns null if headed fallback is not available (no display, no Chrome binary).
 *
 * When sessionId is provided, the headed tab is registered in the session manager
 * so subsequent tools (read_page, interact, screenshot) can access it. (#485)
 */
async function headedAutoRetry(
  targetUrl: string,
  blockingInfo: BlockingInfo,
  sessionId?: string,
): Promise<MCPResult | null> {
  const headedFallback = getHeadedFallback(getGlobalConfig().port);
  if (!headedFallback.isAvailable()) {
    console.error('[navigate] Tier 3 skipped: no display available for headed Chrome');
    return null;
  }

  console.error(`[navigate] Auto-fallback Tier 3: stealth also blocked (${blockingInfo.type}), retrying in headed Chrome...`);

  try {
    // Use persistent navigation so the page stays alive for tool interaction (#485)
    const result = await headedFallback.navigatePersistent(targetUrl);
    let tabId: string | undefined;
    let assignedWorkerId: string | undefined;

    // Register the headed tab in the session manager for full tool interoperability.
    // Instead of creating a second CDPClient for the headed Chrome port (which causes
    // a dual-connection conflict), we inject the page directly into the main CDPClient's
    // targetIdIndex. This way all tools (read_page, interact, screenshot) work. (#485)
    if (sessionId) {
      try {
        const sessionManager = getSessionManager();

        // Create/reuse the headed worker WITH the headed Chrome port so that
        // getCDPClientForWorker() routes CDP commands to the correct instance. (#561)
        const headedPort = headedFallback.getPort();
        await sessionManager.getOrCreateWorker(sessionId, HEADED_WORKER_ID, {
          shareCookies: true,
          port: headedPort,
        });

        // Get the live Page object from HeadedFallbackManager and register it
        const page = headedFallback.getPage(result.targetId);
        if (page) {
          sessionManager.registerHeadedPage(result.targetId, sessionId, HEADED_WORKER_ID, page);
        } else {
          // Fallback: register without page injection (navigation-only, no tool access)
          sessionManager.registerExternalTarget(result.targetId, sessionId, HEADED_WORKER_ID);
        }

        tabId = result.targetId;
        assignedWorkerId = HEADED_WORKER_ID;
        console.error(`[navigate] Headed tab registered: tabId=${tabId.slice(0, 8)}... workerId=${HEADED_WORKER_ID}`);
      } catch (regErr) {
        console.error('[navigate] Headed tab registration failed (page still accessible via headed Chrome):', regErr instanceof Error ? regErr.message : regErr);
      }
    }

    const resultText = JSON.stringify({
      action: 'navigate',
      url: result.url,
      title: result.title,
      ...(tabId && { tabId }),
      ...(assignedWorkerId && { workerId: assignedWorkerId }),
      created: true,
      elementCount: result.elementCount,
      headed: true,
      stealth: true,
      fallbackTier: 3,
      fallbackReason: blockingInfo.type,
      ...(result.blockingPage && { blockingPage: result.blockingPage }),
    });
    return { content: [{ type: 'text', text: resultText }] };
  } catch (err) {
    console.error('[navigate] Tier 3 headed fallback failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Direct headed navigation — user explicitly requested headed: true.
 * Unlike headedAutoRetry (Tier 3 fallback), this does NOT fabricate a BlockingInfo
 * and supports profileDirectory for cookie/session access. (#560, #562)
 */
async function headedNavigateDirect(
  targetUrl: string,
  sessionId: string | undefined,
  options: { profileDirectory?: string } = {},
): Promise<MCPResult | null> {
  const headedFallback = getHeadedFallback(getGlobalConfig().port);
  if (!headedFallback.isAvailable()) {
    return null;
  }

  console.error(`[navigate] User-requested headed mode${options.profileDirectory ? ` with profile "${options.profileDirectory}"` : ''}`);

  try {
    const result = await headedFallback.navigatePersistent(targetUrl, options.profileDirectory);
    let tabId: string | undefined;
    const resolvedWorkerId = options.profileDirectory
      ? `profile:${options.profileDirectory}`
      : HEADED_WORKER_ID;

    if (sessionId) {
      try {
        const sessionManager = getSessionManager();
        const headedPort = headedFallback.getPort();

        await sessionManager.getOrCreateWorker(sessionId, resolvedWorkerId, {
          shareCookies: true,
          // Don't pass port or profileDirectory — the headed page is managed by
          // HeadedFallbackManager and indexed via registerHeadedPage() into the
          // main CDPClient. Passing port would create a duplicate puppeteer
          // connection; passing profileDirectory would trigger ChromePool. (#562)
          ...(!options.profileDirectory && { port: headedPort }),
        });

        const page = headedFallback.getPage(result.targetId);
        if (page) {
          sessionManager.registerHeadedPage(result.targetId, sessionId, resolvedWorkerId, page);
        } else {
          sessionManager.registerExternalTarget(result.targetId, sessionId, resolvedWorkerId);
        }

        tabId = result.targetId;
      } catch (regErr) {
        console.error('[navigate] Headed tab registration failed:', regErr instanceof Error ? regErr.message : regErr);
      }
    }

    const resultText = JSON.stringify({
      action: 'navigate',
      url: result.url,
      title: result.title,
      ...(tabId && { tabId }),
      ...(resolvedWorkerId && { workerId: resolvedWorkerId }),
      created: true,
      elementCount: result.elementCount,
      headed: true,
      userRequested: true,
      ...(options.profileDirectory && { profileDirectory: options.profileDirectory }),
      ...(result.blockingPage && { blockingPage: result.blockingPage }),
    });
    return { content: [{ type: 'text', text: resultText }] };
  } catch (err) {
    console.error('[navigate] Headed navigation failed:', err instanceof Error ? err.message : err);
    return null;
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
      autoFallback: {
        type: 'boolean',
        description: 'Auto-retry with stealth when CDN/WAF block is detected (access-denied, bot-check, captcha). Default: true. Set false to disable.',
      },
      headed: {
        type: 'boolean',
        description: 'Force navigation in headed (non-headless) Chrome. Bypasses CDN/TLS-level blocking by using a real Chrome user-agent and TLS fingerprint. Requires a display. Default: false.',
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
  args: Record<string, unknown>,
  context?: ToolContext
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
  const autoFallback = args.autoFallback !== false; // default: true
  const headed = args.headed as boolean | undefined;
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

      // headed=true: skip headless entirely, navigate directly in headed Chrome.
      // Uses headedNavigateDirect() which does NOT fabricate a BlockingInfo. (#560, #561, #562)
      if (headed) {
        const headedResult = await headedNavigateDirect(targetUrl, sessionId, { profileDirectory });
        if (headedResult) return headedResult;
        return {
          content: [{ type: 'text', text: 'Error: headed mode requested but no display available for headed Chrome.' }],
          isError: true,
        };
      }

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
            , context);
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
              (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
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
              , context);
            } catch {
              // Non-critical — proceed without count
            }
            const reuseReadiness = await getReadiness(page, context);

            // Auto-fallback: if reused tab hit a CDN/WAF block, retry with stealth in a new tab (#459)
            if (reuseBlocking && autoFallback && RETRYABLE_BLOCK_TYPES.has(reuseBlocking.type)) {
              return stealthAutoRetry(sessionId, targetUrl, workerId, stealthSettleMs, profileDirectory, reuseBlocking, undefined, autoFallback, context);
            }

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
        (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
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
        , context);
      } catch {
        // Non-critical — proceed without count
      }
      const newTabReadiness = await getReadiness(page, context);

      // Auto-fallback: if new tab hit a CDN/WAF block and stealth wasn't already used, retry with stealth (#459)
      if (newTabBlocking && !stealth && autoFallback && RETRYABLE_BLOCK_TYPES.has(newTabBlocking.type)) {
        return stealthAutoRetry(sessionId, targetUrl, workerId, stealthSettleMs, profileDirectory, newTabBlocking, targetId, autoFallback, context);
      }

      // When explicit stealth hits a block, escalate directly to tier 3 (headed Chrome)
      // since tier 2 (stealth) is already being used. (#453)
      if (newTabBlocking && stealth && autoFallback && RETRYABLE_BLOCK_TYPES.has(newTabBlocking.type)) {
        const headedResult = await headedAutoRetry(targetUrl, newTabBlocking, sessionId);
        if (headedResult) return headedResult;
      }

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
        (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
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
        , context);
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
        (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
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
        , context);
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
    , context);

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
      (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
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
      , context);
    } catch {
      // Non-critical — proceed without count
    }
    const navReadiness = await getReadiness(page, context);
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
          const timeoutReadiness = await getReadiness(timeoutPage, context);
          let timeoutElementCount = 0;
          try {
            timeoutElementCount = await withTimeout(
              timeoutPage.evaluate(() => document.querySelectorAll('*').length),
              3000, 'elementCount'
            , context);
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
