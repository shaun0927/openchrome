/**
 * Smart Goto - Wraps page.goto() with fast auth redirect detection.
 *
 * Instead of waiting 30s for a timeout on auth-redirected pages (e.g. Google Search Console),
 * detects redirects to known auth domains via `framenavigated` events within milliseconds
 * and returns useful information in ~2 seconds.
 */

import { Page, Frame, HTTPResponse } from 'puppeteer-core';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';

export interface DomStabilityResult {
  stable: boolean;
  elementCount: number;
  iterations: number;
}

/**
 * Wait for DOM element count to stabilize after initial page load.
 * SPA frameworks (React, Vue, Angular) render content asynchronously after
 * domcontentloaded — this heuristic detects when rendering is complete by
 * monitoring element count changes.
 *
 * Zero-cost on static pages (first check passes immediately).
 * Bounded to maxWaitMs (default 1500ms) total.
 */
export async function waitForDomStability(
  page: Page,
  options?: { intervalMs?: number; maxIterations?: number; threshold?: number },
): Promise<DomStabilityResult> {
  const intervalMs = options?.intervalMs ?? 500;
  const maxIterations = options?.maxIterations ?? 3;
  const threshold = options?.threshold ?? 0.2;

  let previousCount = 0;
  let iterations = 0;

  try {
    previousCount = await page.evaluate(() => document.querySelectorAll('*').length);
  } catch {
    return { stable: true, elementCount: 0, iterations: 0 };
  }

  for (let i = 0; i < maxIterations; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    iterations++;

    let currentCount = previousCount;
    try {
      currentCount = await page.evaluate(() => document.querySelectorAll('*').length);
    } catch {
      // Page navigated away or was closed — treat as stable
      return { stable: true, elementCount: previousCount, iterations };
    }

    const delta = Math.abs(currentCount - previousCount) / Math.max(previousCount, 1);
    if (delta <= threshold) {
      return { stable: true, elementCount: currentCount, iterations };
    }

    previousCount = currentCount;
  }

  return { stable: false, elementCount: previousCount, iterations };
}

const AUTH_DOMAINS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'auth0.com',
  'okta.com',
  'login.salesforce.com',
  'appleid.apple.com',
  'github.com/login',
  // Supabase
  'supabase.co/auth',
  'supabase.com/auth',
  // Firebase
  'firebaseapp.com/__/auth',
  'identitytoolkit.googleapis.com',
  // Other OAuth providers
  'cognito-idp.',
  'login.yahoo.com',
  'nid.naver.com',
  'kauth.kakao.com',
  'access.line.me',
];

export interface SmartGotoResult {
  response: HTTPResponse | null;
  authRedirect?: { from: string; to: string; host: string };
}

export async function smartGoto(
  page: Page,
  url: string,
  options?: { timeout?: number },
): Promise<SmartGotoResult> {
  const timeout = options?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  let authRedirect: SmartGotoResult['authRedirect'] = undefined;
  let resolveRedirect: (() => void) | null = null;

  const redirectDetected = new Promise<void>((resolve) => {
    resolveRedirect = resolve;
  });

  const onFrameNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    const currentUrl = frame.url();
    if (isAuthRedirect(currentUrl, url)) {
      authRedirect = {
        from: url,
        to: currentUrl,
        host: new URL(currentUrl).hostname,
      };
      resolveRedirect?.();
    }
  };

  page.on('framenavigated', onFrameNavigated);

  try {
    const response = await Promise.race([
      page.goto(url, { waitUntil: 'domcontentloaded', timeout }),
      // When auth redirect detected, wait 1.5s for DOMContentLoaded chance, then return
      redirectDetected.then(
        () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ),
    ]);

    // Only wait for DOM stability if no auth redirect was detected
    if (!authRedirect) {
      const stability = await waitForDomStability(page);
      // Log if DOM was still changing (useful for debugging SPA issues)
      if (!stability.stable) {
        console.error(
          `[smartGoto] DOM not stable after ${stability.iterations} checks (${stability.elementCount} elements)`,
        );
      }
    }

    return { response, authRedirect };
  } catch (err) {
    // If we already detected an auth redirect, return it instead of throwing
    if (authRedirect) return { response: null, authRedirect };
    throw err;
  } finally {
    page.off('framenavigated', onFrameNavigated);
  }
}

function isAuthRedirect(currentUrl: string, originalUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const original = new URL(originalUrl);
    if (current.hostname === original.hostname) return false;
    return (
      AUTH_DOMAINS.some((d) => current.hostname.includes(d)) ||
      /\/(login|signin|sign-in|auth|sso|oauth)/i.test(current.pathname)
    );
  } catch {
    return false;
  }
}
