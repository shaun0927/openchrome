import type { FailureCategory, FailureClassification } from './categories.js';

export interface ClassifyFailureInput {
  /** Error object, string, or arbitrary thrown value. */
  error?: unknown;
  /** Optional explicit message/result text when no Error object exists. */
  message?: string;
  /** Tool that produced the failure, if known. */
  toolName?: string;
  /** HintEngine rule name, if classification is driven by a hint. */
  hintRule?: string;
  /** Current URL/title can add context for auth and WAF ambiguity. */
  currentUrl?: string;
  pageTitle?: string;
  /** When true, return UNKNOWN if no pattern matches. Defaults to true. */
  fallbackToUnknown?: boolean;
}

interface Rule {
  category: FailureCategory;
  confidence: number;
  reason: string;
  test(input: NormalizedFailureInput): boolean;
}

interface NormalizedFailureInput {
  text: string;
  errorName: string;
  toolName: string;
  hintRule: string;
  currentUrl: string;
  pageTitle: string;
}

const AUTH_CONTEXT = /\b(login|log in|signin|sign in|auth|authentication|password|credential|permission|mfa|2fa|totp|session expired)\b/i;
const WAF_CONTEXT = /\b(captcha|cloudflare|akamai|imperva|datadome|human verification|verify you are human|bot[- ]?check|anti[- ]?bot|ip block|request block|access denied|just a moment)\b/i;

const RULES: Rule[] = [
  {
    category: 'STALE_REF',
    confidence: 0.95,
    reason: 'Reference is stale or invalid after page changes',
    test: ({ text }) => /\b(stale ref|invalid ref|ref\b.+not found|backendnodeid.+not found|node is detached|no node with given id)\b/i.test(text),
  },
  {
    category: 'CONNECTION_LOST',
    confidence: 0.95,
    reason: 'CDP/browser transport connection was lost',
    test: ({ text }) => /\b(not connected to chrome|call connect\(\) first|websocket.*closed|websocket is not open|browser has disconnected|browser disconnected|cdpsession connection closed|connection closed|session closed|protocol error.*(?:connection|closed|disconnected|target closed)|inspected target navigated or closed|puppeteer\.connect\(\) timed out|session initialization timed out)\b/i.test(text),
  },
  {
    category: 'BROWSER_CRASH',
    confidence: 0.92,
    reason: 'Browser process or renderer appears to have crashed',
    test: ({ text, errorName }) => /\b(browser crash|browser process.*dead|chrome process.*dead|renderer process.*gone|crashed)\b/i.test(`${errorName} ${text}`) || (/targetclosederror/i.test(errorName) && /\b(crash|crashed|browser)\b/i.test(text)),
  },
  {
    category: 'TAB_UNHEALTHY',
    confidence: 0.9,
    reason: 'Target tab is closed, missing, frozen, or unhealthy',
    test: ({ text }) => /\b(tab.+not found|target.+not found|invalid tab|no such tab|page closed|target closed|tab health probe timeout|tab.+unhealthy|eviction threshold)\b/i.test(text),
  },
  {
    category: 'NAVIGATION_TIMEOUT',
    confidence: 0.9,
    reason: 'Navigation or page-load wait timed out',
    test: ({ text, toolName }) => /\b(navigation timeout|page load timeout|waiting for navigation failed|net::err_timed_out|timeout.*navigation|timed out.*navigate|navigate.*timed out)\b/i.test(text) || (toolName === 'navigate' && /\b(timeout|timed out)\b/i.test(text)),
  },
  {
    category: 'ELEMENT_NOT_FOUND',
    confidence: 0.88,
    reason: 'Requested selector/ref/semantic element could not be found',
    test: ({ text }) => /\b(element not found|no elements? found|no matching element|selector.+not found|selector.+failed|queryselectorall.*(?:0|zero)|could not find|no good match found|no clickable elements found)\b/i.test(text),
  },
  {
    category: 'CAPTCHA_OR_WAF',
    confidence: 0.86,
    reason: 'Page indicates CAPTCHA, WAF, bot detection, or access-denied block',
    test: (input) => {
      const combined = `${input.text} ${input.currentUrl} ${input.pageTitle}`;
      if (!WAF_CONTEXT.test(combined)) return false;
      // Access denied is ambiguous. Treat it as auth only when auth context is present.
      if (/access denied/i.test(combined) && AUTH_CONTEXT.test(combined)) return false;
      return true;
    },
  },
  {
    category: 'AUTH_REQUIRED',
    confidence: 0.84,
    reason: 'Page or failure indicates missing/expired authentication or credentials',
    test: (input) => {
      const combined = `${input.text} ${input.currentUrl} ${input.pageTitle}`;
      return AUTH_CONTEXT.test(combined) || /\b(401|unauthorized|forbidden|please sign in|session expired)\b/i.test(combined);
    },
  },
  {
    category: 'NO_PROGRESS',
    confidence: 0.82,
    reason: 'Recent actions are stalling or made no meaningful progress',
    test: ({ text, hintRule }) => /\b(progress-tracker-stuck|progress-tracker-stalling|no meaningful progress|stalling|stuck|same-tool-same-result|tool-oscillation|coordinate-click-stall)\b/i.test(`${hintRule} ${text}`),
  },
  {
    category: 'LLM_WANDERING',
    confidence: 0.78,
    reason: 'Repeated low-value actions suggest agent wandering',
    test: ({ text, hintRule }) => /\b(wandering|oscillation|coordinate-click-stall|screenshot-verification-loop|same-tool-same-result|multiple coordinate clicks|multiple screenshots|escalation ladder)\b/i.test(`${hintRule} ${text}`),
  },
  {
    category: 'MAX_STEPS_EXCEEDED',
    confidence: 0.9,
    reason: 'Execution exceeded configured step or tool-call budget',
    test: ({ text }) => /\b(max steps|max number of|maximum steps|step limit|max iterations|max tool calls|budget exceeded)\b/i.test(text),
  },
  {
    category: 'POSTCONDITION_FAILED',
    confidence: 0.9,
    reason: 'Outcome contract or postcondition did not pass',
    test: ({ text }) => /\b(postcondition(?:_| )violation|postcondition failed|success criteria not met|contract.+failed|assertion failed|oc_assert.+failed)\b/i.test(text),
  },
];

