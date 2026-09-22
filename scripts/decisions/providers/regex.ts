/**
 * `regex` provider — the repository's existing heuristics, called directly.
 *
 *   element      -> src/dom/element-finder.ts `scoreElement` over view.targets
 *   outcome      -> src/recovery/ralph/outcome-classifier.ts `classifyOutcome`
 *   irreversible -> src/security/tool-risk-policy.ts `evaluateToolRiskPolicy`
 *   gate         -> src/gates/detect-other-gates.ts `detectSsoSignalFromUrl` for
 *                   the URL half; the DOM-bound probes (bot check, paywall, 2FA)
 *                   run inside `page.evaluate` in the source module and cannot
 *                   be imported without a Page, so their substring / selector
 *                   lists are re-implemented here minimally over the excerpts.
 *
 * Confidence values are fixed per branch (heuristics have no probability);
 * they exist so the calibration table has something to bin.
 */

import { scoreElement, tokenizeQuery, normalizeQuery } from '../../../src/dom/element-finder';
import type { FoundElement } from '../../../src/dom/element-finder';
import { classifyOutcome } from '../../../src/recovery/ralph/outcome-classifier';
import { evaluateToolRiskPolicy } from '../../../src/security/tool-risk-policy';
import { detectSsoSignalFromUrl } from '../../../src/gates/detect-other-gates';
import type {
  DecisionCase, ElementInput, GateInput, IrreversibleInput, OutcomeInput,
} from '../../../tests/fixtures/decisions/schema';
import type { DecisionProvider, ProviderAnswer } from './types';
import { abstain, clamp01 } from './types';

/**
 * Minimum `scoreElement` score to pick a target rather than abstain.
 * Note: scoreElement adds an unconditional +20 for interactive roles, so any
 * view containing a button/link/etc. always clears this floor; the provider
 * can only abstain on views made of non-interactive targets. That is the
 * heuristic's real behaviour and the corpus is meant to expose it.
 */
export const ELEMENT_MIN_SCORE = 10;

const ROLE_TO_TAG: Record<string, string> = {
  button: 'button', link: 'a', textbox: 'input', searchbox: 'input', checkbox: 'input', radio: 'input',
  combobox: 'select', listbox: 'select', textarea: 'textarea',
};

function toFoundElement(target: ElementInput['view']['targets'][number], index: number): FoundElement {
  const role = target.role || 'generic';
  return {
    backendDOMNodeId: index,
    role,
    name: target.name ?? '',
    tagName: ROLE_TO_TAG[role] ?? 'div',
    type: role === 'checkbox' || role === 'radio' ? role : undefined,
    textContent: target.value || undefined,
    // Neutral box (no size bonus, no small-element penalty): the corpus records
    // no geometry, so only name/role tokens may contribute to the score.
    rect: { x: 0, y: 0, width: 20, height: 20 },
    score: 0,
  };
}

export function decideElement(input: ElementInput): ProviderAnswer {
  const queryLower = normalizeQuery(input.query);
  const tokens = tokenizeQuery(input.query);
  let best: { ref: string; score: number } | undefined;
  const scores: Record<string, number> = {};
  input.view.targets.forEach((t, i) => {
    const score = scoreElement(toFoundElement(t, i), queryLower, tokens);
    scores[t.ref] = score;
    if (!best || score > best.score) best = { ref: t.ref, score };
  });
  if (!best || best.score < ELEMENT_MIN_SCORE) return abstain({ scores });
  return { answer: best.ref, confidence: clamp01(best.score / 100), abstain: false, raw: { scores } };
}

export function decideOutcome(input: OutcomeInput): ProviderAnswer {
  const outcome = classifyOutcome(input.delta, input.target_role);
  const empty = !input.delta || input.delta.trim().length === 0;
  return { answer: outcome, confidence: empty ? 0.8 : 0.6, abstain: false, raw: { empty } };
}

export function decideIrreversible(input: IrreversibleInput): ProviderAnswer {
  const allowedDomains = Array.isArray(input.page_context.allowedDomains)
    ? (input.page_context.allowedDomains as unknown[]).filter((d): d is string => typeof d === 'string')
    : undefined;
  // A bare call: no dry-run, no elicitation, no checkpoint. The policy answers
  // with what it would demand first, which is what the label records.
  const result = evaluateToolRiskPolicy({ tool: input.tool, args: input.args, allowedDomains });
  const confidence = result.policy.risk === 'read_only' ? 0.9 : result.policy.trigger ? 0.7 : 0.5;
  return { answer: result.decision, confidence, abstain: false, raw: { risk: result.policy.risk, reason: result.reason } };
}

