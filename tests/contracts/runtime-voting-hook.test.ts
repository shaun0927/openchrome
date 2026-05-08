/**
 * Voting hook integration into the contract runtime (#711 + #706).
 *
 * The hook fires only when contract.critical === true AND a hook is
 * supplied. These tests use a deterministic fake hook so they don't
 * depend on real provider HTTP.
 */

import {
  runWithContract,
  type AuditEmitter,
  type BeforeIrreversibleActionHook,
  type TransactionRecord,
} from '../../src/contracts/runtime';
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
  return { emitter: { emit: (r) => records.push(r) }, records };
}

const POST_OK: Assertion = { kind: 'no_dialog' };

describe('runWithContract — beforeIrreversibleAction hook', () => {
  test('non-critical contracts ignore the hook entirely', async () => {
    let called = 0;
    const hook: BeforeIrreversibleActionHook = async () => {
      called++;
      return { proceed: false };
    };
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK }, // critical = false (omitted)
      skill: async () => 'ok',
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
    });
    expect(r.verdict).toBe('success');
    expect(called).toBe(0);
  });

  test('critical contracts WITHOUT a hook still proceed (no-op)', async () => {
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'ok',
      snapshot: async () => snap(),
    });
    expect(r.verdict).toBe('success');
  });

  test('critical + hook proceeds when decision.proceed=true', async () => {
    const hook: BeforeIrreversibleActionHook = async () => ({ proceed: true });
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'ok',
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
    });
    expect(r.verdict).toBe('success');
  });

  test('critical + hook denies → verdict=escalated, skill never runs', async () => {
    let skillCalls = 0;
    const hook: BeforeIrreversibleActionHook = async () => ({
      proceed: false,
      reason: 'providers disagreed',
      disagreement: { providers: ['anthropic', 'openai'] },
    });
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => {
        skillCalls++;
      },
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
      audit: emitter,
    });
    expect(r.verdict).toBe('escalated');
    expect(r.error_message).toBe('providers disagreed');
    expect(r.voting_disagreement).toEqual({ providers: ['anthropic', 'openai'] });
    expect(r.escalation?.target).toBe('human-review');
    expect(skillCalls).toBe(0);
    expect(records).toHaveLength(1);
  });

  test('hook fires AFTER pre-check (no skill consumed when pre fails)', async () => {
    let hookCalls = 0;
    const hook: BeforeIrreversibleActionHook = async () => {
      hookCalls++;
      return { proceed: true };
    };
    const r = await runWithContract({
      contract: {
        id: 'c',
        pre: { kind: 'url', pattern: 'never-matches' },
        post: POST_OK,
        critical: true,
      },
      skill: async () => 'ok',
      snapshot: async () => snap({ url: 'https://example.com/' }),
      beforeIrreversibleAction: hook,
    });
    expect(r.verdict).toBe('precondition_violation');
    expect(hookCalls).toBe(0); // hook never called when pre fails
  });

  test('hook throws → verdict=execution_error (skill never runs)', async () => {
    let skillCalls = 0;
    const hook: BeforeIrreversibleActionHook = async () => {
      throw new Error('voting provider exploded');
    };
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => {
        skillCalls++;
      },
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.error_message).toContain('voting provider exploded');
    expect(skillCalls).toBe(0);
  });

  test('hung hook times out → verdict=escalated with hook_timeout message (fail-safe)', async () => {
    // A hook that never resolves simulates a hung voting provider.
    const hook: BeforeIrreversibleActionHook = () => new Promise(() => {/* never resolves */});
    const { emitter, records } = captureEmitter();

    // Use fake timer machinery so the test completes in ms, not seconds.
    // setTimer resolves the sentinel immediately on next tick.
    let timerCallback: (() => void) | null = null;
    const fakeSetTimer = (handler: () => void, _ms: number) => {
      timerCallback = handler;
      // Schedule callback to fire asynchronously so Promise.race can set up.
      Promise.resolve().then(() => timerCallback?.());
      return 1; // opaque handle
    };
    const fakeClearTimer = (_h: unknown) => { timerCallback = null; };

    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'should not run',
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
      beforeIrreversibleActionTimeoutMs: 50,
      setTimer: fakeSetTimer,
      clearTimer: fakeClearTimer,
      audit: emitter,
    });

    expect(r.verdict).toBe('escalated');
    expect(r.error_message).toContain('hook_timeout');
    expect(r.escalation?.target).toBe('human-review');
    expect(records).toHaveLength(1);
  });

  test('hook resolves to undefined → verdict=escalated with hook_invalid_response, audit record present, no thrown error', async () => {
    const hook: BeforeIrreversibleActionHook = async () => undefined as unknown as never;
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'should not run',
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
      audit: emitter,
    });
    expect(r.verdict).toBe('escalated');
    expect(r.error_message).toContain('hook_invalid_response');
    expect(r.escalation?.target).toBe('human-review');
    expect(records).toHaveLength(1);
  });

  test('hook resolves to {} (missing proceed) → verdict=escalated with hook_invalid_response', async () => {
    const hook: BeforeIrreversibleActionHook = async () => ({} as unknown as never);
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'should not run',
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
      audit: emitter,
    });
    expect(r.verdict).toBe('escalated');
    expect(r.error_message).toContain('hook_invalid_response');
    expect(records).toHaveLength(1);
  });

  test('hook resolves to {proceed: "maybe"} (wrong type) → verdict=escalated with hook_invalid_response', async () => {
    const hook: BeforeIrreversibleActionHook = async () => ({ proceed: 'maybe' } as unknown as never);
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'should not run',
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
      audit: emitter,
    });
    expect(r.verdict).toBe('escalated');
    expect(r.error_message).toContain('hook_invalid_response');
    expect(records).toHaveLength(1);
  });

  test('hook resolves to null → verdict=escalated with hook_invalid_response (NOT hook_timeout)', async () => {
    // Regression: before the Symbol sentinel fix, a hook returning null was
    // misclassified as hook_timeout because null was the timeout sentinel.
    const hook: BeforeIrreversibleActionHook = async () => null as unknown as never;
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'should not run',
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
      audit: emitter,
    });
    expect(r.verdict).toBe('escalated');
    expect(r.error_message).toContain('hook_invalid_response');
    expect(r.error_message).not.toContain('hook_timeout');
    expect(r.escalation?.target).toBe('human-review');
    expect(records).toHaveLength(1);
  });

  test('slow hook does not consume skill wall-budget — retries still fire (P2B regression)', async () => {
    // Scenario: hook takes 4 s, skill takes 2 s, wall_ms budget = 5 s.
    // Without the fix: elapsed from startedAt = 6 s > 5 s → retry suppressed.
    // With the fix: elapsed from skillStartedAt = 2 s < 5 s → retry is allowed.
    //
    // We drive all time with a deterministic fake clock so no real waiting.
    let t = 0;
    const now = () => t;

    // Hook occupies 4 000 ms of wall time.
    const HOOK_DURATION = 4_000;
    // Skill takes 2 000 ms.
    const SKILL_DURATION = 2_000;
    // Budget = 5 000 ms (less than hook+skill combined, but sufficient for skill alone).
    const WALL_MS = 5_000;

    // The hook advances the fake clock when it resolves.
    const hook: BeforeIrreversibleActionHook = async () => {
      t += HOOK_DURATION;
      return { proceed: true };
    };

    // The skill advances the clock when it resolves.
    let skillCalls = 0;
    const skill = async () => {
      skillCalls++;
      t += SKILL_DURATION;
      return 'done';
    };

    // Fake delay that advances the clock without real waiting.
    const delay = async (ms: number) => { t += ms; };

    // Post-check: fails on attempt 0, passes on attempt 1, so one retry fires.
    let postChecks = 0;
    const snapshot = async (): Promise<AssertionContext> => {
      postChecks++;
      return {
        url: 'https://example.com/',
        bodyText: postChecks >= 2 ? 'ready' : '',
        domText: () => (postChecks >= 2 ? 'ready' : ''),
        domCount: () => 0,
        hasDialog: false,
      };
    };

    // Use a setTimer that never fires automatically (budget preemption is not
    // what we are testing here) so only the retry-gate logic is exercised.
    const fakeSetTimer = (_h: () => void, _ms: number) => 99;
    const fakeClearTimer = (_h: unknown) => undefined;

    const r = await runWithContract({
      contract: {
        id: 'c-hook-budget',
        post: { kind: 'dom_text', contains: 'ready' },
        critical: true,
        budget: { wall_ms: WALL_MS },
        on_fail: { retry: 2 },
      },
      skill,
      snapshot,
      beforeIrreversibleAction: hook,
      now,
      delay,
      setTimer: fakeSetTimer,
      clearTimer: fakeClearTimer,
    });

    // The retry should have fired — post-check passes on attempt 1.
    expect(r.verdict).toBe('success');
    expect(r.retries).toBe(1);
    expect(skillCalls).toBe(1);
  });

  test('escalated record contains pre_evidence (when pre present and passed)', async () => {
    const hook: BeforeIrreversibleActionHook = async () => ({ proceed: false });
    const r = await runWithContract({
      contract: {
        id: 'c',
        pre: { kind: 'no_dialog' },
        post: POST_OK,
        critical: true,
      },
      skill: async () => 'ok',
      snapshot: async () => snap(),
      beforeIrreversibleAction: hook,
    });
    expect(r.verdict).toBe('escalated');
    expect(r.pre_evidence?.passed).toBe(true);
  });

  // --- resolveHookTimeoutMs sanitization regression tests ---
  // These verify that invalid timeout values fall back to the default and do NOT
  // cause an immediate-fire timer that escalates a fast-returning hook.

  function makeInstantHook(): BeforeIrreversibleActionHook {
    return async () => ({ proceed: true });
  }

  // Fake timer that fires ONLY after at least one microtask cycle, simulating
  // a real delay (the hook should win the race when timeout is sane).
  // For invalid-timeout cases the runtime uses the default (5000 ms) so the
  // hook resolves first — we just need the timer NOT to fire immediately.
  function makeFakeTimer() {
    let cancelled = false;
    const fakeSetTimer = (handler: () => void, _ms: number) => {
      // Schedule with a real delay via setTimeout so the hook always wins.
      const h = setTimeout(() => { if (!cancelled) handler(); }, 2000);
      return h;
    };
    const fakeClearTimer = (h: unknown) => {
      cancelled = true;
      clearTimeout(h as ReturnType<typeof setTimeout>);
    };
    return { fakeSetTimer, fakeClearTimer };
  }

  test('beforeIrreversibleActionTimeoutMs: 0 → falls back to default, hook proceeds (not escalated)', async () => {
    const { fakeSetTimer, fakeClearTimer } = makeFakeTimer();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'ok',
      snapshot: async () => snap(),
      beforeIrreversibleAction: makeInstantHook(),
      beforeIrreversibleActionTimeoutMs: 0,
      setTimer: fakeSetTimer,
      clearTimer: fakeClearTimer,
    });
    expect(r.verdict).toBe('success');
  });

  test('beforeIrreversibleActionTimeoutMs: -5 → falls back to default, hook proceeds (not escalated)', async () => {
    const { fakeSetTimer, fakeClearTimer } = makeFakeTimer();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'ok',
      snapshot: async () => snap(),
      beforeIrreversibleAction: makeInstantHook(),
      beforeIrreversibleActionTimeoutMs: -5,
      setTimer: fakeSetTimer,
      clearTimer: fakeClearTimer,
    });
    expect(r.verdict).toBe('success');
  });

  test('beforeIrreversibleActionTimeoutMs: NaN → falls back to default, hook proceeds (not escalated)', async () => {
    const { fakeSetTimer, fakeClearTimer } = makeFakeTimer();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'ok',
      snapshot: async () => snap(),
      beforeIrreversibleAction: makeInstantHook(),
      beforeIrreversibleActionTimeoutMs: NaN,
      setTimer: fakeSetTimer,
      clearTimer: fakeClearTimer,
    });
    expect(r.verdict).toBe('success');
  });

  test('beforeIrreversibleActionTimeoutMs: 1000 → valid override applied, hook proceeds', async () => {
    const { fakeSetTimer, fakeClearTimer } = makeFakeTimer();
    const r = await runWithContract({
      contract: { id: 'c', post: POST_OK, critical: true },
      skill: async () => 'ok',
      snapshot: async () => snap(),
      beforeIrreversibleAction: makeInstantHook(),
      beforeIrreversibleActionTimeoutMs: 1000,
      setTimer: fakeSetTimer,
      clearTimer: fakeClearTimer,
    });
    expect(r.verdict).toBe('success');
  });
});
