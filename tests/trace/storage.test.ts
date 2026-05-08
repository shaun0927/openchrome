import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TraceStorage } from '../../src/trace/storage';
import type { TraceEvent } from '../../src/trace/types';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-trace-'));
}

function event(seq: number, ts = Date.now()): TraceEvent {
  return { ts, seq, kind: 'test', body: { seq } };
}

describe('TraceStorage — schema and lifecycle', () => {
  let root: string;
  let store: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new TraceStorage({ rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates index.sqlite on first open', () => {
    expect(fs.existsSync(path.join(root, 'index.sqlite'))).toBe(true);
  });

  test('schema version is 1', () => {
    expect(store.getSchemaVersion()).toBe(1);
  });

  test('reopening on the same root reuses migrations (no error)', () => {
    store.close();
    expect(() => {
      const second = new TraceStorage({ rootDir: root });
      second.close();
    }).not.toThrow();
    // Re-open the original variable so afterEach can close cleanly.
    store = new TraceStorage({ rootDir: root });
  });

  test('migrations table is INSERT-OR-IGNORE idempotent (concurrent-safe)', () => {
    // Two initialisers against the same root must not race on the
    // `applied_migrations` v1 marker. The previous read-then-insert
    // pattern could throw a PK constraint violation when both saw the
    // marker missing; INSERT OR IGNORE makes it a silent no-op.
    store.close();
    expect(() => {
      const a = new TraceStorage({ rootDir: root });
      const b = new TraceStorage({ rootDir: root });
      a.close();
      b.close();
    }).not.toThrow();
    store = new TraceStorage({ rootDir: root });
  });
});

