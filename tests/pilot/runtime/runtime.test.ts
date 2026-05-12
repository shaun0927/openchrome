/**
 * Tests for the pilot contract runtime (issue #790, Phase 3).
 *
 * Adapted from the 564-line suite on the closed PR #749 branch
 * (pr/m2-pr11-contract-runtime). The adaptations are:
 *
 *   - DSL is async: `EvalContext` is fully Promise-based; the reference
 *     suite used a synchronous `AssertionContext`.
 *   - Probe-failure semantics: `src/contracts/evaluate.ts` catches probe
 *     throws and surfaces them as `passed: false` with `details.error`
 *     (rather than `details.probe_error` in the reference's evaluator).
 *   - Validator shape: develop's `validateAssertion` returns a discriminated
 *     `ValidationResult` per call; the runtime aggregates pre + post errors
 *     and prefixes paths with `$.pre` / `$.post`.
 *
 * Tests dropped vs the reference suite:
 *   - Tests targeting the old synchronous `evaluator.ts` API surface
 *     (the file does not exist on develop).
 *
 * Tests preserved (Codex round 1-6 carry-forward):
 *   - Verdict taxonomy across every success/failure path.
 *   - Retry behaviour (count, backoff, budget interaction).
 *   - Always-settles guarantee (snapshot / delay / audit throws).
 *   - Budget enforcement (positive, NaN, negative).
 *   - `escalate: "abort"` settles as postcondition_violation with marker.
 *   - Malformed-input rejection (validation_error short-circuit).
 *   - Domain propagation onto every TransactionRecord.
 *   - `pre = null` rejected via validator (skill never runs).
 */

import { runWithContract } from '../../../src/pilot/runtime/index.js';
import type {
  AuditEmitter,
  TransactionRecord,
} from '../../../src/pilot/runtime/index.js';
import type { EvalContext } from '../../../src/contracts/eval-context.js';
import type { Assertion } from '../../../src/contracts/types.js';
import { resetFlagsCache } from '../../../src/harness/flags.js';

// All tests run with the pilot flag forced on so `isContractRuntimeEnabled()`
// returns true; the disabled-flag path is exercised separately at the bottom.
beforeEach(() => {
  process.argv = ['node', 'cli/index.js', '--pilot'];
  resetFlagsCache();
});

/** Build a minimal `EvalContext` that the M2 evaluators can drive. */
function ctx(over: Partial<{
  url: string;
  bodyText: string;
  domText: (selector: string | undefined) => string | null;
  domCount: (selector: string) => number;
  hasOpenDialog: boolean;
}> = {}): EvalContext {
  const bodyText = over.bodyText ?? '';
  return {
    url: async () => over.url ?? 'https://example.com/',
    domText: async (selector) =>
      over.domText
        ? over.domText(selector)
        : selector === undefined || selector === 'body'
          ? bodyText
          : bodyText,
    domCount: async (selector) => (over.domCount ? over.domCount(selector) : 0),
    networkSince: async () => [],
    screenshotPng: async () => null,
    hasOpenDialog: async () => over.hasOpenDialog ?? false,
  };
}

function captureEmitter(): { emitter: AuditEmitter; records: TransactionRecord[] } {
  const records: TransactionRecord[] = [];
  return {
    emitter: {
      emit: (r) => {
        records.push(r);
      },
    },
    records,
  };
}

const POST_OK: Assertion = { kind: 'dom_text', contains: 'Order Placed' };
const POST_DIALOG: Assertion = { kind: 'no_dialog' };
const PRE_URL: Assertion = { kind: 'url', pattern: 'example\\.com' };

describe('runWithContract — happy path', () => {
  test('pre passes, skill runs, post passes -> success', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c1', pre: PRE_URL, post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Order Placed', url: 'https://example.com/' }),
      audit: emitter,
    });
    expect(r.verdict).toBe('success');
    expect(r.skill_result).toBe('ok');
    expect(r.pre_evidence?.passed).toBe(true);
    expect(r.post_evidence?.passed).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].verdict).toBe('success');
  });

  test('no pre-condition is fine — only post is required', async () => {
    const r = await runWithContract({
      contract: { id: 'c2', post: POST_OK },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'Order Placed' }),
    });
    expect(r.verdict).toBe('success');
    expect(r.pre_evidence).toBeUndefined();
  });
});

