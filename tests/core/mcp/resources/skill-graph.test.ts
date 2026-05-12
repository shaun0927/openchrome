/**
 * Tests for the openchrome://skill-graph/<domain> MCP resource.
 *
 * Coverage:
 *   - Unknown domain returns empty graph (not an error)
 *   - Populated domain returns nodes + edges
 *   - Cache invalidation when the underlying JSON file is touched
 *   - URI encoding round-trips (percent-encoded chars, IPv6-style brackets)
 *   - parseDomainFromUri edge cases
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readSkillGraphResource,
  parseDomainFromUri,
  SKILL_GRAPH_RESOURCE_PREFIX,
  _setRootDirOverride,
} from '../../../../src/resources/skill-graph';
import { SkillGraphStorage } from '../../../../src/core/skill/storage';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sgr-'));
}

describe('readSkillGraphResource — unknown domain', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
    _setRootDirOverride(root);
  });

  afterEach(() => {
    _setRootDirOverride(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns empty graph for a domain that has never been written', () => {
    const raw = readSkillGraphResource('never-seen.com');
    const snapshot = JSON.parse(raw) as { domain: string; nodes: object; edges: unknown[] };
    expect(snapshot.domain).toBe('never-seen.com');
    expect(snapshot.nodes).toEqual({});
    expect(snapshot.edges).toEqual([]);
  });

  test('does not throw for an unknown domain', () => {
    expect(() => readSkillGraphResource('ghost.example')).not.toThrow();
  });
});

describe('readSkillGraphResource — populated domain', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
    _setRootDirOverride(root);
  });

  afterEach(() => {
    _setRootDirOverride(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns nodes and edges written by SkillGraphStorage', async () => {
    const store = new SkillGraphStorage({ domain: 'example.com', rootDir: root });
    await store.upsertNode({ stateHash: 'hash-abc', seenAt: 1000 });
    await store.recordEdge({
      from_state: 'hash-abc',
      action_kind: 'click',
      action_args_norm: '{"selector":"button"}',
      to_state: 'hash-def',
    });
    store.close();

    const raw = readSkillGraphResource('example.com');
    const snapshot = JSON.parse(raw) as {
      domain: string;
      nodes: Record<string, unknown>;
      edges: unknown[];
    };

    expect(snapshot.domain).toBe('example.com');
    expect(Object.keys(snapshot.nodes)).toContain('hash-abc');
    expect(snapshot.edges).toHaveLength(1);
    const edge = snapshot.edges[0] as { from_state: string; action_kind: string };
    expect(edge.from_state).toBe('hash-abc');
    expect(edge.action_kind).toBe('click');
  });

  test('schema_version is 1', async () => {
    const store = new SkillGraphStorage({ domain: 'versioned.com', rootDir: root });
    store.close();

    const raw = readSkillGraphResource('versioned.com');
    const snapshot = JSON.parse(raw) as { schema_version: number };
    expect(snapshot.schema_version).toBe(1);
  });
});

describe('readSkillGraphResource — cache invalidation', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
    _setRootDirOverride(root);
  });

  afterEach(() => {
    _setRootDirOverride(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('serves cached snapshot when file is unchanged', async () => {
    const store = new SkillGraphStorage({ domain: 'cached.com', rootDir: root });
    await store.upsertNode({ stateHash: 'node-1', seenAt: 100 });
    store.close();

    const first = readSkillGraphResource('cached.com');
    const second = readSkillGraphResource('cached.com');
    // Both calls return identical JSON when nothing changed.
    expect(first).toBe(second);
  });

  test('re-reads after the underlying JSON file is touched (mtime changes)', async () => {
    const store = new SkillGraphStorage({ domain: 'touch-test.com', rootDir: root });
    await store.upsertNode({ stateHash: 'before', seenAt: 1 });
    store.close();

    // Prime the cache.
    const before = JSON.parse(readSkillGraphResource('touch-test.com')) as {
      nodes: Record<string, unknown>;
    };
    expect(Object.keys(before.nodes)).toContain('before');
    expect(Object.keys(before.nodes)).not.toContain('after');

    // Wait a tick so the mtime will differ even on coarse (1 s) filesystems.
    // We do this by explicitly setting a future mtime on the file.
    const filePath = path.join(root, 'touch-test.com.json');
    const stat = fs.statSync(filePath);

    // Write a new node (this changes the file content + mtime).
    const store2 = new SkillGraphStorage({ domain: 'touch-test.com', rootDir: root });
    await store2.upsertNode({ stateHash: 'after', seenAt: 2 });
    store2.close();

    // Force an mtime change even if the write completed within the same ms.
    const futureMs = stat.mtimeMs + 2000;
    fs.utimesSync(filePath, new Date(futureMs), new Date(futureMs));

    const after = JSON.parse(readSkillGraphResource('touch-test.com')) as {
      nodes: Record<string, unknown>;
    };
    expect(Object.keys(after.nodes)).toContain('after');
  });
});

describe('readSkillGraphResource — URL encoding round-trips', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
    _setRootDirOverride(root);
  });

  afterEach(() => {
    _setRootDirOverride(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('percent-encoded domain characters decode correctly', async () => {
    // Domain with a path-like component; the resource URI encodes it.
    const domain = 'sub.example.com:8080';
    const store = new SkillGraphStorage({ domain, rootDir: root });
    await store.upsertNode({ stateHash: 'port-node', seenAt: 1 });
    store.close();

    const raw = readSkillGraphResource(domain);
    const snapshot = JSON.parse(raw) as { domain: string };
    expect(snapshot.domain).toBe(domain);
  });

  test('IPv6-style bracketed domain encodes and decodes round-trip', async () => {
    // Brackets are encoded by encodeURIComponent: [ → %5B, ] → %5D
    const domain = '[::1]';
    const store = new SkillGraphStorage({ domain, rootDir: root });
    store.close();

    const encoded = encodeURIComponent(domain);
    const uri = `${SKILL_GRAPH_RESOURCE_PREFIX}${encoded}`;
    const decoded = parseDomainFromUri(uri);
    expect(decoded).toBe(domain);

    const raw = readSkillGraphResource(domain);
    const snapshot = JSON.parse(raw) as { domain: string };
    expect(snapshot.domain).toBe(domain);
  });
});

describe('parseDomainFromUri', () => {
  test('extracts domain from a valid URI', () => {
    expect(parseDomainFromUri('openchrome://skill-graph/amazon.com')).toBe('amazon.com');
  });

  test('decodes percent-encoded characters', () => {
    expect(parseDomainFromUri('openchrome://skill-graph/sub.example.com%3A8080')).toBe(
      'sub.example.com:8080',
    );
  });

  test('returns null for unrelated URI', () => {
    expect(parseDomainFromUri('openchrome://usage-guide')).toBeNull();
  });

  test('returns null for bare prefix with no domain', () => {
    expect(parseDomainFromUri('openchrome://skill-graph/')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseDomainFromUri('')).toBeNull();
  });
});
