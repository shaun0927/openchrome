import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import {
  SKILL_MEMORY_SCHEMA_VERSION,
  SkillMemoryStore,
  type SkillRecord,
} from '../../../src/core/skill-memory';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-mem-'));
}

function baseRecord(overrides: Partial<SkillRecord> = {}): Omit<SkillRecord, 'skillId'> {
  return {
    domain: 'amazon.com',
    name: 'add-to-cart',
    steps: [{ kind: 'click', selector: '#buy-now' }],
    contractId: 'contract-1',
    successCount: 0,
    lastUsedAt: 0,
    frozenSnapshotPath: null,
    ...overrides,
  };
}

describe('SkillMemoryStore — construction', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('throws when domain is missing', () => {
    expect(
      () => new SkillMemoryStore({ rootDir: root, domain: '' }),
    ).toThrow(/domain is required/);
  });

  test('throws when domain contains a control character', () => {
    expect(
      () => new SkillMemoryStore({ rootDir: root, domain: 'foo\x00.com' }),
    ).toThrow(/control character/);
  });

  test('throws when domain is longer than 253 chars', () => {
    const longDomain = 'a'.repeat(254);
    expect(
      () => new SkillMemoryStore({ rootDir: root, domain: longDomain }),
    ).toThrow(/domain too long/);
  });

  test('does not touch the filesystem in the constructor (lazy init)', () => {
    const lazyRoot = path.join(os.tmpdir(), `oc-skill-mem-lazy-${Date.now()}-${Math.random()}`);
    expect(fs.existsSync(lazyRoot)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _s = new SkillMemoryStore({ rootDir: lazyRoot, domain: 'amazon.com' });
    expect(fs.existsSync(lazyRoot)).toBe(false);
  });
});

describe('SkillMemoryStore — record / get / list', () => {
  let root: string;
  let store: SkillMemoryStore;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('record persists a skill and returns a stable id', async () => {
    const res = await store.record(baseRecord());
    expect(typeof res.skill_id).toBe('string');
    expect(res.skill_id.length).toBeGreaterThan(0);
    expect(typeof res.stored_at).toBe('number');
    const got = store.get(res.skill_id);
    expect(got).toBeDefined();
    expect(got?.domain).toBe('amazon.com');
    expect(got?.name).toBe('add-to-cart');
    expect(got?.contractId).toBe('contract-1');
  });

  test('record is idempotent on (domain, name) and preserves usage stats', async () => {
    const first = await store.record(baseRecord());
    // Simulate prior usage via markUsed before re-recording.
    await store.markUsed(first.skill_id, 5000, true);
    await store.markUsed(first.skill_id, 6000, true);
    const second = await store.record(
      baseRecord({
        // Different steps_json + contract_id should override; counters
        // and last_used_at must NOT reset.
        steps: [{ kind: 'click', selector: '#buy-now-v2' }],
        contractId: 'contract-2',
      }),
    );
    expect(second.skill_id).toBe(first.skill_id);
    const got = store.get(first.skill_id);
    expect(got?.contractId).toBe('contract-2');
    expect(got?.successCount).toBe(2);
    expect(got?.lastUsedAt).toBe(6000);
    expect(got?.steps).toEqual([{ kind: 'click', selector: '#buy-now-v2' }]);
  });

  test('record rejects domain mismatch with the store binding', async () => {
    await expect(
      store.record(baseRecord({ domain: 'other.com' })),
    ).rejects.toThrow(/domain mismatch/);
  });

  test('record rejects empty name', async () => {
    await expect(
      store.record(baseRecord({ name: '' })),
    ).rejects.toThrow(/name must be a non-empty string/);
  });

  test('get returns null on miss', () => {
    expect(store.get('nope')).toBeNull();
    expect(store.get('')).toBeNull();
  });

  test('list returns rows sorted by last_used_at desc, ties by skill_id asc', async () => {
    const a = await store.record(baseRecord({ name: 'a' }));
    const b = await store.record(baseRecord({ name: 'b' }));
    const c = await store.record(baseRecord({ name: 'c' }));
    await store.markUsed(b.skill_id, 1000, true);
    await store.markUsed(a.skill_id, 2000, true);
    // c untouched -> last_used_at stays 0
    const rows = store.list();
    expect(rows).toHaveLength(3);
    expect(rows[0].skillId).toBe(a.skill_id);
    expect(rows[1].skillId).toBe(b.skill_id);
    expect(rows[2].skillId).toBe(c.skill_id);
  });

  test('list filters by contract_id', async () => {
    await store.record(baseRecord({ name: 'a', contractId: 'k-1' }));
    await store.record(baseRecord({ name: 'b', contractId: 'k-2' }));
    await store.record(baseRecord({ name: 'c', contractId: 'k-1' }));
    const filtered = store.list({ contract_id: 'k-1' });
    expect(filtered).toHaveLength(2);
    for (const row of filtered) {
      expect(row.contractId).toBe('k-1');
    }
  });

  test('list respects limit', async () => {
    await store.record(baseRecord({ name: 'a' }));
    await store.record(baseRecord({ name: 'b' }));
    await store.record(baseRecord({ name: 'c' }));
    expect(store.list({ limit: 2 })).toHaveLength(2);
    expect(store.list({ limit: 0 })).toHaveLength(0);
  });

  test('list on a fresh store returns []', () => {
    expect(store.list()).toEqual([]);
  });
});