describe('runWithContract — verdict taxonomy', () => {
  test('precondition fails -> skill never runs, no post-check', async () => {
    let skillCalls = 0;
    const r = await runWithContract({
      contract: { id: 'c', pre: PRE_URL, post: POST_OK },
      skill: async () => {
        skillCalls++;
        return 'ok';
      },
      snapshot: async () => ctx({ url: 'https://other.com/' }),
    });
    expect(r.verdict).toBe('precondition_violation');
    expect(r.pre_evidence?.passed).toBe(false);
    expect(r.post_evidence).toBeUndefined();
    expect(skillCalls).toBe(0);
  });

  test('skill throws -> execution_error', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK },
      skill: async () => {
        throw new Error('boom');
      },
      snapshot: async () => ctx(),
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('boom');
  });

  test('post fails (no retry) -> postcondition_violation', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'wrong page' }),
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.post_evidence?.passed).toBe(false);
    expect(r.retries).toBe(0);
  });

  test('post fails with escalate=human-review -> escalated', async () => {
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { escalate: 'human-review' },
      },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'wrong page' }),
    });
    expect(r.verdict).toBe('escalated');
    expect(r.escalation).toEqual({ target: 'human-review' });
  });

  test('malformed contract -> validation_error (skill never runs)', async () => {
    let skillCalls = 0;
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: { kind: 'url' /* missing pattern */ } as unknown as Assertion,
      },
      skill: async () => {
        skillCalls++;
        return 'ok';
      },
      snapshot: async () => ctx(),
    });
    expect(r.verdict).toBe('validation_error');
    expect(r.validation_errors?.length).toBeGreaterThan(0);
    // Path prefix proves the runtime tagged it against `$.post`.
    expect(r.validation_errors?.some((e) => e.path.startsWith('$.post'))).toBe(true);
    expect(skillCalls).toBe(0);
  });

  test('skill exceeds wall_ms budget -> budget_exhausted', async () => {
    let n = 0;
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, budget: { wall_ms: 50 } },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'Order Placed' }),
      now: () => {
        // Sequence of now() calls without pre-check:
        //   [0] startedAt, [1] skillStart, [2] skillEnd, [3..] ended_at
        // skillEnd (100) - skillStart (0) = 100ms > 50ms budget.
        const seq = [0, 0, 100, 100];
        return seq[Math.min(n++, seq.length - 1)];
      },
    });
    expect(r.verdict).toBe('budget_exhausted');
    expect(r.error_message).toContain('wall_ms');
  });
});

describe('runWithContract — retry + backoff', () => {
  test('post-check retries until pass within retry budget', async () => {
    let postCalls = 0;
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, on_fail: { retry: 3 } },
      skill: async () => 'done',
      snapshot: async () => {
        postCalls++;
        return ctx({ bodyText: postCalls >= 3 ? 'Order Placed' : 'pending' });
      },
      delay: async () => undefined,
    });
    expect(r.verdict).toBe('success');
    expect(r.retries).toBe(2);
    expect(r.post_evidence?.passed).toBe(true);
  });

  test('retry exhausted -> postcondition_violation with retries == max', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, on_fail: { retry: 2 } },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'still pending' }),
      delay: async () => undefined,
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.retries).toBe(2);
  });

  test('zero retries (default) — first failure settles immediately', async () => {
    let postCalls = 0;
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK },
      skill: async () => undefined,
      snapshot: async () => {
        postCalls++;
        return ctx({ bodyText: 'still pending' });
      },
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.retries).toBe(0);
    expect(postCalls).toBe(1);
  });

  test('backoff respects budget — does not retry past wall budget', async () => {
    // wall_ms 100, base backoff 500ms -> first retry would exceed budget.
    const captured: number[] = [];
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { retry: 5 },
        budget: { wall_ms: 100 },
      },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'pending' }),
      delay: async (ms) => {
        captured.push(ms);
      },
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(captured.length).toBe(0);
    expect(r.retries).toBe(0);
  });

  test('default retry delay keeps backoff timer unref-ed', async () => {
    // Codex round 6 (884f963): the default delay must call `t.unref()`
    // so a leftover timer does not pin the event loop on cancel.
    const realSetTimeout = global.setTimeout;
    const unref = jest.fn();
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((...args: Parameters<typeof global.setTimeout>) => {
        const [callback, , ...rest] = args;
        // Schedule on a 0-ms delay so tests don't wait the real backoff.
        const timer = realSetTimeout(callback, 0, ...rest);
        const originalUnref = timer.unref.bind(timer);
        timer.unref = (() => {
          unref();
          return originalUnref();
        }) as typeof timer.unref;
        return timer;
      }) as typeof global.setTimeout);

    try {
      const r = await runWithContract({
        contract: { id: 'c', post: POST_OK, on_fail: { retry: 1 } },
        skill: async () => undefined,
        snapshot: async () => ctx({ bodyText: 'still pending' }),
      });
      expect(r.verdict).toBe('postcondition_violation');
      expect(r.retries).toBe(1);
      expect(setTimeoutSpy).toHaveBeenCalled();
      expect(unref).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe('runWithContract — audit emission', () => {
  test('exactly one record emitted per call (every verdict path)', async () => {
    const cases: Array<{
      contract: Parameters<typeof runWithContract>[0]['contract'];
      ctxSeq: EvalContext[];
    }> = [
      {
        contract: { id: 'a', post: POST_OK },
        ctxSeq: [ctx({ bodyText: 'Order Placed' })],
      },
      {
        contract: { id: 'b', post: POST_OK },
        ctxSeq: [ctx({ bodyText: 'wrong' })],
      },
      {
        contract: { id: 'c', pre: PRE_URL, post: POST_OK },
        ctxSeq: [ctx({ url: 'https://other.com/' })],
      },
      {
        contract: { id: 'd', post: POST_OK, on_fail: { escalate: 'headed-handoff' } },
        ctxSeq: [ctx({ bodyText: 'wrong' })],
      },
    ];
    for (const c of cases) {
      const { emitter, records } = captureEmitter();
      let i = 0;
      await runWithContract({
        contract: c.contract,
        skill: async () => undefined,
        snapshot: async () => c.ctxSeq[Math.min(i++, c.ctxSeq.length - 1)],
        audit: emitter,
      });
      expect(records).toHaveLength(1);
    }
  });

  test('record includes wall_ms (non-negative)', async () => {
    const { emitter, records } = captureEmitter();
    await runWithContract({
      contract: { id: 'c', post: POST_DIALOG },
      skill: async () => undefined,
      snapshot: async () => ctx(),
      audit: emitter,
    });
    expect(records[0].wall_ms).toBeGreaterThanOrEqual(0);
  });

  test('audit-emitter throw does not change verdict', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_DIALOG },
      skill: async () => undefined,
      snapshot: async () => ctx(),
      audit: {
        emit: () => {
          throw new Error('audit broken');
        },
      },
    });
    expect(r.verdict).toBe('success');
  });

  test('async audit-emitter rejection does not change verdict', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_DIALOG },
      skill: async () => undefined,
      snapshot: async () => ctx(),
      audit: {
        emit: async () => {
          throw new Error('audit rejected');
        },
      },
    });
    await Promise.resolve();
    expect(r.verdict).toBe('success');
  });
});

