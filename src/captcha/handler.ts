/**
 * CAPTCHA Handler (#574)
 *
 * Orchestrates the full CAPTCHA solving flow:
 * detect → extract site key → submit to solver → inject solution → verify
 *
 * Integrates with the navigate fallback chain and domain memory.
 */

import type { Page } from 'puppeteer-core';
import type { BlockingInfo } from '../utils/page-diagnostics';
import { detectCaptcha } from './detect';
import { getSolverRegistry, waitForSolverReady } from './solver-registry';
import { injectSolution } from './inject-solution';
import { getDomainMemory, extractDomainFromUrl } from '../memory/domain-memory';

export interface CaptchaHandleResult {
  solved: boolean;
  captchaType: string;
  solveTimeMs?: number;
  costUsd?: number;
  error?: string;
}

/**
 * Attempt to solve a CAPTCHA on the given page.
 * Returns the result of the attempt.
 */
export async function handleCaptcha(
  page: Page,
  blockingInfo: BlockingInfo,
): Promise<CaptchaHandleResult> {
  // Ensure solver is fully initialized before checking configuration
  await waitForSolverReady();
  const registry = getSolverRegistry();

  // Check if solver is available
  if (!registry.isConfigured()) {
    return {
      solved: false,
      captchaType: blockingInfo.captchaType || 'unknown',
      error: 'No CAPTCHA solver configured',
    };
  }

  // Use already-captured data from blockingInfo when available to avoid
  // redundant CDP round-trips and TOCTOU issues. Fall back to detectCaptcha
  // only when the site key is missing from blockingInfo.
  const captchaType = blockingInfo.captchaType || 'unknown';
  let siteKey: { key: string; source: string } | null = null;

  if (blockingInfo.captchaSiteKey) {
    siteKey = { key: blockingInfo.captchaSiteKey, source: 'blockingInfo' };
  } else {
    const detection = await detectCaptcha(page);
    if (!detection) {
      return {
        solved: false,
        captchaType,
        error: 'CAPTCHA detection failed during solve attempt',
      };
    }
    siteKey = detection.siteKey ?? null;
  }

  // Check if solver supports this type
  if (!registry.canSolve(captchaType as any)) {
    return {
      solved: false,
      captchaType,
      error: `Solver does not support ${captchaType}`,
    };
  }

  // Need site key for solving
  if (!siteKey) {
    return {
      solved: false,
      captchaType,
      error: 'Could not extract site key from CAPTCHA',
    };
  }

  // Record CAPTCHA encounter in domain memory
  let pageUrl: string;
  try { pageUrl = page.url(); } catch { pageUrl = 'unknown'; }
  const domain = extractDomainFromUrl(pageUrl);
  if (domain) {
    const memory = getDomainMemory();
    memory.record(domain, 'captcha:type', captchaType);
    memory.record(domain, 'captcha:encountered', new Date().toISOString());
  }

  try {
    // Submit to solver
    const result = await registry.solve({
      captchaType: captchaType as any,
      siteKey: siteKey.key,
      pageUrl,
      invisible: false,
    });

    // Inject solution into page
    const injected = await injectSolution(page, captchaType as any, result.token);

    if (!injected) {
      if (domain) {
        getDomainMemory().record(domain, 'captcha:inject_failed', 'true');
      }
      return {
        solved: false,
        captchaType,
        solveTimeMs: result.solveTimeMs,
        costUsd: result.costUsd,
        error: 'Solution obtained but injection failed',
      };
    }

    // Wait for the page to process the solution, then verify dismissal
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Post-injection verification: confirm the CAPTCHA is actually dismissed
    const { detectBlockingPage } = await import('../utils/page-diagnostics');
    const stillBlocked = await detectBlockingPage(page).catch(() => null);
    if (stillBlocked?.type === 'captcha') {
      if (domain) {
        getDomainMemory().record(domain, 'captcha:inject_failed', 'verification');
      }
      return {
        solved: false,
        captchaType,
        solveTimeMs: result.solveTimeMs,
        costUsd: result.costUsd,
        error: 'Token injected but CAPTCHA still present after verification',
      };
    }

    // Record success in domain memory
    if (domain) {
      const memory = getDomainMemory();
      memory.record(domain, 'captcha:solved', 'true');
      memory.record(domain, 'captcha:solver_provider', registry.getProviderName() || 'unknown');
    }

    return {
      solved: true,
      captchaType,
      solveTimeMs: result.solveTimeMs,
      costUsd: result.costUsd,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[CaptchaSolver] Solve failed for ${captchaType}: ${errorMsg}`);

    // Record failure in domain memory
    if (domain) {
      getDomainMemory().record(domain, 'captcha:solve_failed', errorMsg);
    }

    return {
      solved: false,
      captchaType,
      error: errorMsg,
    };
  }
}

/**
 * Check domain memory for known CAPTCHA sites.
 * Returns the known CAPTCHA type if the domain has been seen before.
 */
export function checkDomainCaptchaHistory(url: string): string | null {
  const domain = extractDomainFromUrl(url);
  if (!domain) return null;

  const memory = getDomainMemory();
  const entries = memory.query(domain, 'captcha:type');
  if (entries.length > 0 && entries[0].confidence >= 0.3) {
    return entries[0].value;
  }
  return null;
}
