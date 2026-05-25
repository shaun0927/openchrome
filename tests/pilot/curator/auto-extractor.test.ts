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

  test('ignores verdicts the curator cannot use', async () => {
    let calls = 0;
    const handle = registerAutoExtractor({
      rootDir,
      onProcessed: () => { calls += 1; },
    });

    // Only `success` and `postcondition_violation` are routed into
    // the sidecar — everything else (errors, escalations, hook
    // aborts, validation failures, pre-check failures) describes the
    // runner state, not the skill, and is skipped.
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'precondition_violation',
    }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'execution_error',
    }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'validation_error',
    }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'budget_exhausted',
    }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'escalated',
    }));
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      verdict: 'aborted_by_hook',
    }));
    // Yield twice so any (incorrect) setImmediate callbacks would have fired.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(calls).toBe(0);
    expect(fs.existsSync(path.join(rootDir, 'example.com'))).toBe(false);
    handle.unregister();
  });

  test('postcondition_violation appends ok=false to an existing skill sidecar', async () => {
    // Seed a successful skill first.
    const seedAwait = awaitProcessed();
    const handle = registerAutoExtractor({ rootDir, onProcessed: seedAwait.onProcessed });
    contractRuntimeEvents.emit('transaction:settled', successRecord({ txn_id: 't-seed' }));
    expect((await seedAwait.promise).ok).toBe(true);

    // Now emit a postcondition_violation against the same skill.
    const failAwait = awaitProcessed();
    handle.unregister();
    const handle2 = registerAutoExtractor({ rootDir, onProcessed: failAwait.onProcessed });
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      txn_id: 't-fail-1',
      verdict: 'postcondition_violation',
    }));
    expect((await failAwait.promise).ok).toBe(true);

    const domainDir = path.join(rootDir, 'example.com');
    const sidecar = fs.readdirSync(domainDir).find((f) => f.endsWith('.json'))!;
    const data = JSON.parse(fs.readFileSync(path.join(domainDir, sidecar), 'utf8'));
    const failures = data.runs.recent.filter((e: { ok: boolean }) => e.ok === false);
    expect(failures).toHaveLength(1);
    handle2.unregister();
  });

  test('postcondition_violation against an unseen skill is a quiet no-op', async () => {
    const { promise, onProcessed } = awaitProcessed();
    const handle = registerAutoExtractor({ rootDir, onProcessed });
    contractRuntimeEvents.emit('transaction:settled', successRecord({
      txn_id: 't-fail-orphan',
      verdict: 'postcondition_violation',
    }));
    const result = await promise;
    // recordFailedRun returns { recorded: false } — auto-extractor
    // treats that as success (no error path) but never writes any
    // file.
    expect(result.ok).toBe(true);
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

  test('uses the journal provider to distill the SKILL.md body when entries are supplied', async () => {
    const { promise, onProcessed } = awaitProcessed();
    const handle = registerAutoExtractor({
      rootDir,
      journalProvider: () => [
        { ts: 100, tool: 'navigate', args: { url: 'https://example.com/cart' }, ok: true, summary: 'Cart page' },
        { ts: 101, tool: 'click', args: { label: 'Add to cart' }, ok: true },
      ],
      onProcessed,
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord());
    expect((await promise).ok).toBe(true);

    const domainDir = path.join(rootDir, 'example.com');
    const md = fs.readdirSync(domainDir).find((f) => f.endsWith('.md'))!;
    const body = fs.readFileSync(path.join(domainDir, md), 'utf8');
    expect(body).toMatch(/## Steps/);
    expect(body).toMatch(/\*\*navigate\*\*/);
    expect(body).toMatch(/\*\*click\*\*/);
    expect(body).not.toMatch(/PR-20b/); // placeholder body is gone
    handle.unregister();
  });

  test('falls back to placeholder body when journal provider yields nothing', async () => {
    const { promise, onProcessed } = awaitProcessed();
    const handle = registerAutoExtractor({
      rootDir,
      journalProvider: () => [],
      onProcessed,
    });
    contractRuntimeEvents.emit('transaction:settled', successRecord());
    expect((await promise).ok).toBe(true);

    const domainDir = path.join(rootDir, 'example.com');
    const md = fs.readdirSync(domainDir).find((f) => f.endsWith('.md'))!;
    const body = fs.readFileSync(path.join(domainDir, md), 'utf8');
    expect(body).toMatch(/PR-20b|contract-verified|successful trajectory/);
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
