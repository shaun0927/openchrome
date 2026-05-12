/**
 * Tests for ActionRecorder bounds enforcement on the four new optional fields:
 * contractResults (4 KB cap), network (20-entry cap), console (20-entry cap),
 * verify (pass-through). Also covers appendContractResult() and
 * getActiveActionRecorder() registry.
 * Part of #852: replay HTML report enrichment.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ActionRecorder,
  getActiveActionRecorder,
  registerSessionRecorder,
  unregisterSessionRecorder,
} from '../../src/recording/action-recorder';
import { RecordingStore } from '../../src/recording/recording-store';
import { ContractResultEntry, NetworkEntry, ConsoleEntry } from '../../src/recording/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `bounds-test-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── contractResults — 4 KB cap ────────────────────────────────────────────────

describe('ActionRecorder — contractResults bounds (4 KB cap)', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  it('stores contractResults under 4 KB unchanged', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    const entries: ContractResultEntry[] = [
      { assertion: { kind: 'url', pattern: 'example.com' }, verdict: 'pass' },
    ];
    await recorder.recordAction('navigate', {}, 100, true, { contractResults: entries });

    const actions = store.readActions(id);
    expect(actions[0].contractResults).toEqual(entries);
  });

  it('replaces contractResults > 4 KB with truncation placeholder', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    // Build a payload that exceeds 4096 bytes when JSON-stringified
    const bigEntry: ContractResultEntry = {
      assertion: { kind: 'dom_text', selector: 'body', contains: 'x'.repeat(5000) },
      verdict: 'pass',
    };
    await recorder.recordAction('navigate', {}, 100, true, { contractResults: [bigEntry] });

    const actions = store.readActions(id);
    const cr = actions[0].contractResults as unknown as Array<{ truncated: boolean; originalBytes: number }>;
    expect(cr).toHaveLength(1);
    expect(cr[0].truncated).toBe(true);
    expect(typeof cr[0].originalBytes).toBe('number');
    expect(cr[0].originalBytes).toBeGreaterThan(4096);
  });

  it('stores empty contractResults as absent (not written)', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    await recorder.recordAction('navigate', {}, 100, true, { contractResults: [] });

    const actions = store.readActions(id);
    expect(actions[0].contractResults).toBeUndefined();
  });
});

// ── network — 20-entry cap ────────────────────────────────────────────────────

describe('ActionRecorder — network bounds (20-entry cap)', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  it('stores network entries <= 20 unchanged', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    const network: NetworkEntry[] = Array.from({ length: 20 }, (_, i) => ({
      method: 'GET',
      url: `https://example.com/r${i}`,
      status: 200,
    }));
    await recorder.recordAction('navigate', {}, 100, true, { network });

    const actions = store.readActions(id);
    expect(actions[0].network).toHaveLength(20);
  });

  it('clips network to 20 entries and appends truncation marker for 25 entries', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    const network: NetworkEntry[] = Array.from({ length: 25 }, (_, i) => ({
      method: 'GET',
      url: `https://example.com/r${i}`,
      status: 200,
    }));
    await recorder.recordAction('navigate', {}, 100, true, { network });

    const actions = store.readActions(id);
    const stored = actions[0].network!;
    expect(stored).toHaveLength(21); // 20 real + 1 marker
    expect(stored[20].method).toBe('');
    expect(stored[20].url).toContain('+5 more');
    expect(stored[20].url).toContain('truncated');
  });

  it('truncation marker says +N for N = over-count', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    const network: NetworkEntry[] = Array.from({ length: 30 }, (_, i) => ({
      method: 'POST',
      url: `https://example.com/x${i}`,
    }));
    await recorder.recordAction('navigate', {}, 100, true, { network });

    const actions = store.readActions(id);
    const marker = actions[0].network![20];
    expect(marker.url).toContain('+10 more');
  });

  it('stores absent network field unchanged (no field written)', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    await recorder.recordAction('navigate', {}, 100, true);

    const actions = store.readActions(id);
    expect(actions[0].network).toBeUndefined();
  });
});

// ── console — 20-entry cap ────────────────────────────────────────────────────

describe('ActionRecorder — console bounds (20-entry cap)', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  it('stores console entries <= 20 unchanged', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    const consoleEntries: ConsoleEntry[] = Array.from({ length: 20 }, (_, i) => ({
      level: 'log' as const,
      text: `msg ${i}`,
      ts: Date.now() + i,
    }));
    await recorder.recordAction('navigate', {}, 100, true, { console: consoleEntries });

    const actions = store.readActions(id);
    expect(actions[0].console).toHaveLength(20);
  });

  it('clips console to 20 and appends truncation marker for 25 entries', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    const consoleEntries: ConsoleEntry[] = Array.from({ length: 25 }, (_, i) => ({
      level: 'warn' as const,
      text: `warn ${i}`,
      ts: Date.now() + i,
    }));
    await recorder.recordAction('navigate', {}, 100, true, { console: consoleEntries });

    const actions = store.readActions(id);
    const stored = actions[0].console!;
    expect(stored).toHaveLength(21); // 20 real + 1 marker
    expect(stored[20].level).toBe('log');
    expect(stored[20].text).toContain('+5 more');
    expect(stored[20].text).toContain('truncated');
  });

  it('truncation marker ts is a number', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    const consoleEntries: ConsoleEntry[] = Array.from({ length: 21 }, (_, i) => ({
      level: 'error' as const,
      text: `err ${i}`,
      ts: 1000 + i,
    }));
    await recorder.recordAction('navigate', {}, 100, true, { console: consoleEntries });

    const actions = store.readActions(id);
    const marker = actions[0].console![20];
    expect(typeof marker.ts).toBe('number');
  });

  it('stores absent console field as undefined', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    await recorder.recordAction('navigate', {}, 100, true);
    const actions = store.readActions(id);
    expect(actions[0].console).toBeUndefined();
  });
});

// ── verify — pass-through ─────────────────────────────────────────────────────

describe('ActionRecorder — verify pass-through', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  it('stores verify block verbatim', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    const verify = { ax_diff: { changed: true }, screenshot: { phash_distance: 8 } };
    await recorder.recordAction('interact', {}, 200, true, { verify });

    const actions = store.readActions(id);
    expect(actions[0].verify).toEqual(verify);
  });

  it('omits verify field when not provided', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    await recorder.recordAction('navigate', {}, 100, true);
    const actions = store.readActions(id);
    expect(actions[0].verify).toBeUndefined();
  });
});

// ── appendContractResult() ────────────────────────────────────────────────────

describe('ActionRecorder.appendContractResult()', () => {
  let dir: string;
  let store: RecordingStore;
  let recorder: ActionRecorder;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
    recorder = new ActionRecorder(store, { captureScreenshots: false });
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  it('is a no-op when not recording', async () => {
    await expect(
      recorder.appendContractResult({ assertion: {}, verdict: 'pass' }),
    ).resolves.not.toThrow();
  });

  it('is a no-op when recording but no actions have been recorded yet', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    await recorder.appendContractResult({ assertion: {}, verdict: 'pass' });

    const actions = store.readActions(id);
    expect(actions).toHaveLength(0);
  });

  it('appends a contract result to the most recent action', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    await recorder.recordAction('navigate', {}, 100, true);
    await recorder.appendContractResult({
      assertion: { kind: 'url', pattern: 'example.com' },
      verdict: 'pass',
    });

    const actions = store.readActions(id);
    expect(actions[0].contractResults).toHaveLength(1);
    expect(actions[0].contractResults![0].verdict).toBe('pass');
  });

  it('appends to the last action, not the first', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    await recorder.recordAction('navigate', {}, 100, true);
    await recorder.recordAction('read_page', {}, 50, true);
    await recorder.appendContractResult({ assertion: {}, verdict: 'fail' });

    const actions = store.readActions(id);
    expect(actions[0].contractResults).toBeUndefined();
    expect(actions[1].contractResults).toHaveLength(1);
    expect(actions[1].contractResults![0].verdict).toBe('fail');
  });

  it('accumulates multiple appendContractResult calls on the same action', async () => {
    await recorder.start('sess-1');
    const id = recorder.activeRecordingId!;

    await recorder.recordAction('navigate', {}, 100, true);
    await recorder.appendContractResult({ assertion: { a: 1 }, verdict: 'pass' });
    await recorder.appendContractResult({ assertion: { b: 2 }, verdict: 'fail' });

    const actions = store.readActions(id);
    expect(actions[0].contractResults).toHaveLength(2);
    expect(actions[0].contractResults![0].verdict).toBe('pass');
    expect(actions[0].contractResults![1].verdict).toBe('fail');
  });
});

// ── getActiveActionRecorder() registry ───────────────────────────────────────

describe('getActiveActionRecorder()', () => {
  let dir: string;
  let store: RecordingStore;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RecordingStore(dir);
  });

  afterEach(() => {
    cleanupDir(dir);
    unregisterSessionRecorder('sess-reg-test');
  });

  it('returns undefined when no recorder is registered for sessionId', () => {
    expect(getActiveActionRecorder('sess-reg-test')).toBeUndefined();
  });

  it('returns the registered recorder when it is actively recording', async () => {
    const recorder = new ActionRecorder(store, { captureScreenshots: false });
    await recorder.start('sess-reg-test');
    registerSessionRecorder('sess-reg-test', recorder);

    const found = getActiveActionRecorder('sess-reg-test');
    expect(found).toBe(recorder);

    await recorder.stop();
    unregisterSessionRecorder('sess-reg-test');
  });

  it('returns undefined after recorder is stopped and unregistered', async () => {
    const recorder = new ActionRecorder(store, { captureScreenshots: false });
    await recorder.start('sess-reg-test');
    registerSessionRecorder('sess-reg-test', recorder);
    await recorder.stop();
    unregisterSessionRecorder('sess-reg-test');

    expect(getActiveActionRecorder('sess-reg-test')).toBeUndefined();
  });

  it('returns undefined for a registered-but-stopped recorder (not unregistered)', async () => {
    const recorder = new ActionRecorder(store, { captureScreenshots: false });
    await recorder.start('sess-reg-test');
    registerSessionRecorder('sess-reg-test', recorder);
    await recorder.stop();
    // deliberately NOT calling unregisterSessionRecorder

    expect(getActiveActionRecorder('sess-reg-test')).toBeUndefined();

    unregisterSessionRecorder('sess-reg-test'); // cleanup
  });
});
