/**
 * Tests for the pilot auto-memory subscriber.
 *
 * Verifies:
 *   - On `verdict === 'success'`, every selector under
 *     `pre_evidence.details` / `post_evidence.details` is forwarded
 *     to `DomainMemory.record`.
 *   - On `verdict === 'postcondition_violation'`, the same selectors
 *     are pushed through `DomainMemory.validate(id, false)` so
 *     confidence decays.
 *   - Non-DOM contracts (no selectors anywhere in evidence) are a
 *     quiet no-op.
 *   - Listener throws are surfaced via `onProcessed` without
 *     rethrowing.
 *   - `unregister()` is idempotent.
 */

import { contractRuntimeEvents } from '../../../src/pilot/runtime/index.js';
import { registerAutoMemory } from '../../../src/pilot/auto-memory/index.js';
import type { TransactionRecord } from '../../../src/pilot/runtime/index.js';
import type { DomainMemory } from '../../../src/memory/domain-memory.js';

interface RecordedEntry {
  id: string;
  domain: string;
  key: string;
  value: string;
  confidence: number;
}

function makeFakeMemory(): {
  fake: Pick<DomainMemory, 'record' | 'validate' | 'query'>;
  records: RecordedEntry[];
  validations: Array<{ id: string; success: boolean }>;
} {
  const records: RecordedEntry[] = [];
  const validations: Array<{ id: string; success: boolean }> = [];
  let counter = 0;
  const fake = {
    record(domain: string, key: string, value: string) {
      const existing = records.find((r) => r.domain === domain && r.key === key);
      if (existing) {
        existing.confidence += 1;
        existing.value = value;
        return existing as unknown as ReturnType<DomainMemory['record']>;
      }
      counter += 1;
      const entry: RecordedEntry = { id: `id-${counter}`, domain, key, value, confidence: 1 };
      records.push(entry);
      return entry as unknown as ReturnType<DomainMemory['record']>;
    },
    validate(id: string, success: boolean) {
      validations.push({ id, success });
      const entry = records.find((r) => r.id === id);
      if (entry && !success) entry.confidence = Math.max(0, entry.confidence - 1);
      return (entry ?? null) as unknown as ReturnType<DomainMemory['validate']>;
    },
    query(domain: string, key?: string) {
      const filtered = records.filter((r) => r.domain === domain && (key === undefined || r.key === key));
      return filtered as unknown as ReturnType<DomainMemory['query']>;
    },
  };
  return { fake, records, validations };
}

function awaitProcessed<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function successRecord(over: Partial<TransactionRecord> = {}): TransactionRecord {
  const now = Date.now();
  return {
    txn_id: 't-1',
    contract_id: 'cart.add',
    verdict: 'success',
    started_at: now,
    ended_at: now,
    wall_ms: 0,
    retries: 0,
    contract_domain: 'example.com',
    pre_evidence: {
      passed: true,
      assertion_kind: 'dom_text',
      details: { selector: '#add-to-cart', matched: true },
    },
    post_evidence: {
      passed: true,
      assertion_kind: 'dom_count',
      details: { selector: '.cart-row', count: 1 },
    },
    ...over,
  };
}

beforeEach(() => {
  contractRuntimeEvents.removeAllListeners('transaction:settled');
});

afterEach(() => {
  contractRuntimeEvents.removeAllListeners('transaction:settled');
});