describe('SkillMemoryStore — markUsed', () => {
  let root: string;
  let store: SkillMemoryStore;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('increments success_count only when success=true', async () => {
    const { skill_id } = await store.record(baseRecord());
    await store.markUsed(skill_id, 1000, true);
    await store.markUsed(skill_id, 2000, false);
    await store.markUsed(skill_id, 3000, true);
    const got = store.get(skill_id);
    expect(got?.successCount).toBe(2);
    expect(got?.lastUsedAt).toBe(3000);
  });

  test('updates last_used_at even on failure', async () => {
    const { skill_id } = await store.record(baseRecord());
    await store.markUsed(skill_id, 1234, false);
    expect(store.get(skill_id)?.lastUsedAt).toBe(1234);
    expect(store.get(skill_id)?.successCount).toBe(0);
  });

  test('throws on unknown skill_id', async () => {
    await expect(store.markUsed('missing', 1, true)).rejects.toThrow(/unknown skill_id/);
  });

  test('rejects non-finite ts', async () => {
    const { skill_id } = await store.record(baseRecord());
    await expect(store.markUsed(skill_id, Number.NaN, true)).rejects.toThrow(/finite number/);
  });
});

describe('SkillMemoryStore — frozen snapshots', () => {
  let root: string;
  let store: SkillMemoryStore;

  beforeEach(() => {
    root = tempRoot();
    store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('writeFrozenSnapshot gzip-encodes JSON to disk', () => {
    const { snapshot_path } = store.writeFrozenSnapshot('skill-1', { hello: 'world', n: 42 });
    expect(snapshot_path.endsWith(`${path.sep}skill-1.json.gz`)).toBe(true);
    const raw = fs.readFileSync(snapshot_path);
    const decoded = JSON.parse(zlib.gunzipSync(raw).toString('utf8')) as Record<string, unknown>;
    expect(decoded).toEqual({ hello: 'world', n: 42 });
  });

  test('readFrozenSnapshot round-trips the payload', () => {
    const payload = { steps: [1, 2, 3], meta: { author: 'agent' } };
    const { snapshot_path } = store.writeFrozenSnapshot('skill-rt', payload);
    expect(store.readFrozenSnapshot(snapshot_path)).toEqual(payload);
  });

  test('snapshots are write-once', () => {
    store.writeFrozenSnapshot('skill-once', { v: 1 });
    expect(() => store.writeFrozenSnapshot('skill-once', { v: 2 })).toThrow(/write-once/);
  });

  test('readFrozenSnapshot rejects paths outside the snapshots dir', () => {
    store.writeFrozenSnapshot('skill-x', { v: 1 });
    // Construct a sibling file that is NOT under snapshots/.
    const outside = path.join(root, 'outside.json.gz');
    fs.writeFileSync(outside, zlib.gzipSync(Buffer.from('{}', 'utf8')));
    expect(() => store.readFrozenSnapshot(outside)).toThrow(/outside the domain snapshots dir/);
  });

  test('rejects unsafe snapshot ids', () => {
    expect(() => store.writeFrozenSnapshot('', { v: 1 })).toThrow(/non-empty string/);
    expect(() => store.writeFrozenSnapshot('foo/bar', { v: 1 })).toThrow(/path separator/);
    expect(() => store.writeFrozenSnapshot('../escape', { v: 1 })).toThrow(/begins with a dot/);
    expect(() => store.writeFrozenSnapshot('.hidden', { v: 1 })).toThrow(/begins with a dot/);
  });
});

describe('SkillMemoryStore — file layout + schema', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('writes one JSON file per domain with schema_version=1', async () => {
    const a = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const b = new SkillMemoryStore({ rootDir: root, domain: 'ebay.com' });
    await a.record(baseRecord({ domain: 'amazon.com', name: 'cart' }));
    await b.record(baseRecord({ domain: 'ebay.com', name: 'bid' }));
    const aFile = path.join(root, 'amazon.com', 'skills.json');
    const bFile = path.join(root, 'ebay.com', 'skills.json');
    expect(fs.existsSync(aFile)).toBe(true);
    expect(fs.existsSync(bFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(aFile, 'utf8'));
    expect(parsed.schema_version).toBe(SKILL_MEMORY_SCHEMA_VERSION);
    expect(typeof parsed.skills).toBe('object');
  });

  test('domains with reserved Windows names get an underscore prefix', async () => {
    const store = new SkillMemoryStore({ rootDir: root, domain: 'CON' });
    await store.record({
      domain: 'CON',
      name: 'foo',
      steps: [],
      contractId: 'c',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
    });
    expect(fs.existsSync(path.join(root, '_CON', 'skills.json'))).toBe(true);
  });

  test('unsafe domain characters are percent-encoded into the path', async () => {
    const store = new SkillMemoryStore({ rootDir: root, domain: 'evil/../escape' });
    await store.record({
      domain: 'evil/../escape',
      name: 'foo',
      steps: [],
      contractId: 'c',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
    });
    // No traversal happened; everything ends up under a single basename
    // (slashes are percent-encoded so `path.join` cannot escape root).
    const entries = fs.readdirSync(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('/');
    expect(entries[0]).not.toContain('\\');
    expect(entries[0]).toContain('%2F');
    // The reconstructed absolute path must still live inside root.
    const reconstructed = path.resolve(root, entries[0]);
    expect(reconstructed.startsWith(path.resolve(root) + path.sep)).toBe(true);
  });

  test('skips skills.json with an unknown schema_version', async () => {
    const store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    // Bootstrap the domain dir so we can plant a bad file in place.
    await store.record(baseRecord());
    const file = path.join(root, 'amazon.com', 'skills.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ schema_version: 999, skills: { fake: {} } }),
      'utf8',
    );
    // Silence the console.error from the schema-mismatch path so the
    // jest output is not polluted.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(store.list()).toEqual([]);
      expect(store.get('fake')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('record across different domains does not contend (parallel safe)', async () => {
    const a = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    const b = new SkillMemoryStore({ rootDir: root, domain: 'ebay.com' });
    await Promise.all([
      a.record(baseRecord({ domain: 'amazon.com', name: 'cart' })),
      b.record(baseRecord({ domain: 'ebay.com', name: 'bid' })),
    ]);
    expect(a.list()).toHaveLength(1);
    expect(b.list()).toHaveLength(1);
  });

  test('sequential records on the same domain serialize without dropping rows', async () => {
    const store = new SkillMemoryStore({ rootDir: root, domain: 'amazon.com' });
    // Run a small batch in parallel — the per-domain lock should
    // serialise the writes so every name lands in the final file.
    const names = ['a', 'b', 'c', 'd', 'e'];
    await Promise.all(
      names.map((n) =>
        store.record(baseRecord({ name: n })),
      ),
    );
    expect(store.list()).toHaveLength(names.length);
  });
});
