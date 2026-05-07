/**
 * Synchronous Outcome Contract assertion evaluator.
 *
 * Takes a validated `Assertion` tree and an `AssertionContext` (page
 * snapshot probe + run metadata) and returns an `Evidence` envelope
 * describing whether the assertion held and why.
 *
 * The evaluator is intentionally sync: hosts (PR-11 runtime) collect a
 * snapshot from the live page once and pass it here. Tests can supply
 * fakes without spinning a browser.
 *
 * `network` and `screenshot_class` are stubs in this PR — they live in
 * the validator vocabulary but always evaluate as a structured
 * `unsupported_in_pr9` evidence record. PR-10 wires them up.
 */

import type {
  Assertion,
  AssertionKind,
  DomCountOp,
  Evidence,
} from './types';

/**
 * What the evaluator needs from the page and runtime. Hosts build this
 * once per evaluation; passing pre-computed values keeps assertions
 * cheap and synchronous.
 */
export interface AssertionContext {
  /** Current page URL. */
  url: string;
  /** `document.body.innerText` (visible text only). */
  bodyText: string;
  /** Selector → visible text lookup. Default lookup uses `bodyText`. */
  domText: (selector: string) => string;
  /** Selector → element count. */
  domCount: (selector: string) => number;
  /** True when a JS dialog is currently open / unhandled. */
  hasDialog: boolean;
  /** Optional pointer into the recording (#704). Surfaces in evidence. */
  traceRef?: { trace_id: string; from_ts: number; to_ts: number };
}

/** Evaluate an assertion tree. Pure; no I/O. */
export function evaluate(assertion: Assertion, ctx: AssertionContext): Evidence {
  switch (assertion.kind) {
    case 'url': {
      const re = safeRegExp(assertion.pattern);
      const passed = re.test(ctx.url);
      return mkEvidence('url', passed, {
        url: ctx.url,
        pattern: assertion.pattern,
      }, ctx);
    }
    case 'dom_text': {
      const selector = assertion.selector ?? 'body';
      const haystack = selector === 'body' ? ctx.bodyText : ctx.domText(selector);
      const passed = haystack.includes(assertion.contains);
      return mkEvidence('dom_text', passed, {
        selector,
        contains: assertion.contains,
        // Trim long bodies in evidence to keep bundles small (see #707).
        haystack_excerpt: haystack.length > 240 ? haystack.slice(0, 240) + '…' : haystack,
        haystack_length: haystack.length,
      }, ctx);
    }
    case 'dom_count': {
      const actual = ctx.domCount(assertion.selector);
      const passed = compareCount(actual, assertion.op, assertion.value);
      return mkEvidence('dom_count', passed, {
        selector: assertion.selector,
        op: assertion.op,
        expected: assertion.value,
        actual,
      }, ctx);
    }
    case 'no_dialog':
      return mkEvidence('no_dialog', !ctx.hasDialog, { hasDialog: ctx.hasDialog }, ctx);
    case 'network':
      return mkEvidence('network', false, {
        unsupported_in_pr9: true,
        message: 'network assertion is wired in PR-10 (#705 closes there)',
      }, ctx);
    case 'screenshot_class':
      return mkEvidence('screenshot_class', false, {
        unsupported_in_pr9: true,
        message: 'screenshot_class assertion is wired in PR-10 (pHash + class registry)',
      }, ctx);
    case 'and': {
      const children = assertion.children.map((c) => evaluate(c, ctx));
      const passed = children.every((c) => c.passed);
      return {
        passed,
        assertion_kind: 'and',
        details: { count: children.length, failed_count: children.filter((c) => !c.passed).length },
        children,
        ...(ctx.traceRef ? { trace_ref: ctx.traceRef } : {}),
      };
    }
    case 'or': {
      const children = assertion.children.map((c) => evaluate(c, ctx));
      const passed = children.some((c) => c.passed);
      return {
        passed,
        assertion_kind: 'or',
        details: { count: children.length, passed_count: children.filter((c) => c.passed).length },
        children,
        ...(ctx.traceRef ? { trace_ref: ctx.traceRef } : {}),
      };
    }
    case 'not': {
      const child = evaluate(assertion.child, ctx);
      return {
        passed: !child.passed,
        assertion_kind: 'not',
        details: { negated: child.assertion_kind },
        children: [child],
        ...(ctx.traceRef ? { trace_ref: ctx.traceRef } : {}),
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function compareCount(actual: number, op: DomCountOp, expected: number): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'gte':
      return actual >= expected;
    case 'lte':
      return actual <= expected;
  }
}

function safeRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    // Validator should have caught this; the runtime evaluator must not
    // throw. A regex that won't compile fails its assertion.
    return /(?!)/; // matches nothing
  }
}

function mkEvidence(
  kind: AssertionKind,
  passed: boolean,
  details: Record<string, unknown>,
  ctx: AssertionContext,
): Evidence {
  return {
    passed,
    assertion_kind: kind,
    details,
    ...(ctx.traceRef ? { trace_ref: ctx.traceRef } : {}),
  };
}
