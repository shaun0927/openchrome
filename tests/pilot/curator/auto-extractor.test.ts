/**
 * Tests for the auto-skillify extractor — the subscriber that bridges
 * `contractRuntimeEvents.transaction:settled` to
 * `recordSuccessfulRun()`.
 *
 * Strategy: register the subscriber with an explicit temp `rootDir`,
 * synthesise `TransactionRecord` shapes covering every selection
 * branch, and await the fire-and-forget `setImmediate` dispatch via
 * the test-only `onProcessed` callback.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { contractRuntimeEvents } from '../../../src/pilot/runtime/index.js';
import { registerAutoExtractor } from '../../../src/pilot/curator/index.js';
import type { TransactionRecord } from '../../../src/pilot/runtime/index.js';

function mkTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'auto-skillify-test-'));
}

function rmRf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function awaitProcessed(): {
  promise: Promise<{ ok: true } | { ok: false; error: Error }>;
  onProcessed: (r: { ok: true } | { ok: false; error: Error }) => void;
} {
  let resolve!: (r: { ok: true } | { ok: false; error: Error }) => void;
  const promise = new Promise<{ ok: true } | { ok: false; error: Error }>((res) => {
    resolve = res;
  });
  return { promise, onProcessed: resolve };
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
    state_hash: 'deadbeefcafef00d',
    state_hash_version: 'v1',
    ...over,
  };
}

let rootDir: string;
beforeEach(() => {
  rootDir = mkTmpRoot();
  contractRuntimeEvents.removeAllListeners('transaction:settled');
});

afterEach(() => {
  contractRuntimeEvents.removeAllListeners('transaction:settled');
  rmRf(rootDir);
});

describe('registerAutoExtractor', () => {
  test('records a success run with state_hash + contract_domain', async () => {
    const { promise, onProcessed } = awaitProcessed();
    const handle = registerAutoExtractor({ rootDir, onProcessed });

    contractRuntimeEvents.emit('transaction:settled', successRecord());
    const result = await promise;
    expect(result.ok).toBe(true);

    const domainDir = path.join(rootDir, 'example.com');
    const files = fs.readdirSync(domainDir);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    handle.unregister();
  });

  test('ignores non-success verdicts', async () => {
    let calls = 0;
    const handle = registerAutoExtractor({
      rootDir,
      onProcessed: () => { calls += 1; },
    });

    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'precondition_violation',
    }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'postcondition_violation',
    }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'execution_error',
    }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'validation_error',
    }));
    // Yield twice so any (incorrect) setImmediate callbacks would have fired.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(calls).toBe(0);
    expect(fs.existsSync(path.join(rootDir, 'example.com'))).toBe(false);
    handle.unregister();
  });

  test('ignores success without state_hash', async () => {
    let calls = 0;
    const handle = registerAutoExtractor({
      rootDir,
      onProcessed: () => { calls += 1; },
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      state_hash: undefined,
      state_hash_version: undefined,
    }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(0);
    handle.unregister();
  });

  test('ignores success without contract_domain', async () => {
    let calls = 0;
    const handle = registerAutoExtractor({
      rootDir,
      onProcessed: () => { calls += 1; },
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      contract_domain: undefined,
    }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(0);
    handle.unregister();
  });

  test('promotion threshold of 3 fires after three identical success runs', async () => {
    const events: Array<{ ok: true } | { ok: false; error: Error }> = [];
    const handle = registerAutoExtractor({
      rootDir,
      extractorOptions: { promotionThreshold: 3 },
      onProcessed: (r) => { events.push(r); },
    });

    for (let i = 0; i < 3; i++) {
      contractRuntimeEvents.emit('transaction:settled', successRecord({ txn_id: `t-${i}` }));
    }
    // Wait until all three are processed.
    for (let i = 0; i < 3 && events.length < 3; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.ok)).toBe(true);

    // After 3 successful runs the frontmatter status should be 'promoted'.
    const domainDir = path.join(rootDir, 'example.com');
    const md = fs.readdirSync(domainDir).find((f) => f.endsWith('.md'))!;
    const body = fs.readFileSync(path.join(domainDir, md), 'utf8');
    expect(body).toMatch(/status:\s*promoted/);
    handle.unregister();
  });

  test('extractor exception is surfaced via onProcessed and does not throw', async () => {
    // Force the rootDir to a path the extractor cannot create
    // (a file masquerading as a directory parent). Use the actual
    // tmp file path so `mkdirSync(recursive: true)` rejects.
    const badRoot = path.join(rootDir, 'i-am-a-file');
    fs.writeFileSync(badRoot, 'not a directory');

    const { promise, onProcessed } = awaitProcessed();
    const handle = registerAutoExtractor({
      rootDir: badRoot,
      onProcessed,
    });

    // Silence the expected console.error for clean test output.
    const origConsoleError = console.error;
    console.error = () => {};
    try {
      contractRuntimeEvents.emit('transaction:settled', successRecord());
      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    } finally {
      console.error = origConsoleError;
    }
    handle.unregister();
  });

  test('unregister() is idempotent and stops further deliveries', async () => {
    let calls = 0;
    const handle = registerAutoExtractor({
      rootDir,
      onProcessed: () => { calls += 1; },
    });
    handle.unregister();
    handle.unregister(); // second call is a no-op

    contractRuntimeEvents.emit('transaction:settled', successRecord());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(0);
  });
});