describe('runWithContract — probe failure handling (always-settles)', () => {
  // The orchestrator in `src/contracts/evaluate.ts` wraps host probes
  // in try/catch and returns `passed: false` with `details.error`,
  // rather than re-throwing. So a throwing `domText` no longer surfaces
  // as `execution_error` from the runtime — it surfaces as a normal
  // pre/postcondition failure with the probe error captured in evidence.
  // Either way the runtime settles cleanly; that's the always-settles
  // guarantee (Codex round 2, 355e9bd).
  const POST_BAD_SELECTOR: Assertion = {
    kind: 'dom_text',
    selector: 'button.primary',
    contains: 'Submit',
  };
  const PRE_BAD_SELECTOR: Assertion = {
    kind: 'dom_text',
    selector: 'button.primary',
    contains: 'Submit',
  };
  const throwingDomText = (): string => {
    throw new Error('Invalid selector');
  };

  test('throwing pre probe -> precondition_violation with error in evidence', async () => {
    const r = await runWithContract({
      contract: { id: 'c', pre: PRE_BAD_SELECTOR, post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ domText: throwingDomText }),
    });
    expect(r.verdict).toBe('precondition_violation');
    expect(r.pre_evidence?.passed).toBe(false);
    expect(String(r.pre_evidence?.details.error ?? '')).toContain('Invalid selector');
  });

  test('throwing post probe -> postcondition_violation with error in evidence', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_BAD_SELECTOR },
      skill: async () => 'ok',
      snapshot: async () => ctx({ domText: throwingDomText }),
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.post_evidence?.passed).toBe(false);
    expect(String(r.post_evidence?.details.error ?? '')).toContain('Invalid selector');
  });

  test('snapshot rejection during pre-check -> execution_error', async () => {
    const r = await runWithContract({
      contract: { id: 'c', pre: PRE_URL, post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => {
        throw new Error('snapshot exploded');
      },
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('snapshot exploded');
  });
});

describe('runWithContract — retry count normalization', () => {
  test('NaN retry -> 0 retries (no infinite loop)', async () => {
    let postCalls = 0;
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { retry: NaN as unknown as number },
      },
      skill: async () => undefined,
      snapshot: async () => {
        postCalls++;
        return ctx({ bodyText: 'still pending' });
      },
      delay: async () => undefined,
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.retries).toBe(0);
    expect(postCalls).toBe(1);
  });

  test('fractional retry (1.7) is floored to 1', async () => {
    let postCalls = 0;
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { retry: 1.7 as unknown as number },
      },
      skill: async () => undefined,
      snapshot: async () => {
        postCalls++;
        return ctx({ bodyText: 'still pending' });
      },
      delay: async () => undefined,
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.retries).toBe(1);
    expect(postCalls).toBe(2);
  });

  test('Infinity retry -> coerced to 0 (no infinite loop)', async () => {
    let postCalls = 0;
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { retry: Number.POSITIVE_INFINITY as unknown as number },
      },
      skill: async () => undefined,
      snapshot: async () => {
        postCalls++;
        return ctx({ bodyText: 'still pending' });
      },
      delay: async () => undefined,
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.retries).toBe(0);
    expect(postCalls).toBe(1);
  });

  test('negative retry -> coerced to 0', async () => {
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { retry: -3 },
      },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'pending' }),
      delay: async () => undefined,
    });
    expect(r.retries).toBe(0);
  });
});

