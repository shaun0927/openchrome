/**
 * oc_gate_inspect — fact-only gate detection.
 *
 * Inspect the current tab for a *gate* and return a structured fact record
 * describing what is present on the page. It **never** invokes any solver,
 * makes any third-party HTTP call, or asserts anything beyond what the DOM
 * directly observes.
 *
 * Gate families detected (B2-PR1 + B2-PR2 of #1359):
 *
 *   - `captcha`  — reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, AWS WAF.
 *   - `sso`      — redirect to a known identity provider OR a generic SSO
 *                  path (`/sso`, `/saml`, `/oauth`, `/openid`, `/authorize`).
 *   - `paywall`  — visible subscription/metered-content overlay.
 *   - `2fa`      — OTP / one-time-code input is foreground.
 *
 * Detection order is captcha → SSO → paywall → 2FA. The first positive
 * signal wins. Multiple gates can be present in practice, but the host
 * almost always reasons about them in that order anyway.
 *
 * Known gap: HTTP Basic auth is not detected here — it is a native browser
 * dialog with no DOM hook. Network-layer detection (401 status +
 * `WWW-Authenticate: Basic` header) is out of scope for this PR.
 *
 * Host-agent counterpart of #1359 Pillar C (facts before decisions). The
 * host reads the fact and decides what to do next.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { detectCaptcha } from '../captcha/detect';
import {
  detectNonCaptchaGate,
  type NonCaptchaGateKind,
  type SsoProvider,
} from '../gates/detect-other-gates';
import type { CaptchaType } from '../types/captcha';

/**
 * High-level family of gate. Closed union; adding a value is a non-breaking
 * change. Removing or renaming requires a tool version bump.
 */
export type GateKind = 'captcha' | NonCaptchaGateKind;

/**
 * Closed gate-type vocabulary. Adding a value is non-breaking.
 */
export type GateType = CaptchaType | 'sso_redirect' | 'paywall' | 'two_factor';

export interface OcGateInspectOutput {
  detected: boolean;
  /** The gate family. Absent iff `detected === false`. */
  kind?: GateKind;
  /** Specific gate type. Absent iff `detected === false`. */
  gateType?: GateType;

  // ── captcha-only ──────────────────────────────────────────────────────
  /** Captcha site key. Only present when a site key was extractable. */
  siteKey?: string;
  /** Provenance of the site key: which signal the detector read. */
  siteKeySource?: 'attribute' | 'script' | 'iframe';
  /** Whether the captcha is invisible/background (v3, invisible v2). */
  invisible?: boolean;

  // ── sso-only ──────────────────────────────────────────────────────────
  /** Identity provider name. Only present when kind === 'sso'. */
  provider?: SsoProvider;

  // ── paywall / 2fa ─────────────────────────────────────────────────────
  /** CSS selector that triggered the paywall or 2fa match. */
  selector?: string;

  /** The page URL observed at detection time. Always present. */
  pageUrl: string;
}

const definition: MCPToolDefinition = {
  name: 'oc_gate_inspect',
  description:
    'Detect whether the current tab is gated (CAPTCHA, SSO redirect, ' +
    'paywall, 2FA prompt). Returns facts only — never invokes any solver, ' +
    'never makes a third-party HTTP call, never bypasses the gate. The ' +
    'host agent decides what to do next.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'REQUIRED Tab ID to inspect.',
      },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.oc_gate_inspect,
};

function toResult(output: OcGateInspectOutput): MCPResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(output),
      },
    ],
  };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const tabId = typeof args.tabId === 'string' ? args.tabId : '';
  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();
  let page;
  try {
    // getPage may throw on ownership mismatch or stale targets in addition
    // to returning null when the tab is not found at all. Surface either
    // failure mode as a structured isError result rather than letting it
    // escape as an unhandled rejection.
    page = await sessionManager.getPage(sessionId, tabId, undefined, 'oc_gate_inspect');
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
  if (!page) {
    return {
      content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
      isError: true,
    };
  }

  let pageUrl = 'unknown';
  try {
    pageUrl = page.url();
  } catch {
    pageUrl = 'unknown';
  }

  // 1. CAPTCHA takes priority — it overlays the page even if the
  //    user is mid-SSO or behind a paywall, and the host typically
  //    needs to deal with it first.
  const captcha = await detectCaptcha(page);
  if (captcha) {
    const out: OcGateInspectOutput = {
      detected: true,
      kind: 'captcha',
      gateType: captcha.captchaType,
      invisible: captcha.invisible,
      pageUrl: captcha.pageUrl || pageUrl,
    };
    if (captcha.siteKey) {
      out.siteKey = captcha.siteKey.key;
      out.siteKeySource = captcha.siteKey.source;
    }
    return toResult(out);
  }

  // 2. Non-CAPTCHA gates in priority order (sso → paywall → 2fa).
  const other = await detectNonCaptchaGate(page);
  if (other) {
    const base: OcGateInspectOutput = {
      detected: true,
      kind: other.kind,
      gateType: other.gateType,
      pageUrl: other.pageUrl || pageUrl,
    };
    if (other.kind === 'sso') {
      base.provider = other.provider;
    } else {
      base.selector = other.selector;
    }
    return toResult(base);
  }

  // 3. No gate observed.
  return toResult({ detected: false, pageUrl });
};

export function registerOcGateInspectTool(server: MCPServer): void {
  server.registerTool('oc_gate_inspect', handler, definition);
}