// Substring lists mirrored from detect-other-gates.ts probes (which are
// page.evaluate bodies and therefore not importable without a Page).
const BOT_TEXT = [
  'verify you are human',
  'checking if the site connection is secure',
  'review the security of your connection',
  'please stand by, while we are checking your browser',
  'bot protection',
  'automated access',
];
const BOT_TITLE = ['security check', 'robot check'];
const WAF_MARKERS = ['cloudflare', 'cf_chl_', 'challenges.cloudflare.com'];
const PAYWALL_MARKERS = [
  'paywall', 'subscription-overlay', 'subscription-wall', 'metered-wall', 'tp-modal', 'tp-backdrop',
  'zephr-paywall', 'data-paywall', 'data-subscription-required',
];
const TWOFA_HTML = [
  'autocomplete="one-time-code"', 'name="otp"', 'name="otp_code"', 'name="one_time_code"',
  'name="verification_code"', 'name="totp"', 'name="2fa_code"', 'id="otp"', 'id="verification-code"',
];
const TWOFA_TEXT = ['verification code', 'one-time code', 'authentication code', 'enter the code we sent'];
const LOGIN_TEXT = ['sign in', 'log in', 'login', 'password'];
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

export function decideGate(input: GateInput): ProviderAnswer {
  const title = input.title.toLowerCase();
  const text = input.text_excerpt.toLowerCase();
  const html = (input.html_excerpt ?? '').toLowerCase();
  const any = `${text}\n${html}`;

  if (title.includes('just a moment') && (text.includes('cloudflare') || html.includes('cf_chl_'))) {
    return { answer: 'bot_check', confidence: 0.9, abstain: false, raw: { rule: 'title:just-a-moment' } };
  }
  const hasSecurityTitle = BOT_TITLE.some((s) => title.includes(s));
  const hasBotText = BOT_TEXT.some((s) => text.includes(s));
  const hasWaf = WAF_MARKERS.some((s) => html.includes(s));
  if (hasSecurityTitle || (hasBotText && hasWaf)) {
    return { answer: 'bot_check', confidence: 0.8, abstain: false, raw: { rule: hasSecurityTitle ? 'title:bot-check' : 'text:bot-check' } };
  }

  for (const url of `${input.text_excerpt}\n${input.html_excerpt ?? ''}`.match(URL_RE) ?? []) {
    const sso = detectSsoSignalFromUrl(url);
    if (sso) return { answer: 'login', confidence: 0.8, abstain: false, raw: { rule: 'sso-url', provider: sso.provider, url } };
    if (/\/(login|signin|sign-in|log-in)\b/i.test(url)) {
      return { answer: 'login', confidence: 0.6, abstain: false, raw: { rule: 'login-path', url } };
    }
  }

  if (PAYWALL_MARKERS.some((s) => html.includes(s))) {
    return { answer: 'paywall', confidence: 0.7, abstain: false, raw: { rule: 'paywall-marker' } };
  }
  if (TWOFA_HTML.some((s) => html.includes(s)) || TWOFA_TEXT.some((s) => text.includes(s))) {
    return { answer: 'two_factor', confidence: 0.7, abstain: false, raw: { rule: '2fa' } };
  }
  if ((title.includes('sign in') || title.includes('log in') || title.includes('login')) || (any.includes('password') && LOGIN_TEXT.some((s) => any.includes(s)))) {
    return { answer: 'login', confidence: 0.5, abstain: false, raw: { rule: 'login-text' } };
  }
  return { answer: 'none', confidence: 0.4, abstain: false, raw: { rule: 'no-match' } };
}

export function createRegexProvider(): DecisionProvider {
  return {
    name: 'regex',
    async decide(c: DecisionCase): Promise<ProviderAnswer> {
      switch (c.kind) {
        case 'element': return decideElement(c.input);
        case 'outcome': return decideOutcome(c.input);
        case 'irreversible': return decideIrreversible(c.input);
        case 'gate': return decideGate(c.input);
      }
    },
  };
}
