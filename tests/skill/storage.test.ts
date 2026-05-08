import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SkillGraphStorage } from '../../src/skill/storage';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-'));
}

describe('SkillGraphStorage — schema and lifecycle', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage('amazon.com', { rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates per-domain DB at <rootDir>/<domain>.db', () => {
    expect(fs.existsSync(path.join(root, 'amazon.com.db'))).toBe(true);
  });

  test('schema version is 1', () => {
    expect(store.getSchemaVersion()).toBe(1);
  });

  test('reopening on the same domain is a no-op (idempotent migrations)', () => {
    store.close();
    expect(() => {
      const second = new SkillGraphStorage('amazon.com', { rootDir: root });
      second.close();
    }).not.toThrow();
    store = new SkillGraphStorage('amazon.com', { rootDir: root });
  });

  test('rejects empty / dot / dotdot domains', () => {
    expect(() => new SkillGraphStorage('', { rootDir: root })).toThrow();
    expect(() => new SkillGraphStorage('.', { rootDir: root })).toThrow();
    expect(() => new SkillGraphStorage('..', { rootDir: root })).toThrow();
  });

  test('encodes filesystem-unsafe domain characters into a portable filename', () => {
    // IPv6 literal hostnames carry `:` and `[`/`]` which are invalid
    // filename characters on Windows. The constructor must encode them
    // so storage initialisation works on every supported OS.
    const ipv6 = '[2001:db8::1]';
    const sg = new SkillGraphStorage(ipv6, { rootDir: root });
    sg.close();
    const expected = path.join(root, `${encodeURIComponent(ipv6)}.db`);
    expect(fs.existsSync(expected)).toBe(true);
    // Sanity: no file with the raw, unsafe name was created.
    expect(fs.existsSync(path.join(root, `${ipv6}.db`))).toBe(false);
  });

  test('Windows reserved device names get prefixed (CON.db is illegal on Windows)', () => {
    // `CON.db` would be rejected by the Win32 file API even though
    // ext exists. Underscore prefix sidesteps the reserved name
    // namespace; the keying stays deterministic for the same domain.
    const reserved = ['con', 'CON', 'aux', 'NUL', 'com1', 'lpt5'];
    for (const r of reserved) {
      const sg = new SkillGraphStorage(r, { rootDir: root });
      sg.close();
      expect(fs.existsSync(path.join(root, `_${encodeURIComponent(r)}.db`))).toBe(true);
      expect(fs.existsSync(path.join(root, `${r}.db`))).toBe(false);
    }
  });

  test('domain with `/` or `\\\\` is encoded, not rejected', () => {
    // Path separators in a domain were previously a hard error. They
    // cannot legitimately appear in a URL hostname, but if a caller
    // passes one (mistakenly or maliciously), encoding keeps the file
    // inside rootDir without an exception. The keying remains stable.
    const a = new SkillGraphStorage('a/b', { rootDir: root });
    a.close();
    const b = new SkillGraphStorage('a\\b', { rootDir: root });
    b.close();
    expect(fs.existsSync(path.join(root, `${encodeURIComponent('a/b')}.db`))).toBe(true);
    expect(fs.existsSync(path.join(root, `${encodeURIComponent('a\\b')}.db`))).toBe(true);
  });

  test('migrations table is INSERT-OR-IGNORE idempotent (concurrent-safe)', () => {
    // Second open against a domain that already has v1 applied must not
    // crash with a PK constraint violation. The previous read-then-insert
    // pattern raced under concurrent same-domain initialisers.
    store.close();
    expect(() => {
      const a = new SkillGraphStorage('amazon.com', { rootDir: root });
      const b = new SkillGraphStorage('amazon.com', { rootDir: root });
      a.close();
      b.close();
    }).not.toThrow();
    store = new SkillGraphStorage('amazon.com', { rootDir: root });
  });

  test('foreign-key enforcement: edges to unknown from_state are rejected', () => {
    // PRAGMA foreign_keys = ON must be set on the connection so the
    // declared edges.from_state -> nodes.state_hash FK is enforced and
    // recordOutcome cannot persist orphan edges.
    expect(() =>
      store.recordOutcome({
        fromState: 'no_such_node_hash',
        actionKind: 'click',
        actionArgsNorm: 'btn',
        observedToState: 'whatever',
        success: true,
      }),
    ).toThrow(/FOREIGN KEY constraint/i);
  });
});

