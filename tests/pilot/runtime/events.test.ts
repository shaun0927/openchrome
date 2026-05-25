/**
 * Verifies that `contractRuntimeEvents` receives exactly one
 * `transaction:settled` event per `runWithContract` call across the
 * full verdict taxonomy, and that a listener throw cannot rewrite
 * the verdict (always-settles guarantee preserved).
 */

import {
  runWithContract,
  contractRuntimeEvents,
} from '../../../src/pilot/runtime/index.js';
import type { TransactionRecord } from '../../../src/pilot/runtime/index.js';
import type { EvalContext } from '../../../src/contracts/eval-context.js';
import type { Assertion } from '../../../src/contracts/types.js';
import { resetFlagsCache } from '../../../src/harness/flags.js';

beforeEach(() => {
  process.argv = ['node', 'cli/index.js', '--pilot'];
  resetFlagsCache();
  contractRuntimeEvents.removeAllListeners('transaction:settled');
});

afterEach(() => {
  contractRuntimeEvents.removeAllListeners('transaction:settled');
});

function ctx(over: { url?: string; bodyText?: string } = {}): EvalContext {
  return {
    url: async () => over.url ?? 'https://example.com/',
    domText: async () => over.bodyText ?? '',
    domCount: async () => 0,
    networkSince: async () => [],
    screenshotPng: async () => null,
    hasOpenDialog: async () => false,
  };
}

const POST_OK: Assertion = { kind: 'dom_text', contains: 'Done' };

describe('contractRuntimeEvents.transaction:settled', () => {
  test('fires exactly once per success run with the full record', async () => {
    const received: TransactionRecord[] = [];
    contractRuntimeEvents.on('transaction:settled', (r) => { received.push(r); });

    const result = await runWithContract({
      contract: { id: 'c-success', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Done' }),
    });
    expect(result.verdict).toBe('success');
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(result);
  });

  test('fires for precondition_violation', async () => {
    const received: TransactionRecord[] = [];
    contractRuntimeEvents.on('transaction:settled', (r) => { received.push(r); });

    const result = await runWithContract({
      contract: {
        id: 'c-pre',
        pre: { kind: 'url', pattern: 'never-matches\\.com' },
        post: POST_OK,
      },
      skill: async () => 'must-not-run',
      snapshot: async () => ctx({ url: 'https://example.com/' }),
    });
    expect(result.verdict).toBe('precondition_violation');
    expect(received).toHaveLength(1);
    expect(received[0]?.verdict).toBe('precondition_violation');
  });

  test('fires for validation_error', async () => {
    const received: TransactionRecord[] = [];
    contractRuntimeEvents.on('transaction:settled', (r) => { received.push(r); });

    const malformed = { kind: 'no_such_kind' } as unknown as Assertion;
    const result = await runWithContract({
      contract: { id: 'c-val', post: malformed },
      skill: async () => 'ok',
      snapshot: async () => ctx(),
    });
    expect(result.verdict).toBe('validation_error');
    expect(received).toHaveLength(1);
    expect(received[0]?.verdict).toBe('validation_error');
  });

  test('does NOT fire when contract-runtime family is disabled', async () => {
    process.argv = ['node', 'cli/index.js'];
    resetFlagsCache();
    const received: TransactionRecord[] = [];
    contractRuntimeEvents.on('transaction:settled', (r) => { received.push(r); });

    const result = await runWithContract({
      contract: { id: 'c-disabled', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx(),
    });
    expect(result.verdict).toBe('execution_error');
    expect(received).toHaveLength(0);
  });

  test('a throwing listener does not rewrite the verdict (always-settles)', async () => {
    contractRuntimeEvents.on('transaction:settled', () => {
      throw new Error('listener blew up');
    });
    const result = await runWithContract({
      contract: { id: 'c-throwy-listener', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Done' }),
    });
    expect(result.verdict).toBe('success');
    expect(result.skill_result).toBe('ok');
  });
});
