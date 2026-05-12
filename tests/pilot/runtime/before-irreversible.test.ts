/**
 * Tests for the `beforeIrreversibleAction` hook (issue #795, Phase 3).
 *
 * Coverage:
 *   - Hook not invoked for non-critical contracts (default behavior preserved)
 *   - Default hook (no registration) returns proceed:true, contract proceeds
 *   - Registered hook returning `{ proceed: false, reason }` aborts with
 *     verdict `aborted_by_hook` and reason in the record
 *   - Registered hook returning `{ proceed: 'await-human', externalToken }`
 *     aborts with token in the record
 *   - Registering a second hook warns via console.error
 *   - Hook throw is treated as implicit deny (always-settles guarantee)
 *   - Non-critical contract is unchanged when hook is registered
 */

import { runWithContract } from '../../../src/pilot/runtime/index.js';
import {
  registerBeforeIrreversibleHook,
  resetBeforeIrreversibleHookForTests,
} from '../../../src/pilot/runtime/index.js';
import type {
  AuditEmitter,
  TransactionRecord,
} from '../../../src/pilot/runtime/index.js';
import type { EvalContext } from '../../../src/contracts/eval-context.js';
import type { Assertion } from '../../../src/contracts/types.js';
import { resetFlagsCache } from '../../../src/harness/flags.js';

// All tests run with the pilot flag forced on.
beforeEach(() => {
  process.argv = ['node', 'cli/index.js', '--pilot'];
  resetFlagsCache();
  resetBeforeIrreversibleHookForTests();
});

afterEach(() => {
  resetBeforeIrreversibleHookForTests();
});

const POST_OK: Assertion = { kind: 'dom_text', contains: 'Done' };

function ctx(bodyText = 'Done'): EvalContext {
  return {
    url: async () => 'https://example.com/',
    domText: async () => bodyText,
    domCount: async () => 0,
    networkSince: async () => [],
    screenshotPng: async () => null,
    hasOpenDialog: async () => false,
  };
}

function captureEmitter(): { emitter: AuditEmitter; records: TransactionRecord[] } {
  const records: TransactionRecord[] = [];
  return {
    emitter: { emit: (r) => { records.push(r); } },
    records,
  };
}

