/**
 * Non-CAPTCHA gate detection (B2-PR2 of #1359).
 *
 * Pure DOM/URL heuristics that surface common access gates the host agent
 * should reason about before proceeding:
 *
 *   - SSO redirect: the page has navigated to an identity provider login.
 *   - Paywall: a subscription/metered overlay is blocking the content.
 *   - Two-factor: an OTP / verification-code input is the foreground form.
 *
 * Each detector is **read-only** and **fact-only** (#1359 P4). It returns
 * either the structured signal it observed or `null`. None of these
 * detectors makes a network call, evaluates host-controlled credentials,
 * or attempts to bypass the gate. The MCP tool `oc_gate_inspect` composes
 * these detectors after the CAPTCHA detector so the host can decide what
 * to do with the result.
 *
 * Known gaps recorded as comments below:
 *   - HTTP Basic auth: not reliably DOM-detectable (the browser shows a
 *     native dialog). Use HTTP response status + WWW-Authenticate header
 *     parsing at the network layer instead — out of scope for this PR.
 */

import type { Page } from 'puppeteer-core';

export type NonCaptchaGateKind = 'sso' | 'paywall' | '2fa';

export type SsoProvider =
  | 'microsoft'
  | 'google'
  | 'okta'
  | 'auth0'
  | 'github'
  | 'apple'
  | 'generic';

export interface SsoSignal {
  kind: 'sso';
  gateType: 'sso_redirect';
  provider: SsoProvider;
  pageUrl: string;
}

export interface PaywallSignal {
  kind: 'paywall';
  gateType: 'paywall';
  /** CSS-style selector that triggered the match. */
  selector: string;
  pageUrl: string;
}

export interface TwoFactorSignal {
  kind: '2fa';
  gateType: 'two_factor';
  /** CSS-style selector for the OTP input that triggered the match. */
  selector: string;
  pageUrl: string;
}

export type NonCaptchaGateSignal = SsoSignal | PaywallSignal | TwoFactorSignal;

// ─── SSO ──────────────────────────────────────────────────────────────────

/** Known identity-provider host patterns. Order is not significant. */
const SSO_PROVIDERS: Array<{ provider: SsoProvider; hostPattern: RegExp }> = [
  { provider: 'microsoft', hostPattern: /(?:login\.microsoftonline\.com|login\.live\.com)/i },
  { provider: 'google', hostPattern: /accounts\.google\.com/i },
  { provider: 'okta', hostPattern: /\.okta\.com$/i },
  { provider: 'auth0', hostPattern: /\.auth0\.com$/i },
  { provider: 'github', hostPattern: /github\.com\/login/i },
  { provider: 'apple', hostPattern: /appleid\.apple\.com/i },
];

/**
 * Generic SSO URL hints — any of these path/query fragments are a strong
 * signal even when the host is not in the provider table.
 */
const SSO_PATH_HINTS = [
  '/sso',
  '/saml',
  '/oauth',
  '/oauth2',
  '/openid',
  '/openid-connect',
  '/authorize',
  '/auth/realms', // Keycloak
];

export function detectSsoSignalFromUrl(rawUrl: string): SsoSignal | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  // 1. Known provider host match — strongest signal.
  for (const { provider, hostPattern } of SSO_PROVIDERS) {
    if (hostPattern.test(parsed.host) || hostPattern.test(parsed.href)) {
      return { kind: 'sso', gateType: 'sso_redirect', provider, pageUrl: rawUrl };
    }
  }

  // 2. Generic SSO path hint — provider unknown, but the URL still says
  //    the user is mid-auth.
  const lowerPath = parsed.pathname.toLowerCase();
  for (const hint of SSO_PATH_HINTS) {
    if (lowerPath.startsWith(hint) || lowerPath.includes(hint)) {
      return { kind: 'sso', gateType: 'sso_redirect', provider: 'generic', pageUrl: rawUrl };
    }
  }

  return null;
}

export async function detectSso(page: Page): Promise<SsoSignal | null> {
  let url: string;
  try {
    url = page.url();
  } catch {
    return null;
  }
  return detectSsoSignalFromUrl(url);
}

