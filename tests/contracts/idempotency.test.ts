import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SqliteIdempotencyStore,
  canonicalJson,
  computeIdempotencyKey,
} from '../../src/contracts/idempotency';
import { runWithContract } from '../../src/contracts/runtime';
import type { Contract, TransactionRecord } from '../../src/contracts/runtime';
import type { AssertionContext } from '../../src/contracts/evaluator';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-idem-'));
}

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

function record(over: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    txn_id: 't1',
    contract_id: 'c1',
    verdict: 'success',
    started_at: 1000,
    ended_at: 2000,
    wall_ms: 1000,
    retries: 0,
    skill_result: 'ok',
    ...over,
  };
}

describe('canonicalJson', () => {
  test('sorts keys recursively', () => {
    expect(canonicalJson({ b: 2, a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1},"b":2}');
  });

  test('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('computeIdempotencyKey', () => {
  test('same contract + args yields same key regardless of authoring order', () => {
    const a: Contract = {
      id: 'c',
      idempotency_key: 'op-1',
      pre: { kind: 'no_dialog' },
      post: { kind: 'no_dialog' },
    };
    const b: Contract = {
      id: 'c',
      post: { kind: 'no_dialog' },
      pre: { kind: 'no_dialog' },
      idempotency_key: 'op-1',
    };
    expect(computeIdempotencyKey(a, { x: 1, y: 2 })).toBe(
      computeIdempotencyKey(b, { y: 2, x: 1 }),
    );
  });

  test('different contracts produce different keys', () => {
    const a: Contract = { id: 'c1', post: { kind: 'no_dialog' } };
    const b: Contract = { id: 'c2', post: { kind: 'no_dialog' } };
    expect(computeIdempotencyKey(a)).not.toBe(computeIdempotencyKey(b));
  });

  test('different args produce different keys', () => {
    const c: Contract = { id: 'c', idempotency_key: 'op-1', post: { kind: 'no_dialog' } };
    expect(computeIdempotencyKey(c, { a: 1 })).not.toBe(computeIdempotencyKey(c, { a: 2 }));
  });

  test('returns 64-char hex (sha256)', () => {
    const k = computeIdempotencyKey({ id: 'c', post: { kind: 'no_dialog' } });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SqliteIdempotencyStore — basic CRUD', () => {
  let root: string;
  let store: SqliteIdempotencyStore;

  beforeEach(() => {
    root = tempRoot();
    store = new SqliteIdempotencyStore({ rootDir: root, now: () => 1_000_000 });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('miss returns undefined', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  test('put + get round-trips a TransactionRecord', () => {
    store.put('k1', record());
    const got = store.get('k1');
    expect(got?.txn_id).toBe('t1');
    expect(got?.verdict).toBe('success');
  });

  test('put with same key overwrites', () => {
    store.put('k', record({ skill_result: 'a' }));
    store.put('k', record({ skill_result: 'b' }));
    expect(store.get('k')?.skill_result).toBe('b');
  });
});

describe('SqliteIdempotencyStore — TTL sweep', () => {
  let root: string;
  let now = 0;

  beforeEach(() => {
    root = tempRoot();
    now = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('entries older than TTL are purged on read', () => {
    const ttlMs = 1000;
    const store = new SqliteIdempotencyStore({
      rootDir: root,
      ttlMs,
      now: () => now,
    });
    now = 100;
    store.put('old', record());
    now = 100 + ttlMs + 1; // expire
    expect(store.get('old')).toBeUndefined();
    store.close();
  });

  test('used_at advances on every hit (LRU semantics)', () => {
    const ttlMs = 1000;
    const store = new SqliteIdempotencyStore({
      rootDir: root,
      ttlMs,
      now: () => now,
    });
    now = 100;
    store.put('hot', record()); // used_at = 100

    // Tick to 500: hit refreshes used_at to 500. The row is now young
    // again — even though >ttl elapsed since the put, the access made
    // it survive.
    now = 500;
    expect(store.get('hot')).toBeDefined();

    // Sliding window: now = used_at + ttl − 1 → still alive.
    now = 500 + ttlMs - 1;
    expect(store.get('hot')).toBeDefined(); // refreshes used_at = 1499

    // Now jump past the new used_at + ttl (1499 + 1000 = 2499). The
    // sweep at now=2500 (now − ttl = 1500 > 1499) drops it.
    now = 1499 + ttlMs + 1;
    expect(store.get('hot')).toBeUndefined();
    store.close();
  });

  test('purgeOlderThan returns purged count', () => {
    const store = new SqliteIdempotencyStore({ rootDir: root, now: () => 1000 });
    store.put('a', record());
    store.put('b', record());
    expect(store.purgeOlderThan(2000)).toBe(2);
    expect(store.purgeOlderThan(2000)).toBe(0);
    store.close();
  });
});

describe('runWithContract — idempotency cache', () => {
  let root: string;
  let store: SqliteIdempotencyStore;

  beforeEach(() => {
    root = tempRoot();
    store = new SqliteIdempotencyStore({ rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('first call runs the skill; second call hits cache, skill never runs', async () => {
    let skillCalls = 0;
    const c: Contract = {
      id: 'c-idem',
      idempotency_key: 'logical-1',
      post: { kind: 'no_dialog' },
    };
    const args = {
      contract: c,
      skill: async () => {
        skillCalls++;
        return 'ran';
      },
      snapshot: async () => snap(),
      idempotency: store,
    };
    const r1 = await runWithContract(args);
    expect(r1.verdict).toBe('success');
    expect(r1.from_cache).toBeUndefined();
    expect(skillCalls).toBe(1);

    const r2 = await runWithContract(args);
    expect(r2.verdict).toBe('success');
    expect(r2.from_cache).toBe(true);
    expect(skillCalls).toBe(1); // unchanged
  });

  test('postcondition_violation is NOT cached (#706 v2 — page state may change)', async () => {
    const c: Contract = {
      id: 'c-fail',
      idempotency_key: 'op-2',
      post: { kind: 'dom_text', contains: 'unreachable text' },
    };
    let skillCalls = 0;
    const r1 = await runWithContract({
      contract: c,
      skill: async () => {
        skillCalls++;
      },
      snapshot: async () => snap(),
      idempotency: store,
    });
    expect(r1.verdict).toBe('postcondition_violation');
    // Second call must re-execute (no cache hit)
    await runWithContract({
      contract: c,
      skill: async () => {
        skillCalls++;
      },
      snapshot: async () => snap(),
      idempotency: store,
    });
    expect(skillCalls).toBe(2);
  });

  test('critical=false cached success does NOT short-circuit a critical=true run (P2A regression)', async () => {
    // A non-critical run succeeds and is cached. A subsequent run with the
    // same contract shape but critical=true MUST NOT hit that cache — the
    // voting hook must be invoked, not bypassed.
    let hookCalls = 0;
    const hook = async () => {
      hookCalls++;
      return { proceed: true };
    };
    const baseContract = {
      id: 'c-critical',
      idempotency_key: 'critical-regression',
      post: { kind: 'no_dialog' as const },
    };
    // First run: non-critical, no hook supplied. Caches the success.
    const r1 = await runWithContract({
      contract: { ...baseContract, critical: false },
      skill: async () => 'non-critical run',
      snapshot: async () => snap(),
      idempotency: store,
    });
    expect(r1.verdict).toBe('success');
    expect(r1.from_cache).toBeUndefined();

    // Second run: critical=true with the hook. Must NOT be a cache hit.
    let skillCalls = 0;
    const r2 = await runWithContract({
      contract: { ...baseContract, critical: true },
      skill: async () => { skillCalls++; return 'critical run'; },
      snapshot: async () => snap(),
      idempotency: store,
      beforeIrreversibleAction: hook,
    });
    expect(r2.verdict).toBe('success');
    expect(r2.from_cache).toBeUndefined(); // must not be from cache
    expect(hookCalls).toBe(1); // hook was invoked
    expect(skillCalls).toBe(1); // skill ran fresh
  });

  test('hook-inactive cached success does NOT short-circuit a hook-active run (round-6 regression)', async () => {
    // Scenario: a critical contract runs WITHOUT a hook and succeeds → cached.
    // A subsequent run with the same contract + hook MUST NOT hit that cache;
    // the hook must fire and the skill must run fresh.
    let hookCalls = 0;
    const hook = async () => {
      hookCalls++;
      return { proceed: true };
    };
    const baseContract: Contract = {
      id: 'c-hook-rollout',
      idempotency_key: 'hook-rollout-key',
      post: { kind: 'no_dialog' as const },
      critical: true,
    };

    // First run: critical=true, NO hook. Caches the success under hook_active=false.
    let skillCalls = 0;
    const r1 = await runWithContract({
      contract: baseContract,
      skill: async () => { skillCalls++; return 'no-hook run'; },
      snapshot: async () => snap(),
      idempotency: store,
    });
    expect(r1.verdict).toBe('success');
    expect(r1.from_cache).toBeUndefined();
    expect(skillCalls).toBe(1);

    // Second run: same contract, same idempotency_key, but hook NOW enabled.
    // Must NOT replay from cache — hook must fire and skill must run fresh.
    const r2 = await runWithContract({
      contract: baseContract,
      skill: async () => { skillCalls++; return 'hook run'; },
      snapshot: async () => snap(),
      idempotency: store,
      beforeIrreversibleAction: hook,
    });
    expect(r2.verdict).toBe('success');
    expect(r2.from_cache).toBeUndefined(); // must not replay from cache
    expect(hookCalls).toBe(1);             // hook was invoked
    expect(skillCalls).toBe(2);            // skill ran fresh

    // Third run: hook still enabled. Now caches under hook_active=true → hits.
    const r3 = await runWithContract({
      contract: baseContract,
      skill: async () => { skillCalls++; return 'hook run 2'; },
      snapshot: async () => snap(),
      idempotency: store,
      beforeIrreversibleAction: hook,
    });
    expect(r3.verdict).toBe('success');
    expect(r3.from_cache).toBe(true); // now hits the hook-active cache entry
    expect(skillCalls).toBe(2);       // skill did NOT run again
    expect(hookCalls).toBe(1);        // hook was NOT called on cache hit
  });

  test('explicit args.idempotencyKey override is salted — critical/hook state change MUST NOT replay cache (round-7 regression)', async () => {
    // Scenario: caller supplies args.idempotencyKey = 'foo'.
    // Run 1: critical=false, no hook → success cached.
    // Run 2: same override 'foo' but critical=true + hook enabled →
    //   MUST NOT be a cache hit; hook must fire and skill must run fresh.
    let skillCalls = 0;
    let hookCalls = 0;
    const hook = async () => {
      hookCalls++;
      return { proceed: true };
    };
    const contract: Contract = {
      id: 'c-override-salt',
      post: { kind: 'no_dialog' as const },
    };

    // Run 1: non-critical, no hook, explicit override key.
    const r1 = await runWithContract({
      contract: { ...contract, critical: false },
      skill: async () => { skillCalls++; return 'run1'; },
      snapshot: async () => snap(),
      idempotency: store,
      idempotencyKey: 'foo',
    });
    expect(r1.verdict).toBe('success');
    expect(r1.from_cache).toBeUndefined();
    expect(skillCalls).toBe(1);

    // Run 2: critical=true + hook. Same override key 'foo'.
    // The override must be salted differently → cache miss → hook fires.
    const r2 = await runWithContract({
      contract: { ...contract, critical: true },
      skill: async () => { skillCalls++; return 'run2'; },
      snapshot: async () => snap(),
      idempotency: store,
      idempotencyKey: 'foo',
      beforeIrreversibleAction: hook,
    });
    expect(r2.verdict).toBe('success');
    expect(r2.from_cache).toBeUndefined(); // must not replay run-1 cache
    expect(hookCalls).toBe(1);             // hook invoked
    expect(skillCalls).toBe(2);            // skill ran fresh

    // Run 3: same critical=true + hook again → should now hit run-2 cache.
    const r3 = await runWithContract({
      contract: { ...contract, critical: true },
      skill: async () => { skillCalls++; return 'run3'; },
      snapshot: async () => snap(),
      idempotency: store,
      idempotencyKey: 'foo',
      beforeIrreversibleAction: hook,
    });
    expect(r3.verdict).toBe('success');
    expect(r3.from_cache).toBe(true); // now hits the salted cache entry
    expect(skillCalls).toBe(2);       // skill did NOT run again
    expect(hookCalls).toBe(1);        // hook was NOT called on cache hit
  });

  test('different idempotency_key bypasses the cache', async () => {
    let skillCalls = 0;
    const make = (key: string) => ({
      contract: {
        id: 'c',
        idempotency_key: key,
        post: { kind: 'no_dialog' as const },
      },
      skill: async () => {
        skillCalls++;
      },
      snapshot: async () => snap(),
      idempotency: store,
    });
    await runWithContract(make('a'));
    await runWithContract(make('b'));
    expect(skillCalls).toBe(2);
  });
});

describe('runWithContract — preemptive cancellation', () => {
  test('preemptive timer aborts a hung skill → budget_exhausted (hard_kill=true)', async () => {
    let timerHandler: (() => void) | null = null;
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: { kind: 'no_dialog' },
        budget: { wall_ms: 50 },
      },
      skill: async (signal) => {
        // Simulate a hung skill that does observe AbortSignal.
        return new Promise<unknown>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
          // Trip the test's manual timer to simulate the preemptive deadline.
          setTimeout(() => timerHandler?.(), 5);
        });
      },
      snapshot: async () => snap(),
      // Capture the timer instead of letting it auto-fire — we trigger it
      // synchronously inside the skill so this test stays sub-millisecond.
      setTimer: (handler) => {
        timerHandler = handler;
        return null;
      },
      clearTimer: () => undefined,
    });
    expect(r.verdict).toBe('budget_exhausted');
    expect(r.hard_kill).toBe(true);
    expect(r.error_message).toContain('preemptive timer');
  });

  test('skill that ignores AbortSignal still settles as budget_exhausted', async () => {
    let timerHandler: (() => void) | null = null;
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: { kind: 'no_dialog' },
        budget: { wall_ms: 50 },
      },
      skill: async () => {
        // Doesn't respect signal; trigger preemption then resolve normally
        await new Promise((resolve) => {
          setTimeout(() => {
            timerHandler?.();
            resolve(undefined);
          }, 5);
        });
        return 'done anyway';
      },
      snapshot: async () => snap(),
      setTimer: (handler) => {
        timerHandler = handler;
        return null;
      },
      clearTimer: () => undefined,
    });
    expect(r.verdict).toBe('budget_exhausted');
    expect(r.hard_kill).toBe(true);
    expect(r.error_message).toContain('ignored AbortSignal');
  });

  test('preemptive timer is cleared when skill completes within budget', async () => {
    let timerCleared = false;
    const r = await runWithContract({
      contract: {
        id: 'c',
        post: { kind: 'no_dialog' },
        budget: { wall_ms: 1000 },
      },
      skill: async () => undefined,
      snapshot: async () => snap(),
      setTimer: () => 'handle-token',
      clearTimer: (h) => {
        if (h === 'handle-token') timerCleared = true;
      },
    });
    expect(r.verdict).toBe('success');
    expect(timerCleared).toBe(true);
  });
});