describe('beforeIrreversibleAction hook — non-critical contracts', () => {
  test('hook is NOT invoked for a non-critical contract (critical omitted)', async () => {
    let hookCalls = 0;
    registerBeforeIrreversibleHook(async () => {
      hookCalls++;
      return { proceed: true };
    });

    const r = await runWithContract({
      contract: { id: 'non-critical', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx('Done'),
    });

    expect(r.verdict).toBe('success');
    expect(hookCalls).toBe(0);
  });

  test('hook is NOT invoked for a contract with critical: false', async () => {
    let hookCalls = 0;
    registerBeforeIrreversibleHook(async () => {
      hookCalls++;
      return { proceed: true };
    });

    const r = await runWithContract({
      contract: { id: 'non-critical-false', post: POST_OK, critical: false },
      skill: async () => 'ok',
      snapshot: async () => ctx('Done'),
    });

    expect(r.verdict).toBe('success');
    expect(hookCalls).toBe(0);
  });
});

describe('beforeIrreversibleAction hook — default behavior (no registration)', () => {
  test('default hook allows critical contract to proceed (proceed: true)', async () => {
    // No registerBeforeIrreversibleHook call — default no-op hook must fire
    // and return proceed:true so the skill executes normally.
    const r = await runWithContract({
      contract: { id: 'critical-default', post: POST_OK, critical: true },
      skill: async () => 'done',
      snapshot: async () => ctx('Done'),
    });

    expect(r.verdict).toBe('success');
    expect(r.skill_result).toBe('done');
  });
});

describe('beforeIrreversibleAction hook — proceed: false', () => {
  test('hook returning { proceed: false, reason } aborts with aborted_by_hook verdict', async () => {
    registerBeforeIrreversibleHook(async () => ({
      proceed: false,
      reason: 'manual policy block',
    }));

    let skillCalls = 0;
    const r = await runWithContract({
      contract: { id: 'critical-blocked', post: POST_OK, critical: true },
      skill: async () => {
        skillCalls++;
        return 'never';
      },
      snapshot: async () => ctx('Done'),
    });

    expect(r.verdict).toBe('aborted_by_hook');
    expect(r.error_message).toBe('manual policy block');
    expect(r.hook_decision?.reason).toBe('manual policy block');
    expect(skillCalls).toBe(0);
  });

  test('aborted_by_hook record is emitted to audit', async () => {
    const { emitter, records } = captureEmitter();
    registerBeforeIrreversibleHook(async () => ({
      proceed: false,
      reason: 'audit check',
    }));

    const r = await runWithContract({
      contract: { id: 'critical-audit', post: POST_OK, critical: true },
      skill: async () => 'never',
      snapshot: async () => ctx('Done'),
      audit: emitter,
    });

    expect(records).toHaveLength(1);
    expect(records[0].verdict).toBe('aborted_by_hook');
    expect(r.contract_id).toBe('critical-audit');
  });

  test('action label in hook_decision defaults to contract id when action omitted', async () => {
    registerBeforeIrreversibleHook(async () => ({
      proceed: false,
      reason: 'blocked',
    }));

    const r = await runWithContract({
      contract: { id: 'my-contract', post: POST_OK, critical: true },
      skill: async () => 'never',
      snapshot: async () => ctx('Done'),
    });

    expect(r.hook_decision?.action).toBe('my-contract');
  });

  test('action label in hook_decision uses contract.action when set', async () => {
    registerBeforeIrreversibleHook(async () => ({
      proceed: false,
      reason: 'blocked',
    }));

    const r = await runWithContract({
      contract: {
        id: 'my-contract',
        post: POST_OK,
        critical: true,
        action: 'submit-checkout',
      },
      skill: async () => 'never',
      snapshot: async () => ctx('Done'),
    });

    expect(r.hook_decision?.action).toBe('submit-checkout');
  });
});

describe('beforeIrreversibleAction hook — proceed: await-human', () => {
  test('hook returning await-human aborts with externalToken in details', async () => {
    const token = 'approval-token-abc123';
    registerBeforeIrreversibleHook(async () => ({
      proceed: 'await-human',
      externalToken: token,
    }));

    let skillCalls = 0;
    const r = await runWithContract({
      contract: { id: 'critical-await', post: POST_OK, critical: true },
      skill: async () => {
        skillCalls++;
        return 'never';
      },
      snapshot: async () => ctx('Done'),
    });

    expect(r.verdict).toBe('aborted_by_hook');
    expect(r.error_message).toContain(token);
    expect(r.hook_decision?.external_token).toBe(token);
    expect(skillCalls).toBe(0);
  });

  test('await-human record is emitted to audit with token', async () => {
    const { emitter, records } = captureEmitter();
    const token = 'mfa-challenge-xyz';
    registerBeforeIrreversibleHook(async () => ({
      proceed: 'await-human',
      externalToken: token,
    }));

    await runWithContract({
      contract: { id: 'critical-mfa', post: POST_OK, critical: true },
      skill: async () => 'never',
      snapshot: async () => ctx('Done'),
      audit: emitter,
    });

    expect(records).toHaveLength(1);
    expect(records[0].hook_decision?.external_token).toBe(token);
  });
});

describe('beforeIrreversibleAction hook — registration warnings', () => {
  test('registering a second hook emits a console.error warning', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // First registration — replaces the default no-op (no warning).
      registerBeforeIrreversibleHook(async () => ({ proceed: true }));
      expect(errorSpy).not.toHaveBeenCalled();

      // Second registration — replaces a non-default hook (warning).
      registerBeforeIrreversibleHook(async () => ({ proceed: true }));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain('beforeIrreversibleAction hook replaced');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('registering over the default (first call) does NOT warn', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registerBeforeIrreversibleHook(async () => ({ proceed: true }));
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('beforeIrreversibleAction hook — always-settles guarantee', () => {
  test('hook that throws is treated as implicit deny (aborted_by_hook)', async () => {
    registerBeforeIrreversibleHook(async () => {
      throw new Error('hook exploded');
    });

    let skillCalls = 0;
    const r = await runWithContract({
      contract: { id: 'critical-throw', post: POST_OK, critical: true },
      skill: async () => {
        skillCalls++;
        return 'never';
      },
      snapshot: async () => ctx('Done'),
    });

    expect(r.verdict).toBe('aborted_by_hook');
    expect(r.error_message).toContain('hook threw');
    expect(r.error_message).toContain('hook exploded');
    expect(skillCalls).toBe(0);
  });
});

describe('beforeIrreversibleAction hook — proceed: true for critical contracts', () => {
  test('hook returning { proceed: true } allows critical contract to execute', async () => {
    let hookCalls = 0;
    registerBeforeIrreversibleHook(async () => {
      hookCalls++;
      return { proceed: true };
    });

    const r = await runWithContract({
      contract: { id: 'critical-allowed', post: POST_OK, critical: true },
      skill: async () => 'executed',
      snapshot: async () => ctx('Done'),
    });

    expect(r.verdict).toBe('success');
    expect(r.skill_result).toBe('executed');
    expect(hookCalls).toBe(1);
  });

  test('hook is invoked exactly once per runWithContract call', async () => {
    let hookCalls = 0;
    registerBeforeIrreversibleHook(async () => {
      hookCalls++;
      return { proceed: true };
    });

    await runWithContract({
      contract: { id: 'critical-once', post: POST_OK, critical: true },
      skill: async () => 'ok',
      snapshot: async () => ctx('Done'),
    });

    expect(hookCalls).toBe(1);
  });
});

describe('beforeIrreversibleAction hook — pre_evidence forwarded', () => {
  test('hook receives pre_evidence when contract has a pre-condition', async () => {
    let capturedEvidence: unknown;
    registerBeforeIrreversibleHook(async (input) => {
      capturedEvidence = input.evidence;
      return { proceed: false, reason: 'inspect evidence' };
    });

    const PRE: Assertion = { kind: 'url', pattern: 'example\\.com' };
    await runWithContract({
      contract: { id: 'critical-pre', pre: PRE, post: POST_OK, critical: true },
      skill: async () => 'never',
      snapshot: async () => ctx('Done'),
    });

    // Pre-condition evidence should be passed to the hook.
    expect(capturedEvidence).toBeDefined();
    expect((capturedEvidence as { passed?: boolean }).passed).toBe(true);
  });

  test('hook receives undefined evidence when contract has no pre-condition', async () => {
    let capturedEvidence: unknown = 'sentinel';
    registerBeforeIrreversibleHook(async (input) => {
      capturedEvidence = input.evidence;
      return { proceed: true };
    });

    await runWithContract({
      contract: { id: 'critical-nopre', post: POST_OK, critical: true },
      skill: async () => 'ok',
      snapshot: async () => ctx('Done'),
    });

    expect(capturedEvidence).toBeUndefined();
  });
});
