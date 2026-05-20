/**
 * Integration tests for `computeStateHash` wiring on `runWithContract`.
 *
 * Verifies that:
 *   - Success records carry `state_hash` + `state_hash_version`.
 *   - precondition_violation / postcondition_violation records also
 *     carry the hash (every settle path that touched the world).
 *   - validation_error records do NOT carry the hash (we bail before
 *     hashing, by design).
 *   - When `computeStateHash` is absent, no fields are emitted —
 *     preserves backwards compatibility with callers that haven't
 *     wired the hook.
 *   - A throwing/rejecting hasher does not break the runtime's
 *     always-settles guarantee.
 *   - A hasher returning `null` results in no hash on the record
 *     (rather than an empty string).
 */

import { runWithContract } from '../../../src/pilot/runtime/index.js';
import type {
  AuditEmitter,
  TransactionRecord,
} from '../../../src/pilot/runtime/index.js';
import type { EvalContext } from '../../../src/contracts/eval-context.js';
import type { Assertion } from '../../../src/contracts/types.js';
import { resetFlagsCache } from '../../../src/harness/flags.js';

beforeEach(() => {
  process.argv = ['node', 'cli/index.js', '--pilot'];
  resetFlagsCache();
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

function captureEmitter(): { emitter: AuditEmitter; records: TransactionRecord[] } {
  const records: TransactionRecord[] = [];
  return { emitter: { emit: (r) => { records.push(r); } }, records };
}

const POST_OK: Assertion = { kind: 'dom_text', contains: 'Done' };
const PRE_URL: Assertion = { kind: 'url', pattern: 'example\\.com' };

describe('runtime ↔ state-hash integration', () => {
  test('success record carries state_hash and state_hash_version', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c1', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Done' }),
      audit: emitter,
      computeStateHash: async () => 'deadbeefcafef00d',
    });
    expect(r.verdict).toBe('success');
    expect(r.state_hash).toBe('deadbeefcafef00d');
    expect(r.state_hash_version).toBe('v1');
    expect(records[0]?.state_hash).toBe('deadbeefcafef00d');
    expect(records[0]?.state_hash_version).toBe('v1');
  });

  test('precondition_violation carries state_hash', async () => {
    const { emitter, records } = captureEmitter();
    // Pre demands url contain 'example.com' but we serve a snapshot
    // whose URL does not match — pre fails.
    const r = await runWithContract({
      contract: {
        id: 'c2',
        pre: { kind: 'url', pattern: 'never-matches\\.com' },
        post: POST_OK,
      },
      skill: async () => { throw new Error('skill must not run'); },
      snapshot: async () => ctx({ url: 'https://example.com/' }),
      audit: emitter,
      computeStateHash: async () => 'a1b2c3d4e5f60718',
    });
    expect(r.verdict).toBe('precondition_violation');
    expect(r.state_hash).toBe('a1b2c3d4e5f60718');
    expect(records[0]?.state_hash).toBe('a1b2c3d4e5f60718');
  });

  test('postcondition_violation carries state_hash', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c3', post: { kind: 'dom_text', contains: 'NeverThere' } },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'something else' }),
      audit: emitter,
      computeStateHash: async () => '1111222233334444',
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.state_hash).toBe('1111222233334444');
    expect(records[0]?.state_hash).toBe('1111222233334444');
  });

  test('validation_error does NOT carry state_hash (bailed before hashing)', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      // post intentionally malformed → validation_error
      contract: { id: 'c4', post: { kind: 'no_such_kind' as unknown as Assertion['kind'] } as Assertion },
      skill: async () => 'ok',
      snapshot: async () => ctx(),
      audit: emitter,
      computeStateHash: async () => 'should-not-be-attached',
    });
    expect(r.verdict).toBe('validation_error');
    expect(r.state_hash).toBeUndefined();
    expect(r.state_hash_version).toBeUndefined();
    expect(records[0]?.state_hash).toBeUndefined();
  });

  test('no computeStateHash provided — record carries neither field', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c5', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Done' }),
      audit: emitter,
    });
    expect(r.verdict).toBe('success');
    expect(r.state_hash).toBeUndefined();
    expect(r.state_hash_version).toBeUndefined();
    expect(records[0]?.state_hash).toBeUndefined();
    expect(records[0]?.state_hash_version).toBeUndefined();
  });

  test('throwing computeStateHash does not break always-settles', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c6', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Done' }),
      audit: emitter,
      computeStateHash: async () => { throw new Error('hash blew up'); },
    });
    expect(r.verdict).toBe('success');
    expect(r.state_hash).toBeUndefined();
    expect(r.state_hash_version).toBeUndefined();
    expect(records).toHaveLength(1);
  });

  test('synchronously throwing computeStateHash is also swallowed', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c7', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Done' }),
      audit: emitter,
      // Cast through unknown to bypass the async return-type narrowing —
      // we want to prove the runtime guards against a hasher that violates
      // the typed contract and throws synchronously.
      computeStateHash: (() => { throw new Error('sync throw'); }) as unknown as () => Promise<string | null>,
    });
    expect(r.verdict).toBe('success');
    expect(r.state_hash).toBeUndefined();
    expect(records).toHaveLength(1);
  });

  test('computeStateHash returning null leaves both fields absent', async () => {
    const { emitter, records } = captureEmitter();
    const r = await runWithContract({
      contract: { id: 'c8', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Done' }),
      audit: emitter,
      computeStateHash: async () => null,
    });
    expect(r.verdict).toBe('success');
    expect(r.state_hash).toBeUndefined();
    expect(r.state_hash_version).toBeUndefined();
    expect(records[0]?.state_hash).toBeUndefined();
  });

  test('computeStateHash invoked at most once per run', async () => {
    let calls = 0;
    const r = await runWithContract({
      contract: {
        id: 'c9',
        post: { kind: 'dom_text', contains: 'NeverThere' },
        on_fail: { retry: 2 },
      },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'mismatch' }),
      // Replace the default delay with a no-op so retries don't burn real time.
      delay: async () => {},
      computeStateHash: async () => {
        calls += 1;
        return 'aaaabbbbccccdddd';
      },
    });
    expect(r.verdict).toBe('postcondition_violation');
    expect(r.state_hash).toBe('aaaabbbbccccdddd');
    expect(calls).toBe(1);
  });
});

describe('runtime ↔ state-hash — pilot disabled', () => {
  test('when contract-runtime family is disabled, record has no state_hash', async () => {
    // Drop the pilot flag so isContractRuntimeEnabled() returns false.
    process.argv = ['node', 'cli/index.js'];
    resetFlagsCache();
    const r = await runWithContract({
      contract: { id: 'cX', post: POST_OK },
      skill: async () => 'ok',
      snapshot: async () => ctx({ bodyText: 'Done' }),
      computeStateHash: async () => 'should-be-ignored',
    });
    expect(r.verdict).toBe('execution_error');
    expect(r.state_hash).toBeUndefined();
    expect(r.state_hash_version).toBeUndefined();
  });
});
