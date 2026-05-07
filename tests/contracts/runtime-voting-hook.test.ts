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
});