describe('SkillGraphStorage — nodes', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage('x.com', { rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('upsertNode inserts a new row with visit_count=1', () => {
    store.upsertNode({ stateHash: 'aaaa', seenAt: 100, evidence: { url: 'https://x' } });
    const node = store.getNode('aaaa');
    expect(node).toBeDefined();
    expect(node?.visitCount).toBe(1);
    expect(node?.lastSeenAt).toBe(100);
    expect(node?.evidence).toEqual({ url: 'https://x' });
  });

  test('upsertNode increments visit_count on subsequent calls', () => {
    store.upsertNode({ stateHash: 'a', seenAt: 100 });
    store.upsertNode({ stateHash: 'a', seenAt: 200 });
    store.upsertNode({ stateHash: 'a', seenAt: 300 });
    const node = store.getNode('a');
    expect(node?.visitCount).toBe(3);
    expect(node?.lastSeenAt).toBe(300);
  });

  test('upsertNode preserves prior evidence when next call omits it', () => {
    store.upsertNode({ stateHash: 'a', evidence: { kept: true } });
    store.upsertNode({ stateHash: 'a' });
    expect(store.getNode('a')?.evidence).toEqual({ kept: true });
  });

  test('listNodes orders by visit_count DESC', () => {
    store.upsertNode({ stateHash: 'a' }); // visit 1
    store.upsertNode({ stateHash: 'b' });
    store.upsertNode({ stateHash: 'b' }); // visit 2
    store.upsertNode({ stateHash: 'c' });
    store.upsertNode({ stateHash: 'c' });
    store.upsertNode({ stateHash: 'c' }); // visit 3
    const list = store.listNodes();
    expect(list.map((n) => n.stateHash)).toEqual(['c', 'b', 'a']);
  });

  test('getNode returns undefined for unknown hash', () => {
    expect(store.getNode('missing')).toBeUndefined();
  });
});

describe('SkillGraphStorage — edges and recordOutcome', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage('x.com', { rootDir: root });
    store.upsertNode({ stateHash: 'from1' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('first success creates an edge with success_count=1, distribution=[{to,1}]', () => {
    store.recordOutcome({
      fromState: 'from1',
      actionKind: 'click',
      actionArgsNorm: 'ref:add',
      observedToState: 'to1',
      success: true,
    });
    const edge = store.getEdge({
      fromState: 'from1',
      actionKind: 'click',
      actionArgsNorm: 'ref:add',
    });
    expect(edge).toBeDefined();
    expect(edge?.successCount).toBe(1);
    expect(edge?.failCount).toBe(0);
    expect(edge?.toStateDistribution).toEqual([{ to_state: 'to1', count: 1 }]);
    expect(edge?.lastFailedAt).toBeUndefined();
  });

  test('repeated successes accumulate distribution counts', () => {
    for (let i = 0; i < 5; i++) {
      store.recordOutcome({
        fromState: 'from1',
        actionKind: 'click',
        actionArgsNorm: 'ref:add',
        observedToState: 'to1',
        success: true,
      });
    }
    const edge = store.getEdge({
      fromState: 'from1',
      actionKind: 'click',
      actionArgsNorm: 'ref:add',
    });
    expect(edge?.successCount).toBe(5);
    expect(edge?.toStateDistribution).toEqual([{ to_state: 'to1', count: 5 }]);
  });

  test('multiple to_state outcomes produce distribution sorted by count DESC', () => {
    const args = { fromState: 'from1', actionKind: 'click', actionArgsNorm: 'a' };
    store.recordOutcome({ ...args, observedToState: 'A', success: true });
    store.recordOutcome({ ...args, observedToState: 'A', success: true });
    store.recordOutcome({ ...args, observedToState: 'A', success: true });
    store.recordOutcome({ ...args, observedToState: 'B', success: true });
    const edge = store.getEdge(args);
    expect(edge?.toStateDistribution).toEqual([
      { to_state: 'A', count: 3 },
      { to_state: 'B', count: 1 },
    ]);
  });

  test('failure increments fail_count and stamps last_failed_at', () => {
    const args = { fromState: 'from1', actionKind: 'click', actionArgsNorm: 'a' };
    store.recordOutcome({ ...args, success: false, at: 1234 });
    const edge = store.getEdge(args);
    expect(edge?.successCount).toBe(0);
    expect(edge?.failCount).toBe(1);
    expect(edge?.lastFailedAt).toBe(1234);
  });

  test('last_failed_at is preserved across subsequent successes (sticky)', () => {
    const args = { fromState: 'from1', actionKind: 'click', actionArgsNorm: 'a' };
    store.recordOutcome({ ...args, success: false, at: 100 });
    store.recordOutcome({ ...args, observedToState: 'X', success: true, at: 200 });
    const edge = store.getEdge(args);
    expect(edge?.lastFailedAt).toBe(100); // still set after the success
    expect(edge?.successCount).toBe(1);
    expect(edge?.failCount).toBe(1);
  });

  test('failure without observedToState does not change distribution', () => {
    const args = { fromState: 'from1', actionKind: 'click', actionArgsNorm: 'a' };
    store.recordOutcome({ ...args, observedToState: 'X', success: true });
    store.recordOutcome({ ...args, success: false }); // no observedToState
    expect(store.getEdge(args)?.toStateDistribution).toEqual([{ to_state: 'X', count: 1 }]);
  });
});

describe('SkillGraphStorage — edgesFrom ordering', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage('x.com', { rootDir: root });
    store.upsertNode({ stateHash: 'from' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('orders edges by success rate DESC, then success_count DESC', () => {
    // Edge "low" — 1/2 = 0.5 success rate
    store.recordOutcome({ fromState: 'from', actionKind: 'a', actionArgsNorm: 'low', observedToState: 't', success: true });
    store.recordOutcome({ fromState: 'from', actionKind: 'a', actionArgsNorm: 'low', success: false });
    // Edge "high" — 3/3 = 1.0 success rate
    for (let i = 0; i < 3; i++) {
      store.recordOutcome({ fromState: 'from', actionKind: 'a', actionArgsNorm: 'high', observedToState: 't', success: true });
    }
    // Edge "small" — 1/1 = 1.0 success rate but lower successCount → tiebreak loser
    store.recordOutcome({ fromState: 'from', actionKind: 'a', actionArgsNorm: 'small', observedToState: 't', success: true });

    const edges = store.edgesFrom('from');
    expect(edges.map((e) => e.actionArgsNorm)).toEqual(['high', 'small', 'low']);
  });

  test('returns empty array for unknown from_state', () => {
    expect(store.edgesFrom('nope')).toEqual([]);
  });
});

describe('SkillGraphStorage — inspect summary', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage('amazon.com', { rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reports node and edge counts', () => {
    store.upsertNode({ stateHash: 'a' });
    store.upsertNode({ stateHash: 'b' });
    store.recordOutcome({ fromState: 'a', actionKind: 'click', actionArgsNorm: 'x', observedToState: 'b', success: true });
    const s = store.inspect();
    expect(s.domain).toBe('amazon.com');
    expect(s.nodeCount).toBe(2);
    expect(s.edgeCount).toBe(1);
  });

  test('top edges include success/fail counts', () => {
    store.upsertNode({ stateHash: 'a' });
    store.recordOutcome({ fromState: 'a', actionKind: 'click', actionArgsNorm: 'x', observedToState: 'b', success: true });
    store.recordOutcome({ fromState: 'a', actionKind: 'click', actionArgsNorm: 'x', success: false });
    const s = store.inspect();
    expect(s.topEdgesByVisit).toHaveLength(1);
    expect(s.topEdgesByVisit[0].successCount).toBe(1);
    expect(s.topEdgesByVisit[0].failCount).toBe(1);
  });

  test('recent failures only includes edges with last_failed_at set', () => {
    store.upsertNode({ stateHash: 'a' });
    store.recordOutcome({ fromState: 'a', actionKind: 'click', actionArgsNorm: 'ok', observedToState: 'b', success: true });
    store.recordOutcome({ fromState: 'a', actionKind: 'click', actionArgsNorm: 'broken', success: false, at: 999 });
    const s = store.inspect();
    expect(s.recentFailures).toHaveLength(1);
    expect(s.recentFailures[0].actionKind).toBe('click');
    expect(s.recentFailures[0].lastFailedAt).toBe(999);
  });
});
