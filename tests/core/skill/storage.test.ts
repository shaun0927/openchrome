/**
 * Tests for the JSON-per-domain skill graph storage backend.
 *
 * The shape of the test suite mirrors closed PR #738's SQLite test file,
 * minus the migration-table tests (no SQL here) and with the API surface
 * updated to the Phase 3 spec:
 *   - `new SkillGraphStorage({ rootDir, domain })`
 *   - `recordEdge({ from_state, action_kind, action_args_norm, to_state? })`
 *   - `recordSuccess(edgeKey)` / `recordFailure(edgeKey, error?)`
 *   - `getNode(stateHash)` returns `null` on miss (not `undefined`)
 *   - `topEdges(fromState, limit?)` / `recentFailures(limit?)`
 *
 * Concurrency tests assert:
 *   - same-domain writes serialise (success/fail counters never collide)
 *   - cross-domain writes proceed in parallel (independent lock files)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SkillGraphStorage } from '../../../src/core/skill';
import type { EdgeKey } from '../../../src/core/skill';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-'));
}

describe('SkillGraphStorage — schema and lifecycle', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage({ domain: 'amazon.com', rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates per-domain JSON file at <rootDir>/<domain>.json', () => {
    expect(fs.existsSync(path.join(root, 'amazon.com.json'))).toBe(true);
  });

  test('schema version is 1', () => {
    expect(store.getSchemaVersion()).toBe(1);
  });

  test('reopening on the same domain is a no-op (idempotent seed)', () => {
    expect(() => {
      const second = new SkillGraphStorage({ domain: 'amazon.com', rootDir: root });
      second.close();
    }).not.toThrow();
  });

  test('reopening with prior data does NOT blank-overwrite the file', async () => {
    // Codex finding from the SQLite iteration: the initial-write path
    // has to be idempotent. Persist a node, reopen the same domain, and
    // confirm the node is still there.
    await store.upsertNode({ stateHash: 'persist-me', seenAt: 42 });
    store.close();
    const reopened = new SkillGraphStorage({ domain: 'amazon.com', rootDir: root });
    try {
      const node = reopened.getNode('persist-me');
      expect(node).not.toBeNull();
      expect(node?.lastSeenAt).toBe(42);
    } finally {
      reopened.close();
    }
  });

  test('rejects empty / dot / dotdot domains', () => {
    expect(() => new SkillGraphStorage({ domain: '', rootDir: root })).toThrow();
    expect(() => new SkillGraphStorage({ domain: '.', rootDir: root })).toThrow();
    expect(() => new SkillGraphStorage({ domain: '..', rootDir: root })).toThrow();
  });

  test('encodes filesystem-unsafe domain characters into a portable filename', () => {
    // IPv6 literal hostnames carry `:` and `[`/`]` which are invalid
    // filename characters on Windows. The constructor must encode them.
    const ipv6 = '[2001:db8::1]';
    const sg = new SkillGraphStorage({ domain: ipv6, rootDir: root });
    sg.close();
    const expected = path.join(root, `${encodeURIComponent(ipv6)}.json`);
    expect(fs.existsSync(expected)).toBe(true);
    // Sanity: no file with the raw, unsafe name was created.
    expect(fs.existsSync(path.join(root, `${ipv6}.json`))).toBe(false);
  });

  test('Windows reserved device names get prefixed (CON.json is illegal on Windows)', () => {
    const reserved = ['con', 'CON', 'aux', 'NUL', 'com1', 'lpt5'];
    for (const r of reserved) {
      const sg = new SkillGraphStorage({ domain: r, rootDir: root });
      sg.close();
      expect(fs.existsSync(path.join(root, `_${encodeURIComponent(r)}.json`))).toBe(true);
      expect(fs.existsSync(path.join(root, `${r}.json`))).toBe(false);
    }
  });

  test('domain with `/` or `\\\\` is encoded, not rejected', () => {
    // Path separators can't legitimately appear in a URL hostname, but if
    // a caller passes one (mistakenly or maliciously), encoding keeps
    // the file inside rootDir without an exception.
    const a = new SkillGraphStorage({ domain: 'a/b', rootDir: root });
    a.close();
    const b = new SkillGraphStorage({ domain: 'a\\b', rootDir: root });
    b.close();
    expect(fs.existsSync(path.join(root, `${encodeURIComponent('a/b')}.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, `${encodeURIComponent('a\\b')}.json`))).toBe(true);
  });

  test('concurrent same-domain initializers do not race the seed file', () => {
    // The SQLite version used `INSERT OR IGNORE` to dodge a PK race; the
    // JSON variant uses `wx`-flag write + EEXIST tolerance. Two
    // constructors against the same domain must coexist without
    // exception.
    expect(() => {
      const a = new SkillGraphStorage({ domain: 'race.test', rootDir: root });
      const b = new SkillGraphStorage({ domain: 'race.test', rootDir: root });
      a.close();
      b.close();
    }).not.toThrow();
  });
});

describe('SkillGraphStorage — nodes', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage({ domain: 'x.com', rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('upsertNode inserts a new row with visit_count=1', async () => {
    await store.upsertNode({ stateHash: 'aaaa', seenAt: 100, evidence: { url: 'https://x' } });
    const node = store.getNode('aaaa');
    expect(node).not.toBeNull();
    expect(node?.visitCount).toBe(1);
    expect(node?.lastSeenAt).toBe(100);
    expect(node?.evidence).toEqual({ url: 'https://x' });
  });

  test('upsertNode increments visit_count on subsequent calls', async () => {
    await store.upsertNode({ stateHash: 'a', seenAt: 100 });
    await store.upsertNode({ stateHash: 'a', seenAt: 200 });
    await store.upsertNode({ stateHash: 'a', seenAt: 300 });
    const node = store.getNode('a');
    expect(node?.visitCount).toBe(3);
    expect(node?.lastSeenAt).toBe(300);
  });

  test('upsertNode preserves prior evidence when next call omits it', async () => {
    await store.upsertNode({ stateHash: 'a', evidence: { kept: true } });
    await store.upsertNode({ stateHash: 'a' });
    expect(store.getNode('a')?.evidence).toEqual({ kept: true });
  });

  test('listNodes orders by visit_count DESC', async () => {
    await store.upsertNode({ stateHash: 'a' }); // 1
    await store.upsertNode({ stateHash: 'b' });
    await store.upsertNode({ stateHash: 'b' }); // 2
    await store.upsertNode({ stateHash: 'c' });
    await store.upsertNode({ stateHash: 'c' });
    await store.upsertNode({ stateHash: 'c' }); // 3
    const list = store.listNodes();
    expect(list.map((n) => n.stateHash)).toEqual(['c', 'b', 'a']);
  });

  test('getNode returns null for unknown hash', () => {
    expect(store.getNode('missing')).toBeNull();
  });
});

describe('SkillGraphStorage — edges and outcome counters', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage({ domain: 'x.com', rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('recordEdge creates an edge with empty counters and seeded distribution', async () => {
    await store.recordEdge({
      from_state: 'from1',
      action_kind: 'click',
      action_args_norm: 'ref:add',
      to_state: 'to1',
    });
    const edge = store.getEdge({
      fromState: 'from1',
      actionKind: 'click',
      actionArgsNorm: 'ref:add',
    });
    expect(edge).not.toBeNull();
    expect(edge?.successCount).toBe(0);
    expect(edge?.failCount).toBe(0);
    expect(edge?.toStateDistribution).toEqual([{ to_state: 'to1', count: 1 }]);
    expect(edge?.lastFailedAt).toBeUndefined();
  });

  test('recordEdge ensures both endpoint nodes exist (application-level FK)', async () => {
    // The SQLite version enforced `from_state` → nodes via foreign-key
    // pragma. JSON has no such pragma so we create empty Node stubs.
    await store.recordEdge({
      from_state: 'from-stub',
      action_kind: 'click',
      action_args_norm: 'x',
      to_state: 'to-stub',
    });
    expect(store.getNode('from-stub')).not.toBeNull();
    expect(store.getNode('to-stub')).not.toBeNull();
    // visit_count stays 0 — these are stubs, not real visits.
    expect(store.getNode('from-stub')?.visitCount).toBe(0);
  });

  test('recordSuccess increments success_count and updates distribution', async () => {
    const key: EdgeKey = {
      fromState: 'from1',
      actionKind: 'click',
      actionArgsNorm: 'ref:add',
    };
    for (let i = 0; i < 5; i++) {
      await store.recordSuccess(key, 'to1');
    }
    const edge = store.getEdge(key);
    expect(edge?.successCount).toBe(5);
    expect(edge?.failCount).toBe(0);
    expect(edge?.toStateDistribution).toEqual([{ to_state: 'to1', count: 5 }]);
  });

  test('multiple to_state outcomes produce distribution sorted by count DESC', async () => {
    const key: EdgeKey = { fromState: 'from1', actionKind: 'click', actionArgsNorm: 'a' };
    await store.recordSuccess(key, 'A');
    await store.recordSuccess(key, 'A');
    await store.recordSuccess(key, 'A');
    await store.recordSuccess(key, 'B');
    const edge = store.getEdge(key);
    expect(edge?.toStateDistribution).toEqual([
      { to_state: 'A', count: 3 },
      { to_state: 'B', count: 1 },
    ]);
  });

  test('recordFailure increments fail_count and stamps last_failed_at', async () => {
    const key: EdgeKey = { fromState: 'from1', actionKind: 'click', actionArgsNorm: 'a' };
    const before = Date.now();
    await store.recordFailure(key, 'boom');
    const after = Date.now();
    const edge = store.getEdge(key);
    expect(edge?.successCount).toBe(0);
    expect(edge?.failCount).toBe(1);
    expect(edge?.lastFailedAt).toBeGreaterThanOrEqual(before);
    expect(edge?.lastFailedAt).toBeLessThanOrEqual(after);
    expect(edge?.lastError).toBe('boom');
  });

  test('last_failed_at survives subsequent successes (sticky)', async () => {
    const key: EdgeKey = { fromState: 'from1', actionKind: 'click', actionArgsNorm: 'a' };
    await store.recordFailure(key);
    const failedAt = store.getEdge(key)?.lastFailedAt;
    expect(failedAt).toBeDefined();
    await store.recordSuccess(key, 'X');
    const edge = store.getEdge(key);
    expect(edge?.lastFailedAt).toBe(failedAt);
    expect(edge?.successCount).toBe(1);
    expect(edge?.failCount).toBe(1);
  });

  test('recordSuccess without observedToState does not change distribution', async () => {
    const key: EdgeKey = { fromState: 'from1', actionKind: 'click', actionArgsNorm: 'a' };
    await store.recordSuccess(key, 'X');
    await store.recordSuccess(key); // omit observedToState
    expect(store.getEdge(key)?.toStateDistribution).toEqual([{ to_state: 'X', count: 1 }]);
  });

  test('getEdge returns null for unknown key', () => {
    expect(
      store.getEdge({
        fromState: 'nope',
        actionKind: 'nope',
        actionArgsNorm: 'nope',
      }),
    ).toBeNull();
  });
});

describe('SkillGraphStorage — topEdges ordering', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage({ domain: 'x.com', rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('orders edges by success rate DESC, then success_count DESC', async () => {
    // Edge "low" — 1/2 = 0.5 success rate
    await store.recordSuccess(
      { fromState: 'from', actionKind: 'a', actionArgsNorm: 'low' },
      't',
    );
    await store.recordFailure({ fromState: 'from', actionKind: 'a', actionArgsNorm: 'low' });
    // Edge "high" — 3/3 = 1.0 success rate
    for (let i = 0; i < 3; i++) {
      await store.recordSuccess(
        { fromState: 'from', actionKind: 'a', actionArgsNorm: 'high' },
        't',
      );
    }
    // Edge "small" — 1/1 = 1.0 success rate but lower successCount → tiebreak loser
    await store.recordSuccess(
      { fromState: 'from', actionKind: 'a', actionArgsNorm: 'small' },
      't',
    );

    const edges = store.topEdges('from');
    expect(edges.map((e) => e.actionArgsNorm)).toEqual(['high', 'small', 'low']);
  });

  test('returns empty array for unknown from_state', () => {
    expect(store.topEdges('nope')).toEqual([]);
  });

  test('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await store.recordSuccess(
        { fromState: 'from', actionKind: 'a', actionArgsNorm: `arg-${i}` },
        't',
      );
    }
    expect(store.topEdges('from', 2)).toHaveLength(2);
  });
});

describe('SkillGraphStorage — recentFailures', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage({ domain: 'x.com', rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('only includes edges with last_failed_at set, ordered DESC', async () => {
    await store.recordSuccess({ fromState: 'a', actionKind: 'click', actionArgsNorm: 'ok' }, 'b');
    await store.recordFailure(
      { fromState: 'a', actionKind: 'click', actionArgsNorm: 'broken-1' },
      'first',
    );
    // Tiny wait so the second failure has a strictly-later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await store.recordFailure(
      { fromState: 'a', actionKind: 'click', actionArgsNorm: 'broken-2' },
      'second',
    );
    const failures = store.recentFailures();
    expect(failures).toHaveLength(2);
    expect(failures[0].actionArgsNorm).toBe('broken-2');
    expect(failures[1].actionArgsNorm).toBe('broken-1');
  });

  test('returns empty array when nothing has failed', () => {
    expect(store.recentFailures()).toEqual([]);
  });
});

describe('SkillGraphStorage — inspect summary', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage({ domain: 'amazon.com', rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reports node and edge counts', async () => {
    await store.upsertNode({ stateHash: 'a' });
    await store.upsertNode({ stateHash: 'b' });
    await store.recordSuccess(
      { fromState: 'a', actionKind: 'click', actionArgsNorm: 'x' },
      'b',
    );
    const s = store.inspect();
    expect(s.domain).toBe('amazon.com');
    expect(s.nodeCount).toBe(2);
    expect(s.edgeCount).toBe(1);
  });

  test('top edges include success/fail counts', async () => {
    await store.upsertNode({ stateHash: 'a' });
    await store.recordSuccess(
      { fromState: 'a', actionKind: 'click', actionArgsNorm: 'x' },
      'b',
    );
    await store.recordFailure({ fromState: 'a', actionKind: 'click', actionArgsNorm: 'x' });
    const s = store.inspect();
    expect(s.topEdgesByVisit).toHaveLength(1);
    expect(s.topEdgesByVisit[0].successCount).toBe(1);
    expect(s.topEdgesByVisit[0].failCount).toBe(1);
  });

  test('recent failures only includes edges with last_failed_at set', async () => {
    await store.upsertNode({ stateHash: 'a' });
    await store.recordSuccess(
      { fromState: 'a', actionKind: 'click', actionArgsNorm: 'ok' },
      'b',
    );
    await store.recordFailure({ fromState: 'a', actionKind: 'click', actionArgsNorm: 'broken' });
    const s = store.inspect();
    expect(s.recentFailures).toHaveLength(1);
    expect(s.recentFailures[0].actionKind).toBe('click');
    expect(s.recentFailures[0].lastFailedAt).toBeGreaterThan(0);
  });
});

describe('SkillGraphStorage — concurrent same-domain writes serialise', () => {
  let root: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillGraphStorage({ domain: 'concurrent.test', rootDir: root });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('parallel recordSuccess calls on the same edge sum correctly (no lost updates)', async () => {
    // Codex finding from the SQLite iteration: recordOutcome reads and
    // writes inside the same lock window so concurrent same-domain
    // writers cannot read the same `success_count` and clobber each
    // other. Fire N parallel writes against a single edge and verify
    // the final counter is exactly N — anything less means we lost an
    // update.
    const key: EdgeKey = {
      fromState: 'from',
      actionKind: 'click',
      actionArgsNorm: 'concurrent',
    };
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, () => store.recordSuccess(key, 'to')),
    );
    const edge = store.getEdge(key);
    expect(edge?.successCount).toBe(N);
    expect(edge?.toStateDistribution).toEqual([{ to_state: 'to', count: N }]);
  });

  test('parallel recordEdge + recordSuccess on the same key serialise', async () => {
    const key: EdgeKey = { fromState: 'a', actionKind: 'k', actionArgsNorm: 'v' };
    await Promise.all([
      store.recordEdge({
        from_state: key.fromState,
        action_kind: key.actionKind,
        action_args_norm: key.actionArgsNorm,
        to_state: 'observed',
      }),
      store.recordSuccess(key, 'observed'),
      store.recordSuccess(key, 'observed'),
      store.recordFailure(key, 'transient'),
    ]);
    const edge = store.getEdge(key);
    expect(edge?.successCount).toBe(2);
    expect(edge?.failCount).toBe(1);
    // Distribution should have aggregated all three observations.
    const observed = edge?.toStateDistribution.find((d) => d.to_state === 'observed');
    expect(observed?.count).toBe(3);
  });
});

describe('SkillGraphStorage — cross-domain writes proceed in parallel', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('writes against different domains use independent lock files', async () => {
    const a = new SkillGraphStorage({ domain: 'a.example', rootDir: root });
    const b = new SkillGraphStorage({ domain: 'b.example', rootDir: root });
    const c = new SkillGraphStorage({ domain: 'c.example', rootDir: root });

    try {
      const key: EdgeKey = { fromState: 'from', actionKind: 'k', actionArgsNorm: 'v' };
      await Promise.all([
        a.recordSuccess(key, 'to'),
        b.recordSuccess(key, 'to'),
        c.recordSuccess(key, 'to'),
      ]);

      // Each domain's file holds exactly one success on the single edge.
      expect(a.getEdge(key)?.successCount).toBe(1);
      expect(b.getEdge(key)?.successCount).toBe(1);
      expect(c.getEdge(key)?.successCount).toBe(1);

      // Per-domain JSON files exist and are independent.
      expect(fs.existsSync(path.join(root, 'a.example.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'b.example.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'c.example.json'))).toBe(true);
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
});