describe('runWithContract — domain propagation + escalate=abort', () => {
  test('contract.domain is mirrored into TransactionRecord on every settle', async () => {
    const { emitter, records } = captureEmitter();
    await runWithContract({
      contract: { id: 'c', domain: 'checkout-flow', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Order Placed' }),
      audit: emitter,
    });
    expect(records[0].contract_domain).toBe('checkout-flow');
  });

  test('contract.domain absent -> contract_domain stays undefined', async () => {
    const { emitter, records } = captureEmitter();
    await runWithContract({
      contract: { id: 'c', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Order Placed' }),
      audit: emitter,
    });
    expect(records[0].contract_domain).toBeUndefined();
  });

  test('escalate=abort settles as postcondition_violation with explicit marker', async () => {
    // Without explicit handling, 'abort' would silently fall into the
    // generic postcondition_violation path and audit consumers could
    // not tell that the operator opted out of human escalation.
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { escalate: 'abort' },
      },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'wrong page' }),
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.error_message).toContain('escalate=abort');
  });
});

describe('runWithContract — explicit null pre', () => {
  test('contract.pre = null is rejected as validation_error (skill never runs)', async () => {
    // Truthy-only checks would silently treat `pre: null` (a JSON
    // payload artifact) as "no precondition" and let the skill run
    // unguarded; the runtime routes null through the validator which
    // rejects it as wrong-type and short-circuits to validation_error
    // before any skill side effect can occur (Codex round 4, 19e1181).
    let skillCalls = 0;
    const r = await runWithContract({
      contract: {
        id: 'c-null-pre',
        pre: null as unknown as Assertion,
        post: POST_OK,
      },
      skill: async () => {
        skillCalls++;
        return 'unsafe-side-effect';
      },
      snapshot: async () => ctx({ bodyText: 'Order Placed' }),
    });
    expect(r.verdict).toBe('validation_error');
    expect(skillCalls).toBe(0);
    expect(r.validation_errors?.some((e) => e.path.startsWith('$.pre'))).toBe(true);
  });
});

describe('runWithContract — delay()/budget normalization', () => {
  test('delay() rejection between retries -> execution_error', async () => {
    // A custom delay that simulates an abortable sleep being aborted
    // mid-retry; the runtime must not let the rejection escape (Codex
    // round 2, 355e9bd).
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, on_fail: { retry: 3 } },
      skill: async () => undefined,
      snapshot: async () => ctx({ bodyText: 'still pending' }),
      delay: async () => {
        throw new Error('AbortError: sleep aborted');
      },
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('delay()');
  });

  test('NaN wall_ms budget is treated as no budget (not always-violated)', async () => {
    // With un-normalized comparison `x > NaN` is always false, so a NaN
    // budget would silently disable enforcement. Normalization drops it
    // entirely so the caller's intent (no budget) is honored explicitly.
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        budget: { wall_ms: NaN as unknown as number },
      },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Order Placed' }),
    });
    expect(r.verdict).toBe('success');
  });

  test('negative wall_ms budget is treated as no budget', async () => {
    // A negative budget would otherwise force every call to exhaust the
    // budget the moment any execution time elapses.
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        budget: { wall_ms: -100 },
      },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Order Placed' }),
    });
    expect(r.verdict).toBe('success');
  });
});

describe('runWithContract — disabled by flag', () => {
  test('returns a no-op execution_error when isContractRuntimeEnabled() is false', async () => {
    // Drop the --pilot flag so the family-flag evaluates false.
    process.argv = ['node', 'cli/index.js'];
    resetFlagsCache();
    let skillCalls = 0;
    let auditCalls = 0;
    const r = await runWithContract({
      contract: { id: 'c-disabled', post: POST_OK },
      skill: async () => {
        skillCalls++;
        return 'never';
      },
      snapshot: async () => ctx({ bodyText: 'Order Placed' }),
      audit: {
        emit: () => {
          auditCalls++;
        },
      },
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('disabled');
    // No side effects when the family flag is off.
    expect(skillCalls).toBe(0);
    expect(auditCalls).toBe(0);
  });
});
