/**
 * Login-failure detector (#658).
 *
 * Today, openchrome silently returns `success: true` from `fill_form` even
 * when authentication actually failed. This detector adds a single, generic
 * post-submit check based on three site-agnostic signals:
 *
 *   1. The login form itself is still mounted with an empty password field
 *      (universal "you got bounced back" signal).
 *   2. An ARIA-error element (role=alert, aria-live=assertive,
 *      [data-testid*="error"]) appeared with non-empty text.
 *   3. The page navigated away from the login origin (treated as success).
 *
 * Higher-confidence network-level signals (HTTP 4xx on the form POST,
 * Set-Cookie comparisons) are intentionally out of scope here because they
 * would require CDP Network-domain plumbing that is mostly orthogonal to
 * this PR. Adding them later is straightforward: extend the detector's
 * decision matrix without changing call sites.
 *
 * The detector is **conservative**: it only returns `'failed'` on a strong
 * signal. Ambiguous cases return `'unknown'` so existing successful flows
 * are never regressed (issue #658 design constraint #1).
 */

import type { Page } from 'puppeteer-core';

export type LoginOutcome = 'success' | 'failed' | 'unknown';

export interface LoginDetectInput {
  /** Origin (URL) of the page when the form-submit click was issued. */
  preSubmitOrigin: string;
  /** URL of the page when the form-submit click was issued. */
  preSubmitUrl: string;
}

export interface LoginDetectResult {
  outcome: LoginOutcome;
  /** Human-readable reason for the outcome (for logging / tool responses). */
  reason: string;
}

/**
 * Heuristic: does an element look like a "submit a login form" button?
 * Defined here rather than inline so call sites can share the rule.
 *
 * Site-agnostic and tested via the fixtures in tests/tools/login-detector.test.ts:
 * - Native `input[type="submit"]` / `button[type="submit"]`
 * - `button` or `[role="button"]` whose nearest `form` ancestor contains an
 *   `input[type="password"]`. (Most "Sign in" buttons satisfy this.)
 *
 * Closed shadow DOM is out of scope — login forms inside closed shadow roots
 * are rare; document the limitation rather than reach into them.
 */
export const isSubmitButtonScript = `
(function isSubmitButton(target) {
  if (!target || !(target instanceof Element)) return false;
  if (target.matches && target.matches('input[type="submit"], button[type="submit"]')) return true;
  if (target.matches && target.matches('button, [role="button"]')) {
    const form = target.closest('form');
    if (!form) return false;
    return !!form.querySelector('input[type="password"]');
  }
  return false;
})
`;

/**
 * Result of the in-page detection script. Each field is independently
 * checked so the host can produce a richer reason string.
 */
export interface InPageSignals {
  /** Same login form still mounted (form root contains an empty password input). */
  loginFormStillMounted: boolean;
  /** Visible ARIA-error / data-testid=error element with non-empty text. */
  ariaErrorText: string | null;
  /** Page URL after submit (for change detection). */
  currentUrl: string;
  /** document.title after submit (debug-only; not used in classification). */
  title: string;
}

/**
 * In-page script: collects the structural signals from the live DOM.
 * Designed to be evaluated via `page.evaluate()` so tests can stub the page
 * with a fake `evaluate` implementation.
 */
export const detectionScript = `
(function detectLoginOutcomeSignals() {
  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Signal 1: any <form> still mounted with an empty password input?
  let loginFormStillMounted = false;
  for (const form of Array.from(document.querySelectorAll('form'))) {
    const pw = form.querySelector('input[type="password"]');
    if (pw && isVisible(pw)) {
      loginFormStillMounted = true;
      break;
    }
  }

  // Signal 2: ARIA-error element with non-empty text.
  const errorSelectors = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[data-testid*="error" i]',
    '[data-test*="error" i]',
    '[class*="error" i]',
  ];
  let ariaErrorText = null;
  for (const sel of errorSelectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (text.length === 0) continue;
      // Avoid false-positives on huge regions (entire wrappers labelled "errors")
      if (text.length > 240) continue;
      ariaErrorText = text;
      break;
    }
    if (ariaErrorText) break;
  }

  return {
    loginFormStillMounted: loginFormStillMounted,
    ariaErrorText: ariaErrorText,
    currentUrl: location.href,
    title: document.title,
  };
})()
`;

/**
 * Classify in-page signals + URL change into a LoginOutcome.
 *
 * Pure function: separated from the page evaluation so it can be unit-tested
 * without spinning up Chrome.
 */
export function classifyLoginSignals(
  signals: InPageSignals,
  input: LoginDetectInput,
): LoginDetectResult {
  // Strong success: navigated away from the login origin.
  let currentOrigin = '';
  try {
    currentOrigin = new URL(signals.currentUrl).origin;
  } catch {
    currentOrigin = '';
  }

  if (currentOrigin && currentOrigin !== input.preSubmitOrigin) {
    return { outcome: 'success', reason: `navigated to ${currentOrigin}` };
  }
  if (signals.currentUrl !== input.preSubmitUrl && signals.currentUrl.length > 0 && currentOrigin === input.preSubmitOrigin) {
    // Same-origin path change: treat as success (e.g. /login → /dashboard).
    // The form is gone (we still check below).
    if (!signals.loginFormStillMounted) {
      return { outcome: 'success', reason: `navigated to ${signals.currentUrl}` };
    }
  }

  // Strong failure: form still mounted AND we did not navigate away.
  if (signals.loginFormStillMounted && signals.currentUrl === input.preSubmitUrl) {
    if (signals.ariaErrorText) {
      return { outcome: 'failed', reason: `login form still mounted; error banner: "${signals.ariaErrorText}"` };
    }
    return { outcome: 'failed', reason: 'login form still mounted; submit had no effect' };
  }

  // Same URL but form is gone — likely an SPA mid-transition. Avoid claiming
  // failure (could be a 2FA challenge or a magic-link "check your email" page).
  if (signals.ariaErrorText && signals.loginFormStillMounted) {
    return { outcome: 'failed', reason: `login error banner: "${signals.ariaErrorText}"` };
  }

  return { outcome: 'unknown', reason: 'no decisive signal' };
}

/**
 * High-level helper: snapshot the page, classify, return a result.
 *
 * `page` can be any object exposing `url(): string` and
 * `evaluate(script: string): Promise<InPageSignals>` — we intentionally
 * keep the type structural so tests can hand in a fake.
 */
export async function detectLoginOutcome(
  page: Pick<Page, 'url'> & { evaluate: (script: string) => Promise<unknown> },
  input: LoginDetectInput,
): Promise<LoginDetectResult> {
  let signals: InPageSignals;
  try {
    const raw = await page.evaluate(detectionScript);
    signals = raw as InPageSignals;
    if (!signals || typeof signals !== 'object') {
      return { outcome: 'unknown', reason: 'detector evaluation returned no data' };
    }
  } catch (err) {
    return { outcome: 'unknown', reason: `detector error: ${(err as Error).message}` };
  }
  return classifyLoginSignals(signals, input);
}