describe('TraceStorage — recordSessionStart / End / get', () => {
  let root: string;
  let store: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new TraceStorage({ rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('records and reads back a session', () => {
    store.recordSessionStart({
      sessionId: 's1',
      startedAt: 1000,
      domain: 'amazon.com',
      status: 'running',
      parentOp: 'tool:click',
    });
    const meta = store.get('s1');
    expect(meta).toBeDefined();
    expect(meta?.domain).toBe('amazon.com');
    expect(meta?.status).toBe('running');
    expect(meta?.parentOp).toBe('tool:click');
    expect(meta?.byteSize).toBe(0);
  });

  test('recordSessionEnd updates terminal fields', () => {
    store.recordSessionStart({ sessionId: 's2', startedAt: 100, status: 'running' });
    store.recordSessionEnd('s2', { endedAt: 200, status: 'completed', byteSize: 4096 });
    const meta = store.get('s2');
    expect(meta?.endedAt).toBe(200);
    expect(meta?.status).toBe('completed');
    expect(meta?.byteSize).toBe(4096);
  });

  test('get returns undefined for unknown session', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  test('recordSessionStart on reused session_id resets terminal fields', () => {
    store.recordSessionStart({ sessionId: 'reuse', startedAt: 100, status: 'running' });
    store.appendEvents('reuse', [event(1, 100)]);
    store.recordSessionEnd('reuse', { endedAt: 200, status: 'completed', byteSize: 999 });

    const before = store.get('reuse')!;
    expect(before.endedAt).toBe(200);
    expect(before.byteSize).toBe(999);

    // Restart the session: terminal fields must clear, not carry over.
    store.recordSessionStart({ sessionId: 'reuse', startedAt: 300, status: 'running' });
    const after = store.get('reuse')!;
    expect(after.startedAt).toBe(300);
    expect(after.status).toBe('running');
    expect(after.endedAt).toBeUndefined();
    expect(after.byteSize).toBe(0);
  });
});

describe('TraceStorage — list filtering', () => {
  let root: string;
  let store: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 'a', startedAt: 1000, status: 'completed', domain: 'x.com' });
    store.recordSessionStart({ sessionId: 'b', startedAt: 2000, status: 'failed', domain: 'x.com' });
    store.recordSessionStart({ sessionId: 'c', startedAt: 3000, status: 'completed', domain: 'y.com' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('default list orders by started_at DESC', () => {
    const rows = store.list();
    expect(rows.map((r) => r.sessionId)).toEqual(['c', 'b', 'a']);
  });

  test('filter by status', () => {
    const rows = store.list({ status: 'failed' });
    expect(rows.map((r) => r.sessionId)).toEqual(['b']);
  });

  test('filter by status array', () => {
    const rows = store.list({ status: ['completed', 'failed'] });
    expect(rows).toHaveLength(3);
  });

  test('filter by domain', () => {
    const rows = store.list({ domain: 'y.com' });
    expect(rows.map((r) => r.sessionId)).toEqual(['c']);
  });

  test('filter by since', () => {
    const rows = store.list({ since: 2000 });
    expect(rows.map((r) => r.sessionId)).toEqual(['c', 'b']);
  });

  test('limit honored', () => {
    const rows = store.list({ limit: 2 });
    expect(rows).toHaveLength(2);
  });
});

describe('TraceStorage — appendEvents', () => {
  let root: string;
  let store: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 's', startedAt: 1, status: 'running' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('writes JSONL file under <rootDir>/<sessionId>/', () => {
    const result = store.appendEvents('s', [event(1, 100), event(2, 100)]);
    expect(result.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(result.filePath.startsWith(path.join(root, 's'))).toBe(true);
    // One line per event + trailing newline
    const lines = fs.readFileSync(result.filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.seq).toBe(1);
  });

  test('multiple appends create multiple files with monotonic seq', () => {
    const a = store.appendEvents('s', [event(1, 100)]);
    const b = store.appendEvents('s', [event(2, 200)]);
    expect(a.filePath).not.toBe(b.filePath);
    // Filenames embed the per-flush seq counter
    expect(b.filePath).toMatch(/-2\.jsonl$/);
  });

  test('byte_size on the index increments after appendEvents', () => {
    const before = store.get('s')!.byteSize;
    const r = store.appendEvents('s', [event(1, 100), event(2, 100)]);
    const after = store.get('s')!.byteSize;
    expect(after - before).toBe(r.bytes);
  });

  test('empty events list is a no-op', () => {
    const r = store.appendEvents('s', []);
    expect(r.bytes).toBe(0);
    expect(r.filePath).toBe('');
  });

  test('rejects appends for unknown session_id (no orphan files)', () => {
    expect(() => store.appendEvents('ghost', [event(1, 100)])).toThrow(/unknown session_id=ghost/);
    expect(fs.existsSync(path.join(root, 'ghost'))).toBe(false);
  });

  test('rejects path-traversal session ids at all entry points', () => {
    // The recorder treats sessionId as a directory basename; without
    // validation `../foo` lets writes escape the trace root and a
    // future purgeOlderThan would rmSync the wrong directory.
    const evil = ['../escape', '/abs/path', 'a/b', 'a\\b', '..', '.', '\x00nul', '\x01ctrl'];
    for (const id of evil) {
      expect(() => store.recordSessionStart({ sessionId: id, startedAt: 1, status: 'running' }))
        .toThrow(/TraceStorage:/);
      expect(() => store.appendEvents(id, [event(1, 100)])).toThrow(/TraceStorage:/);
      expect(() => store.recordSessionEnd(id, { endedAt: 1, status: 'completed' }))
        .toThrow(/TraceStorage:/);
    }
  });

  test('accepts UUID-style session ids (hyphens permitted)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(() => store.recordSessionStart({ sessionId: uuid, startedAt: 1, status: 'running' }))
      .not.toThrow();
    expect(() => store.appendEvents(uuid, [event(1, 100)])).not.toThrow();
  });
});

describe('TraceStorage — purgeOlderThan', () => {
  let root: string;
  let store: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new TraceStorage({ rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('removes rows + files for old sessions, keeps recent ones', () => {
    store.recordSessionStart({ sessionId: 'old', startedAt: 1000, status: 'completed' });
    store.recordSessionStart({ sessionId: 'new', startedAt: 9000, status: 'completed' });
    store.appendEvents('old', [event(1, 1000)]);
    store.appendEvents('new', [event(1, 9000)]);

    const purged = store.purgeOlderThan(5000);
    expect(purged).toBe(1);
    expect(store.get('old')).toBeUndefined();
    expect(store.get('new')).toBeDefined();
    expect(fs.existsSync(path.join(root, 'old'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'new'))).toBe(true);
  });

  test('returns 0 when nothing matches', () => {
    store.recordSessionStart({ sessionId: 's', startedAt: 9000, status: 'completed' });
    expect(store.purgeOlderThan(5000)).toBe(0);
  });

  test('does NOT purge sessions still in `running` state even when older than cutoff', () => {
    // A long-lived running session that crosses the TTL must survive
    // the purge — deleting its directory mid-recording loses data and
    // breaks the next appendEvents call.
    store.recordSessionStart({ sessionId: 'live', startedAt: 1000, status: 'running' });
    store.recordSessionStart({ sessionId: 'old-completed', startedAt: 1000, status: 'completed' });
    store.appendEvents('live', [event(1, 1000)]);
    store.appendEvents('old-completed', [event(1, 1000)]);

    const purged = store.purgeOlderThan(5000);
    expect(purged).toBe(1);
    expect(store.get('live')).toBeDefined();
    expect(store.get('old-completed')).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'live'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'old-completed'))).toBe(false);
  });
});
