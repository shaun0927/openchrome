import { runWithContract, type AuditEmitter, type TransactionRecord } from '../../src/contracts/runtime';
import type { AssertionContext } from '../../src/contracts/evaluator';
import type { Assertion } from '../../src/contracts/types';

function snap(over: Partial<AssertionContext> = {}): AssertionContext {
  return {
    url: 'https://example.com/',
    bodyText: '',
    domText: () => '',
    domCount: () => 0,
    hasDialog: false,
    ...over,
  };
}

function captureEmitter(): { emitter: AuditEmitter; records: TransactionRecord[] } {
  const records: TransactionRecord[] = [];
  return {
    emitter: { emit: (r) => records.push(r) },
    records,
  };
}

const POST_OK: Assertion = { kind: 'dom_text', contains: 'Order Placed' };
const POST_DIALOG: Assertion = { kind: 'no_dialog' };
const PRE_URL: Assertion = { kind: 'url', pattern: 'example\\.com' };

describe('runWithContract — happy path', () => {
  test('pre passes, skill runs, post passes → success', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c1', pre: PRE_URL, post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => snap({ bodyText: 'Order Placed', url: 'https://example.com/' }),
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
      snapshot: async () => snap({ bodyText: 'Order Placed' }),
    });
    expect(r.verdict).toBe('success');
    expect(r.pre_evidence).toBeUndefined();
  });
});

describe('runWithContract — verdict taxonomy', () => {
  test('precondition fails → skill never runs, no post-check', async () => {
    let skillCalls = 0;
    const r = await runWithContract({
      contract: { id: 'c', pre: PRE_URL, post: POST_OK },
      skill: async () => {
        skillCalls++;
        return 'ok';
      },
      snapshot: async () => snap({ url: 'https://other.com/' }),
    });
    expect(r.verdict).toBe('precondition_violation');
    expect(r.pre_evidence?.passed).toBe(false);
    expect(r.post_evidence).toBeUndefined();
    expect(skillCalls).toBe(0);
  });

  test('skill throws → execution_error', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK },
      skill: async () => {
        throw new Error('boom');
      },
      snapshot: async () => snap(),
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('boom');
  });

  test('post fails (no retry) → postcondition_violation', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK },
      skill: async () => undefined,
      snapshot: async () => snap({ bodyText: 'wrong page' }),
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.post_evidence?.passed).toBe(false);
    expect(r.retries).toBe(0);
  });

  test('post fails with escalate=human-review → escalated', async () => {
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { escalate: 'human-review' },
      },
      skill: async () => undefined,
      snapshot: async () => snap({ bodyText: 'wrong page' }),
    });
    expect(r.verdict).toBe('escalated');
    expect(r.escalation).toEqual({ target: 'human-review' });
  });

  test('malformed contract → validation_error (skill never runs)', async () => {
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
      snapshot: async () => snap(),
    });
    expect(r.verdict).toBe('validation_error');
    expect(r.validation_errors?.length).toBeGreaterThan(0);
    expect(skillCalls).toBe(0);
  });

  test('skill exceeds wall_ms budget → budget_exhausted', async () => {
    let n = 0;
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, budget: { wall_ms: 50 } },
      skill: async () => {
        // No real sleep — drive `now()` to simulate elapsed wall time.
        return undefined;
      },
      snapshot: async () => snap({ bodyText: 'Order Placed' }),
      now: () => {
        // Sequence of now() calls without pre-check:
        //   [0] startedAt, [1] skillStart, [2] skillEnd, [3] ended_at
        // skillEnd (100) - skillStart (0) = 100 ms > 50 ms budget.
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
        // Fail twice, pass on third snapshot
        return snap({ bodyText: postCalls >= 3 ? 'Order Placed' : 'pending…' });
      },
      delay: async () => undefined, // skip real sleeps in tests
    });
    expect(r.verdict).toBe('success');
    expect(r.retries).toBe(2);
    expect(r.post_evidence?.passed).toBe(true);
  });

  test('retry exhausted → postcondition_violation with retries == max', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, on_fail: { retry: 2 } },
      skill: async () => undefined,
      snapshot: async () => snap({ bodyText: 'still pending' }),
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
        return snap({ bodyText: 'still pending' });
      },
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.retries).toBe(0);
    expect(postCalls).toBe(1);
  });

  test('backoff respects budget — does not retry past wall budget', async () => {
    // wall_ms 100, base backoff 500ms → first retry would exceed budget
    const captured: number[] = [];
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { retry: 5 },
        budget: { wall_ms: 100 },
      },
      skill: async () => undefined,
      snapshot: async () => snap({ bodyText: 'pending' }),
      delay: async (ms) => {
        captured.push(ms);
      },
    });
    expect(r.verdict).toBe('postcondition_violation');
    // The retry budget guard should bail before any sleep is queued.
    expect(captured.length).toBe(0);
    expect(r.retries).toBe(0);
  });
});