export function classifyFailure(input: ClassifyFailureInput = {}): FailureClassification[] {
  const normalized = normalize(input);
  const found = new Map<FailureCategory, FailureClassification>();

  for (const rule of RULES) {
    if (!rule.test(normalized)) continue;
    const prev = found.get(rule.category);
    if (!prev || rule.confidence > prev.confidence) {
      found.set(rule.category, {
        category: rule.category,
        confidence: rule.confidence,
        reason: rule.reason,
      });
    }
  }

  const results = [...found.values()].sort((a, b) => b.confidence - a.confidence || a.category.localeCompare(b.category));
  if (results.length === 0 && input.fallbackToUnknown !== false) {
    return [{ category: 'UNKNOWN', confidence: 0.5, reason: 'No failure classifier rule matched' }];
  }
  return results;
}

export function primaryFailureCategory(input: ClassifyFailureInput = {}): FailureClassification {
  return classifyFailure(input)[0] ?? { category: 'UNKNOWN', confidence: 0.5, reason: 'No failure classifier rule matched' };
}

function normalize(input: ClassifyFailureInput): NormalizedFailureInput {
  const errorName = errorTypeName(input.error);
  const textParts = [
    stringifyError(input.error),
    input.message,
  ].filter(Boolean);
  return {
    text: textParts.join(' ').toLowerCase(),
    errorName: errorName.toLowerCase(),
    toolName: (input.toolName ?? '').toLowerCase(),
    hintRule: input.hintRule ?? '',
    currentUrl: input.currentUrl ?? '',
    pageTitle: input.pageTitle ?? '',
  };
}

function errorTypeName(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const ctor = (error as { constructor?: { name?: string } }).constructor?.name;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : ctor ?? '';
}

function stringifyError(error: unknown): string {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
