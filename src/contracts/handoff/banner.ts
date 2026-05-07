/**
 * Handoff banner builder.
 *
 * Per #708 v2 the banner is injected via
 * `Page.addScriptToEvaluateOnNewDocument` and renders inside a CLOSED
 * shadow root attached to a custom element with a RANDOMIZED tag name.
 * This keeps the host site's CSS / scripts from accidentally (or
 * intentionally — adversarial sites) interfering with the banner UI.
 *
 * The banner posts the user's "Resume" click back to the local handoff
 * endpoint:
 *
 *   POST http://127.0.0.1:<port>/handoff/<txn_id>?token=<one-time>
 *
 * `port`, `txn_id`, and `token` are baked into the script at build time
 * (one-shot per handoff). The script does not embed any secret beyond
 * the single-use token.
 *
 * This file produces a JS string. Tests verify the produced source is
 * deterministic + escaped + idempotent on re-injection. Real-browser
 * injection lives in the manager (`./manager.ts`) which calls puppeteer.
 */

import * as crypto from 'node:crypto';

import type { HandoffEscalationReason } from './manager';

export interface BannerSpec {
  txnId: string;
  token: string;
  port: number;
  /** One-line summary shown at the top of the banner. */
  summary: string;
  /**
   * Reason category — drives the banner's color hint and the preset
   * "what to do" copy. The wire format mirrors the verdict taxonomy
   * subset that triggers a handoff.
   */
  reason: HandoffEscalationReason;
  /** Optional longer description (renders as a paragraph). */
  details?: string;
  /** Random tag suffix to avoid collisions. Pass for determinism in tests. */
  tagSuffix?: string;
}

/**
 * The randomized custom-element tag name used for the banner. Built
 * from the supplied `tagSuffix` or 8 random hex chars otherwise.
 */
export function bannerTagName(tagSuffix?: string): string {
  const suffix = tagSuffix ?? crypto.randomBytes(4).toString('hex');
  if (!/^[0-9a-f]+$/.test(suffix)) {
    throw new Error('bannerTagName: tagSuffix must be lowercase hex');
  }
  return `oc-handoff-${suffix}`;
}

/** Tiny JS-string-literal escape — preserves `'` while killing line breaks. */
function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the IIFE that creates the banner element + shadow root + click
 * handler. The output is meant to run via
 * `Page.addScriptToEvaluateOnNewDocument`, so it must be self-contained
 * and idempotent on repeated execution (re-injection on navigations).
 */
export function buildBannerScript(spec: BannerSpec): string {
  const tag = bannerTagName(spec.tagSuffix);
  const reasonClass = sanitizeReason(spec.reason);
  return [
    '(() => {',
    '  const TAG = ' + jsString(tag) + ';',
    '  if (window.customElements && window.customElements.get(TAG)) return;',
    '  const SUMMARY = ' + jsString(spec.summary) + ';',
    '  const DETAILS = ' + jsString(spec.details ?? '') + ';',
    '  const TXN = ' + jsString(spec.txnId) + ';',
    '  const TOKEN = ' + jsString(spec.token) + ';',
    '  const PORT = ' + JSON.stringify(spec.port) + ';',
    '  const REASON_CLASS = ' + jsString(reasonClass) + ';',
    '  class HandoffBanner extends HTMLElement {',
    '    constructor() { super(); }',
    '    connectedCallback() {',
    '      const root = this.attachShadow({ mode: "closed" });',
    '      const wrap = document.createElement("div");',
    '      wrap.setAttribute("data-reason", REASON_CLASS);',
    '      wrap.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 14px;font:14px ui-sans-serif,system-ui;color:#fff;background:#1f2937;border-bottom:3px solid #f59e0b;display:flex;gap:12px;align-items:center;justify-content:space-between";',
    '      const text = document.createElement("div");',
    '      const h = document.createElement("strong"); h.textContent = SUMMARY; text.appendChild(h);',
    '      if (DETAILS) { const p = document.createElement("div"); p.style.cssText = "opacity:.85;margin-top:2px;font-size:12px"; p.textContent = DETAILS; text.appendChild(p); }',
    '      const btn = document.createElement("button");',
    '      btn.textContent = "Resume";',
    '      btn.style.cssText = "background:#f59e0b;color:#1f2937;border:0;padding:6px 14px;border-radius:4px;font-weight:600;cursor:pointer";',
    '      btn.addEventListener("click", () => {',
    '        btn.disabled = true; btn.textContent = "Resuming…";',
    '        fetch("http://127.0.0.1:" + PORT + "/handoff/" + encodeURIComponent(TXN) + "?token=" + encodeURIComponent(TOKEN), { method: "POST", credentials: "omit", mode: "cors" })',
    '          .then((r) => { if (!r.ok) throw new Error("status " + r.status); btn.textContent = "Done"; setTimeout(() => host.remove(), 800); })',
    '          .catch((e) => { btn.disabled = false; btn.textContent = "Retry"; const err = document.createElement("span"); err.style.cssText = "color:#fbbf24;margin-left:8px;font-size:12px"; err.textContent = String(e.message || e); text.appendChild(err); });',
    '      });',
    '      wrap.appendChild(text); wrap.appendChild(btn);',
    '      root.appendChild(wrap);',
    '    }',
    '  }',
    '  window.customElements.define(TAG, HandoffBanner);',
    '  const host = document.createElement(TAG);',
    '  (document.body || document.documentElement).appendChild(host);',
    '})();',
  ].join('\n');
}

const VALID_REASONS = new Set<HandoffEscalationReason>([
  'manual_pause',
  'login_required',
  'two_factor',
  'fraud_review',
  'captcha_challenge',
  'identity_verification',
  'unknown',
]);

function sanitizeReason(reason: HandoffEscalationReason): HandoffEscalationReason {
  return VALID_REASONS.has(reason) ? reason : 'unknown';
}
