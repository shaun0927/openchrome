/**
 * Navigate Tool - Navigate to URLs
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget, throwIfAborted } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { smartGoto } from '../utils/smart-goto';
import { safeTitle } from '../utils/safe-title';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';
import { generateVisualSummary } from '../utils/visual-summary';
import { AdaptiveScreenshot } from '../utils/adaptive-screenshot';
import { assertDomainAllowed } from '../security/domain-guard';
import { detectBlockingPage, BlockingInfo } from '../utils/page-diagnostics';
import { handleCaptcha } from '../captcha/handler';
import { getSolverRegistry } from '../captcha/solver-registry';
import { withTimeout } from '../utils/with-timeout';
import { simulatePresence } from '../stealth/human-behavior';
import { getHeadedFallback } from '../chrome/headed-fallback';
import { getGlobalConfig } from '../config/global';
import { autoRecallForUrl } from '../core/skill-memory/auto-recall';
import type { Page } from 'puppeteer-core';

/** Blocking types that warrant automatic stealth retry (#459) */
const RETRYABLE_BLOCK_TYPES: ReadonlySet<string> = new Set(['access-denied', 'bot-check', 'captcha']);

/** Build CAPTCHA metadata fields for navigate responses (#574) */
function buildCaptchaFields(blocking: BlockingInfo | null): Record<string, unknown> {
  if (!blocking || blocking.type !== 'captcha') return {};
  return {
    captcha_detected: true,
    ...(blocking.captchaType && { captcha_type: blocking.captchaType }),
    ...(blocking.captchaSiteKey && { captcha_site_key: blocking.captchaSiteKey }),
  };
}

type BlockingDetectionResult =
  | { ok: true; blocking: BlockingInfo | null }
  | { ok: false; reason: 'detector-error' | 'timeout'; error: string };

const BLOCKING_DETECT_TIMEOUT_MS = 5000;

function blockingDetectionErrorFields(result: BlockingDetectionResult): Record<string, unknown> {
  if (result.ok) return {};
  return {
    blockingDetection: {
      ok: false,
      reason: result.reason,
      error: result.error,
    },
  };
}

async function detectBlockingPageBounded(page: Page): Promise<BlockingDetectionResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<BlockingDetectionResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          reason: 'timeout',
          error: `detectBlockingPage exceeded ${BLOCKING_DETECT_TIMEOUT_MS}ms`,
        });
      }, BLOCKING_DETECT_TIMEOUT_MS);
    });
    const detection = detectBlockingPage(page).then<BlockingDetectionResult>((blocking) => ({
      ok: true,
      blocking,
    }));
    return await Promise.race([detection, timeout]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[navigate] detectBlockingPage error:', error);
    return { ok: false, reason: 'detector-error', error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

interface AuthRedirectGuidance {
  authRedirect: true;
  authRedirectKind: 'same-site-login';
  redirectedFrom: string;
  authRedirectUrl: string;
  authRedirectHost: string;
  recommendedNextAction: string;
  message: string;
}

function isLikelyLoginUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  return /(^|\/)(login|signin|sign-in|auth)(\/|$)/.test(path);
}

function sameSiteAuthRedirectGuidance(requestedUrl: string, finalUrl: string, title: string): AuthRedirectGuidance | null {
  try {
    const requested = new URL(requestedUrl);
    const final = new URL(finalUrl);
    if (requested.origin !== final.origin) return null;
    if (requested.pathname === final.pathname) return null;

    const loginTitle = /\b(log[ -]?in|sign[ -]?in|authentication)\b/i.test(title);
    if (!isLikelyLoginUrl(final) && !loginTitle) return null;

    return {
      authRedirect: true,
      authRedirectKind: 'same-site-login',
      redirectedFrom: requestedUrl,
      authRedirectUrl: finalUrl,
      authRedirectHost: final.hostname,
      recommendedNextAction: 'Open the same URL with headed: true and the same profileDirectory, let the user complete login, then retry headless with that persistent profile.',
      message: 'ACTION_REQUIRED: Same-site login redirect detected. The requested page resolved to a login/authentication page. Use headed mode with the same persistent profile for the user login step; do not keep retrying unauthenticated headless navigation.',
    };
  } catch {
    return null;
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
  const [summary, blockingDetection] = await Promise.all([
    (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
    detectBlockingPageBounded(page),
  ]);
  const blocking = blockingDetection.ok ? blockingDetection.blocking : null;

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
    ...buildCaptchaFields(blocking),
    ...(blocking && { blockingPage: blocking }),
    ...blockingDetectionErrorFields(blockingDetection),
  });
  // Tier 3: escalate to headed Chrome if stealth retry also got blocked
  // OR if stealth produced an empty/broken page (can't detect blocking in broken pages).
  // This is safe because we only reach here after Tier 1 already detected a block. (#459)
  const stealthBlocked = blocking && RETRYABLE_BLOCK_TYPES.has(blocking.type);
  const stealthBroken = elementCount === 0 || readiness.readyState === 'unknown';
  // Try CAPTCHA solver before escalating to headed Chrome (#574)
  if (stealthBlocked && blocking?.type === 'captcha' && getSolverRegistry().isAutoSolveEnabled()) {
    const solveResult = await handleCaptcha(page, blocking);
    if (solveResult.solved) {
      console.error(`[navigate] CAPTCHA solved via ${getSolverRegistry().getProviderName()} in ${solveResult.solveTimeMs}ms`);
      const postSolveSummary = await generateVisualSummary(page).catch(() => null);
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
        captcha_solved: true,
        captcha_type: solveResult.captchaType,
        captcha_solve_time_ms: solveResult.solveTimeMs,
        ...(postSolveSummary && { visualSummary: postSolveSummary }),
      });
      return { content: [{ type: 'text', text: resultText }] };
    }
    console.error(`[navigate] CAPTCHA solve failed: ${solveResult.error}, escalating to Tier 3`);
  }
  if (autoFallbackToHeaded && (stealthBlocked || stealthBroken)) {
    const headedResult = await headedAutoRetry(targetUrl, blocking || blockingInfo, sessionId, profileDirectory);
    if (headedResult) return headedResult;
  }

  return { content: [{ type: 'text', text: resultText }] };
}