// ─── Paywall ──────────────────────────────────────────────────────────────

/**
 * Paywall selector list. Each entry is a CSS selector that publishers use
 * to gate content. Worst-case false positives only deliver a "paywall
 * detected" fact to the host — the host still has to decide what to do,
 * which is the right place for that judgment.
 */
const PAYWALL_SELECTORS = [
  '.paywall',
  '#paywall',
  '.subscription-overlay',
  '.subscription-wall',
  '.metered-wall',
  '.tp-modal',                  // Piano / Tinypass
  '.tp-backdrop',
  '.zephr-paywall',             // Zephr
  '[data-paywall]',
  '[data-subscription-required]',
];

function paywallProbe(selectors: string[]): { selector: string } | null {
  for (const sel of selectors) {
    const node = document.querySelector(sel) as HTMLElement | null;
    if (!node) continue;
    // Quick "is this actually visible-ish?" check. We bail on display:none
    // / hidden attribute / zero box to avoid matching dead markup left in
    // the page template by the publisher's CMS.
    const style = (node.ownerDocument && node.ownerDocument.defaultView)
      ? node.ownerDocument.defaultView.getComputedStyle(node)
      : null;
    const hidden = node.hidden
      || (style && (style.display === 'none' || style.visibility === 'hidden'))
      || (node.offsetWidth === 0 && node.offsetHeight === 0);
    if (!hidden) return { selector: sel };
  }
  return null;
}

export async function detectPaywall(page: Page): Promise<PaywallSignal | null> {
  let url: string;
  try {
    url = page.url();
  } catch {
    url = 'unknown';
  }
  try {
    const match = await page.evaluate(paywallProbe, PAYWALL_SELECTORS);
    if (!match) return null;
    return { kind: 'paywall', gateType: 'paywall', selector: match.selector, pageUrl: url };
  } catch {
    return null;
  }
}

// ─── Two-factor ───────────────────────────────────────────────────────────

/**
 * OTP / verification-code input selectors. The `autocomplete="one-time-code"`
 * attribute is the strongest signal (it's defined by the HTML spec for
 * exactly this purpose). The remaining selectors catch the long tail of
 * naming conventions across login flows.
 */
const TWOFA_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name="otp"]',
  'input[name="otp_code"]',
  'input[name="one_time_code"]',
  'input[name="verification_code"]',
  'input[name="totp"]',
  'input[name="2fa_code"]',
  'input[id="otp"]',
  'input[id="verification-code"]',
  'input[inputmode="numeric"][maxlength="6"]',
];

function twoFactorProbe(selectors: string[]): { selector: string } | null {
  for (const sel of selectors) {
    const node = document.querySelector(sel) as HTMLInputElement | null;
    if (node) return { selector: sel };
  }
  return null;
}

export async function detectTwoFactor(page: Page): Promise<TwoFactorSignal | null> {
  let url: string;
  try {
    url = page.url();
  } catch {
    url = 'unknown';
  }
  try {
    const match = await page.evaluate(twoFactorProbe, TWOFA_SELECTORS);
    if (!match) return null;
    return { kind: '2fa', gateType: 'two_factor', selector: match.selector, pageUrl: url };
  } catch {
    return null;
  }
}

// ─── Composer ─────────────────────────────────────────────────────────────

/**
 * Run the non-CAPTCHA detectors in priority order and return the first
 * positive signal. Used by `oc_gate_inspect` after CAPTCHA detection. The
 * order — SSO → paywall → 2FA — reflects how the host would typically
 * reason about a gate: an SSO redirect means "you're no longer on the
 * target site"; a paywall means "you're on the site but blocked"; a 2FA
 * prompt means "you're authenticating right now."
 */
export async function detectNonCaptchaGate(
  page: Page,
): Promise<NonCaptchaGateSignal | null> {
  const sso = await detectSso(page);
  if (sso) return sso;
  const paywall = await detectPaywall(page);
  if (paywall) return paywall;
  const twoFactor = await detectTwoFactor(page);
  if (twoFactor) return twoFactor;
  return null;
}
