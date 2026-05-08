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
      // Host-supplied probes throw on bad selectors (e.g.,
      // `querySelector('#'.invalid)` raises SyntaxError). The evaluator
      // promises never to throw — convert probe failures into a
      // structured passed=false instead so composite evaluators see a
      // normal evidence record and the runtime stays "always settles".
      let haystack: string;
      try {
        haystack = selector === 'body' ? ctx.bodyText : ctx.domText(selector);
      } catch (e) {
        return mkEvidence('dom_text', false, {
          selector,
          contains: assertion.contains,
          probe_error: e instanceof Error ? e.message : String(e),
        }, ctx);
      }
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
      let actual: number;
      try {
        actual = ctx.domCount(assertion.selector);
      } catch (e) {
        return mkEvidence('dom_count', false, {
          selector: assertion.selector,
          op: assertion.op,
          expected: assertion.value,
          probe_error: e instanceof Error ? e.message : String(e),
        }, ctx);
      }
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
      return mkUnsupportedEvidence(
        'network',
        'network assertion is wired in PR-10 (#705 closes there)',
        ctx,
      );
    case 'screenshot_class':
      return mkUnsupportedEvidence(
        'screenshot_class',
        'screenshot_class assertion is wired in PR-10 (pHash + class registry)',
        ctx,
      );
    case 'and': {
      const children = assertion.children.map((c) => evaluate(c, ctx));
      // An unsupported child fails the whole conjunction; the composite
      // is also marked unsupported so callers / `not` can distinguish
      // "evaluated and failed" from "could not be evaluated yet".
      const unsupportedCount = children.filter(isUnsupported).length;
      const passed = unsupportedCount === 0 && children.every((c) => c.passed);
      const details: Record<string, unknown> = {
        count: children.length,
        failed_count: children.filter((c) => !c.passed).length,
      };
      if (unsupportedCount > 0) {
        details.unsupported = true;
        details.unsupported_count = unsupportedCount;
      }
      return {
        passed,
        assertion_kind: 'and',
        details,
        children,
        ...(ctx.traceRef ? { trace_ref: ctx.traceRef } : {}),
      };
    }
    case 'or': {
      const children = assertion.children.map((c) => evaluate(c, ctx));
      // For `or`, a real pass from any supported child still wins. If
      // no child passes AND any child is unsupported, mark the
      // composite unsupported so `not` does not flip it into a true.
      const supportedPasses = children.some((c) => !isUnsupported(c) && c.passed);
      const anyUnsupported = children.some(isUnsupported);
      const details: Record<string, unknown> = {
        count: children.length,
        passed_count: children.filter((c) => c.passed).length,
      };
      if (!supportedPasses && anyUnsupported) {
        details.unsupported = true;
      }
      return {
        passed: supportedPasses,
        assertion_kind: 'or',
        details,
        children,
        ...(ctx.traceRef ? { trace_ref: ctx.traceRef } : {}),
      };
    }
    case 'not': {
      const child = evaluate(assertion.child, ctx);
      // Negating an unsupported child cannot yield a true result —
      // otherwise `not(network)` would always "pass" before PR-10
      // wires network up. Propagate the unsupported marker and keep
      // passed=false so callers cannot drive logic off a stub.
      const unsupported = isUnsupported(child);
      const details: Record<string, unknown> = { negated: child.assertion_kind };
      if (unsupported) details.unsupported = true;
      return {
        passed: unsupported ? false : !child.passed,
        assertion_kind: 'not',
        details,
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

/** Stable shape for "this assertion kind is not yet wired up". The
 *  `unsupported: true` flag lives at the top of `details` so composite
 *  evaluators can branch on it without sniffing kind-specific keys. */
function mkUnsupportedEvidence(
  kind: AssertionKind,
  message: string,
  ctx: AssertionContext,
): Evidence {
  return {
    passed: false,
    assertion_kind: kind,
    details: { unsupported: true, message },
    ...(ctx.traceRef ? { trace_ref: ctx.traceRef } : {}),
  };
}

function isUnsupported(evidence: Evidence): boolean {
  return evidence.details?.unsupported === true;
}
