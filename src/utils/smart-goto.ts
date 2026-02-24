/**
 * Smart Goto - Wraps page.goto() with fast auth redirect detection.
 *
 * Instead of waiting 30s for a timeout on auth-redirected pages (e.g. Google Search Console),
 * detects redirects to known auth domains via `framenavigated` events within milliseconds
 * and returns useful information in ~2 seconds.
 */

import { Page, Frame, HTTPResponse } from 'puppeteer-core';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';

const AUTH_DOMAINS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'auth0.com',
  'okta.com',
  'login.salesforce.com',
  'appleid.apple.com',
  'github.com/login',
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