describe('registerAutoMemory', () => {
  it('records every selector in evidence on success', async () => {
    const { fake, records } = makeFakeMemory();
    const { promise, resolve } = awaitProcessed<{ ok: boolean }>();
    const handle = registerAutoMemory({
      memory: fake,
      onProcessed: (e) => resolve(e),
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord());
    expect((await promise).ok).toBe(true);

    const keys = records.map((r) => r.key).sort();
    expect(keys).toEqual(['selector:#add-to-cart', 'selector:.cart-row']);
    expect(records.every((r) => r.domain === 'example.com')).toBe(true);
    expect(records.every((r) => r.value === 'cart.add')).toBe(true);
    handle.unregister();
  });

  it('dedupes selectors that appear in both pre and post evidence', async () => {
    const { fake, records } = makeFakeMemory();
    const { promise, resolve } = awaitProcessed<{ ok: boolean }>();
    const handle = registerAutoMemory({
      memory: fake,
      onProcessed: (e) => resolve(e),
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      pre_evidence: { passed: true, assertion_kind: 'dom_text', details: { selector: '#x' } },
      post_evidence: { passed: true, assertion_kind: 'dom_text', details: { selector: '#x' } },
    }));
    await promise;
    expect(records).toHaveLength(1);
    expect(records[0]?.key).toBe('selector:#x');
    handle.unregister();
  });

  it('is a quiet no-op when no selectors appear in evidence', async () => {
    const { fake, records } = makeFakeMemory();
    const { promise, resolve } = awaitProcessed<{ ok: boolean }>();
    const handle = registerAutoMemory({
      memory: fake,
      onProcessed: (e) => resolve(e),
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      pre_evidence: { passed: true, assertion_kind: 'url', details: { url: 'https://example.com/' } },
      post_evidence: { passed: true, assertion_kind: 'url', details: { url: 'https://example.com/cart' } },
    }));
    await promise;
    expect(records).toHaveLength(0);
    handle.unregister();
  });

  it('decays confidence on postcondition_violation', async () => {
    const { fake, records, validations } = makeFakeMemory();
    // Seed memory with a prior successful record for the selector.
    fake.record('example.com', 'selector:#add-to-cart', 'cart.add');
    expect(records[0]?.confidence).toBe(1);

    const { promise, resolve } = awaitProcessed<{ ok: boolean }>();
    const handle = registerAutoMemory({
      memory: fake,
      onProcessed: (e) => resolve(e),
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'postcondition_violation',
      post_evidence: { passed: false, assertion_kind: 'dom_text', details: { selector: '#add-to-cart' } },
    }));
    await promise;
    expect(validations).toEqual([{ id: 'id-1', success: false }]);
    expect(records[0]?.confidence).toBe(0);
    handle.unregister();
  });

  it('skips verdicts that are neither success nor postcondition_violation', async () => {
    const { fake, records } = makeFakeMemory();
    let calls = 0;
    const handle = registerAutoMemory({
      memory: fake,
      onProcessed: () => { calls += 1; },
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord({ verdict: 'execution_error' }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({ verdict: 'precondition_violation' }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({ verdict: 'validation_error' }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(0);
    expect(records).toHaveLength(0);
    handle.unregister();
  });

  it('skips when contract_domain is missing', async () => {
    const { fake, records } = makeFakeMemory();
    let calls = 0;
    const handle = registerAutoMemory({
      memory: fake,
      onProcessed: () => { calls += 1; },
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord({ contract_domain: undefined }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(0);
    expect(records).toHaveLength(0);
    handle.unregister();
  });

  it('surfaces memory.record exceptions via onProcessed without rethrowing', async () => {
    const boom = {
      record(): never { throw new Error('disk full'); },
      validate(): null { return null; },
      query(): [] { return []; },
    } as unknown as Pick<DomainMemory, 'record' | 'validate' | 'query'>;
    const { promise, resolve } = awaitProcessed<{ ok: boolean; error?: Error }>();
    const origConsoleError = console.error;
    console.error = () => {};
    try {
      const handle = registerAutoMemory({
        memory: boom,
        onProcessed: (e) => resolve(e),
      });
      contractRuntimeEvents.emit('transaction:settled', successRecord());
      const r = await promise;
      expect(r.ok).toBe(false);
      handle.unregister();
    } finally {
      console.error = origConsoleError;
    }
  });

  it('unregister() is idempotent', async () => {
    const { fake, records } = makeFakeMemory();
    const handle = registerAutoMemory({ memory: fake });
    handle.unregister();
    handle.unregister();
    contractRuntimeEvents.emit('transaction:settled', successRecord());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(records).toHaveLength(0);
  });

  it('caps selector length so a hostile evaluator cannot bloat the store', async () => {
    const { fake, records } = makeFakeMemory();
    const { promise, resolve } = awaitProcessed<{ ok: boolean }>();
    const handle = registerAutoMemory({
      memory: fake,
      onProcessed: (e) => resolve(e),
    });
    const tooLong = 'a'.repeat(2048);
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      pre_evidence: { passed: true, assertion_kind: 'dom_text', details: { selector: tooLong } },
      post_evidence: undefined,
    }));
    await promise;
    expect(records).toHaveLength(0);
    handle.unregister();
  });
});