describe('runWithContract — audit emission', () => {
  test('exactly one record emitted per call (every verdict path)', async () => {
    const cases: Array<{ contract: Parameters<typeof runWithContract>[0]['contract']; ctxSeq: AssertionContext[] }> = [
      // success
      {
        contract: { id: 'a', post: POST_OK },
        ctxSeq: [snap({ bodyText: 'Order Placed' })],
      },
      // postcondition_violation
      {
        contract: { id: 'b', post: POST_OK },
        ctxSeq: [snap({ bodyText: 'wrong' })],
      },
      // precondition_violation
      {
        contract: { id: 'c', pre: PRE_URL, post: POST_OK },
        ctxSeq: [snap({ url: 'https://other.com/' })],
      },
      // escalated
      {
        contract: { id: 'd', post: POST_OK, on_fail: { escalate: 'headed-handoff' } },
        ctxSeq: [snap({ bodyText: 'wrong' })],
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
      snapshot: async () => snap(),
      audit: emitter,
    });
    expect(records[0].wall_ms).toBeGreaterThanOrEqual(0);
  });

  test('audit-emitter throw does not change verdict', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_DIALOG },
      skill: async () => undefined,
      snapshot: async () => snap(),
      audit: {
        emit: () => {
          throw new Error('audit broken');
        },
      },
    });
    expect(r.verdict).toBe('success');
  });
});

describe('runWithContract — evaluator throws (always-settles guarantee)', () => {
  // dom_text default selector is "body" → exercised via bodyText (no probe).
  // Force an exception by using a non-default selector that the snapshot's
  // domText() callback rejects, mirroring real-world bad-selector failures.
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

  test('evaluator throws during pre-check → execution_error (never propagates)', async () => {
    const r = await runWithContract({
      contract: { id: 'c', pre: PRE_BAD_SELECTOR, post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => snap({ domText: throwingDomText }),
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('pre-check');
  });

  test('evaluator throws during post-check → execution_error (never propagates)', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_BAD_SELECTOR },
      skill: async () => 'ok',
      snapshot: async () => snap({ domText: throwingDomText }),
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('post-check');
  });
});

describe('runWithContract — retry count normalization', () => {
  test('NaN retry → 0 retries (no infinite loop)', async () => {
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
        return snap({ bodyText: 'still pending' });
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
        return snap({ bodyText: 'still pending' });
      },
      delay: async () => undefined,
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.retries).toBe(1);
    expect(postCalls).toBe(2); // initial check + 1 retry
  });

  test('Infinity retry → coerced to 0 (no infinite loop)', async () => {
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
        return snap({ bodyText: 'still pending' });
      },
      delay: async () => undefined,
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.retries).toBe(0);
    expect(postCalls).toBe(1);
  });

  test('negative retry → coerced to 0', async () => {
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: POST_OK,
        on_fail: { retry: -3 },
      },
      skill: async () => undefined,
      snapshot: async () => snap({ bodyText: 'pending' }),
      delay: async () => undefined,
    });
    expect(r.retries).toBe(0);
  });
});

describe('runWithContract — explicit null pre', () => {
  test('contract.pre = null is rejected as validation_error (skill never runs)', async () => {
    // Truthy-only checks would silently treat `pre: null` (a JSON
    // payload artifact) as "no precondition" and let the skill run
    // unguarded; the runtime now routes null through the validator,
    // which rejects it as wrong_type and short-circuits to
    // validation_error before any skill side effect can occur.
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
      snapshot: async () => snap({ bodyText: 'Order Placed' }),
    });
    expect(r.verdict).toBe('validation_error');
    expect(skillCalls).toBe(0);
    expect(r.validation_errors?.some((e) => e.path.startsWith('$.pre'))).toBe(true);
  });
});

describe('runWithContract — delay()/budget normalization', () => {
  test('delay() rejection between retries → execution_error', async () => {
    // A custom delay that simulates an abortable sleep being aborted
    // mid-retry; runtime must not let the rejection escape.
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, on_fail: { retry: 3 } },
      skill: async () => undefined,
      snapshot: async () => snap({ bodyText: 'still pending' }),
      delay: async () => {
        throw new Error('AbortError: sleep aborted');
      },
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('delay()');
    // Settled exactly once — audit emission is preserved.
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
      snapshot: async () => snap({ bodyText: 'Order Placed' }),
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
      snapshot: async () => snap({ bodyText: 'Order Placed' }),
    });
    expect(r.verdict).toBe('success');
  });
});