/** Worker ID used for unprofiled headed fallback tabs */
const HEADED_WORKER_ID = 'headed';

/**
 * Worker ID for headed pages that were opened with a Chrome profile.
 * Keep this distinct from `profile:<directory>` headless workers because those
 * may already be bound to a profile ChromePool port. Headed pages are indexed
 * into the main CDP client by registerHeadedPage(), so mixing them with a
 * port-bound profile worker sends later tool calls to the wrong CDP client.
 */
function headedWorkerId(profileDirectory?: string): string {
  return profileDirectory ? `headed:profile:${profileDirectory}` : HEADED_WORKER_ID;
}

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
  profileDirectory?: string,
): Promise<MCPResult | null> {
  const headedFallback = getHeadedFallback(getGlobalConfig().port);
  if (!headedFallback.isAvailable()) {
    console.error('[navigate] Tier 3 skipped: no display available for headed Chrome');
    return null;
  }

  console.error(`[navigate] Auto-fallback Tier 3: stealth also blocked (${blockingInfo.type}), retrying in headed Chrome...`);

  try {
    // Use persistent navigation so the page stays alive for tool interaction (#485)
    const result = await headedFallback.navigatePersistent(targetUrl, profileDirectory);
    let tabId: string | undefined;
    let assignedWorkerId: string | undefined;

    // Register the headed tab in the session manager for full tool interoperability.
    // Instead of creating a second CDPClient for the headed Chrome port (which causes
    // a dual-connection conflict), we inject the page directly into the main CDPClient's
    // targetIdIndex. This way all tools (read_page, interact, screenshot) work. (#485)
    if (sessionId) {
      try {
        const sessionManager = getSessionManager();

        const resolvedWorkerId = headedWorkerId(profileDirectory);

        // Create/reuse the headed worker WITH the headed Chrome port so that
        // getCDPClientForWorker() routes CDP commands to the correct instance. (#561)
        // Profile-scoped headed fallback pages are managed by HeadedFallbackManager
        // and indexed into the session directly, so do not pass port/profileDirectory
        // or SessionManager would launch a second ChromePool instance. (#562, #671)
        const headedPort = headedFallback.getPort();
        await sessionManager.getOrCreateWorker(sessionId, resolvedWorkerId, {
          shareCookies: true,
          ...(!profileDirectory && { port: headedPort }),
        });

        // Get the live Page object from HeadedFallbackManager and register it
        const page = headedFallback.getPage(result.targetId);
        if (page) {
          sessionManager.registerHeadedPage(result.targetId, sessionId, resolvedWorkerId, page);
        } else {
          // Fallback: register without page injection (navigation-only, no tool access)
          sessionManager.registerExternalTarget(result.targetId, sessionId, resolvedWorkerId);
        }

        tabId = result.targetId;
        assignedWorkerId = resolvedWorkerId;
        console.error(`[navigate] Headed tab registered: tabId=${tabId.slice(0, 8)}... workerId=${resolvedWorkerId}`);
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
      ...(profileDirectory && { profileDirectory }),
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
    const resolvedWorkerId = headedWorkerId(options.profileDirectory);

    if (sessionId) {
      try {
        const sessionManager = getSessionManager();
        const headedPort = headedFallback.getPort();

        await sessionManager.getOrCreateWorker(sessionId, resolvedWorkerId, {
          shareCookies: true,
          // Don't pass port or profileDirectory for profile-scoped headed pages —
          // they are managed by HeadedFallbackManager and indexed via
          // registerHeadedPage() into the main CDPClient. Passing profileDirectory
          // would trigger ChromePool; reusing `profile:<dir>` would route later
          // tool calls to a port-bound headless profile worker. (#562, #671)
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

async function withDomainSkillsResult(
  result: MCPResult,
  recallArg: boolean | undefined,
): Promise<MCPResult> {
  if (result.isError) return result;
  const first = result.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;

  try {
    const payload = JSON.parse(first.text) as Record<string, unknown>;
    if (payload.domain_skills !== undefined || typeof payload.url !== 'string') return result;
    const domainSkills = await autoRecallForUrl(payload.url, recallArg);
    if (domainSkills === undefined) return result;
    return {
      ...result,
      content: [{ ...first, text: JSON.stringify({ ...payload, domain_skills: domainSkills }) }],
    };
  } catch {
    return result;
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
      recall: {
        type: 'boolean',
        description: 'Override OPENCHROME_AUTO_RECALL for this call. true forces domain skill injection; false suppresses it even when the flag is on.',
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
  throwIfAborted(context);
  const tabId = args.tabId as string | undefined;
  const url = args.url as string;
  const profileDirectory = args.profileDirectory as string | undefined;
  const recallArg = args.recall as boolean | undefined;
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
        if (headedResult) return await withDomainSkillsResult(headedResult, recallArg);
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
              return await withDomainSkillsResult({
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
              }, recallArg);
            }
            AdaptiveScreenshot.getInstance().reset(existingTabId);
            const [summary, reuseBlockingDetection] = await Promise.all([
              (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
              detectBlockingPageBounded(page),
            ]);
            const reuseBlocking = reuseBlockingDetection.ok ? reuseBlockingDetection.blocking : null;
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
              return await withDomainSkillsResult(
                await stealthAutoRetry(sessionId, targetUrl, workerId, stealthSettleMs, profileDirectory, reuseBlocking, undefined, autoFallback, context),
                recallArg,
              );
            }

            const reuseUrl = page.url();
            const reuseTitle = await safeTitle(page);
            const reuseAuthGuidance = sameSiteAuthRedirectGuidance(targetUrl, reuseUrl, reuseTitle);
            const reuseDomainSkills = await autoRecallForUrl(reuseUrl, recallArg);
            const reuseResultText = JSON.stringify({
              action: 'navigate',
              url: reuseUrl,
              title: reuseTitle,
              tabId: existingTabId,
              workerId: resolvedWorkerId,
              reused: true,
              elementCount: reuseElementCount,
              readiness: reuseReadiness,
              ...(summary && { visualSummary: summary }),
              ...buildCaptchaFields(reuseBlocking),
              ...(reuseBlocking && { blockingPage: reuseBlocking }),
              ...blockingDetectionErrorFields(reuseBlockingDetection),
              ...(reuseAuthGuidance ?? {}),
              ...(reuseDomainSkills !== undefined && { domain_skills: reuseDomainSkills }),
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
      const [newTabSummary, newTabBlockingDetection] = await Promise.all([
        (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
        detectBlockingPageBounded(page),
      ]);
      const newTabBlocking = newTabBlockingDetection.ok ? newTabBlockingDetection.blocking : null;
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
        return await withDomainSkillsResult(
          await stealthAutoRetry(sessionId, targetUrl, workerId, stealthSettleMs, profileDirectory, newTabBlocking, targetId, autoFallback, context),
          recallArg,
        );
      }

      // When explicit stealth hits a block, escalate directly to tier 3 (headed Chrome)
      // since tier 2 (stealth) is already being used. (#453)
      if (newTabBlocking && stealth && autoFallback && RETRYABLE_BLOCK_TYPES.has(newTabBlocking.type)) {
        const headedResult = await headedAutoRetry(targetUrl, newTabBlocking, sessionId, profileDirectory);
        if (headedResult) return await withDomainSkillsResult(headedResult, recallArg);
      }

      const newTabUrl = page.url();
      const newTabTitle = await safeTitle(page);
      const newTabAuthGuidance = sameSiteAuthRedirectGuidance(targetUrl, newTabUrl, newTabTitle);
      const newTabDomainSkills = await autoRecallForUrl(newTabUrl, recallArg);
      const newTabResultText = JSON.stringify({
        action: 'navigate',
        url: newTabUrl,
        title: newTabTitle,
        tabId: targetId,
        workerId: assignedWorkerId,
        created: true,
        elementCount: newTabElementCount,
        readiness: newTabReadiness,
        ...(stealth && { stealth: true }),
        ...(newTabSummary && { visualSummary: newTabSummary }),
        ...buildCaptchaFields(newTabBlocking),
        ...(newTabBlocking && { blockingPage: newTabBlocking }),
        ...blockingDetectionErrorFields(newTabBlockingDetection),
        ...(newTabAuthGuidance ?? {}),
        ...(newTabDomainSkills !== undefined && { domain_skills: newTabDomainSkills }),
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
      const [backSummary, backBlockingDetection] = await Promise.all([
        (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
        detectBlockingPageBounded(page),
      ]);
      const backBlocking = backBlockingDetection.ok ? backBlockingDetection.blocking : null;
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
        ...buildCaptchaFields(backBlocking),
        ...(backBlocking && { blockingPage: backBlocking }),
        ...blockingDetectionErrorFields(backBlockingDetection),
        ...(stealthIgnoredWarning && { warning: stealthIgnoredWarning }),
      });
      return {
        content: [{ type: 'text', text: backResultText }],
      };
    }

    if (url === 'forward') {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
      AdaptiveScreenshot.getInstance().reset(tabId);
      const [fwdSummary, fwdBlockingDetection] = await Promise.all([
        (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
        detectBlockingPageBounded(page),
      ]);
      const fwdBlocking = fwdBlockingDetection.ok ? fwdBlockingDetection.blocking : null;
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
        ...buildCaptchaFields(fwdBlocking),
        ...(fwdBlocking && { blockingPage: fwdBlocking }),
        ...blockingDetectionErrorFields(fwdBlockingDetection),
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
      return await withDomainSkillsResult({
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
      }, recallArg);
    }

    AdaptiveScreenshot.getInstance().reset(tabId);
    const [navSummary, navBlockingDetection] = await Promise.all([
      (context && !hasBudget(context, 5_000)) ? Promise.resolve(null) : generateVisualSummary(page),
      detectBlockingPageBounded(page),
    ]);
    const navBlocking = navBlockingDetection.ok ? navBlockingDetection.blocking : null;
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
    const navFinalUrl = page.url();
    const navFinalTitle = await safeTitle(page);
    const navDomainSkills = await autoRecallForUrl(navFinalUrl, recallArg);
    const navResultText = JSON.stringify({
      action: 'navigate',
      url: navFinalUrl,
      title: navFinalTitle,
      elementCount: navElementCount,
      readiness: navReadiness,
      ...(navSummary && { visualSummary: navSummary }),
      ...buildCaptchaFields(navBlocking),
      ...(navBlocking && { blockingPage: navBlocking }),
      ...blockingDetectionErrorFields(navBlockingDetection),
      ...(stealthIgnoredWarning && { warning: stealthIgnoredWarning }),
      ...(navDomainSkills !== undefined && { domain_skills: navDomainSkills }),
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
            return await withDomainSkillsResult({
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
            }, recallArg);
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
