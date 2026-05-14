/**
 * Unit tests for `BackendNodeRegistry` (#844).
 *
 * Covers the four cases from the issue acceptance criteria plus auxiliary
 * checks: uid format, opacity (uid does not echo backendNodeId), and the
 * `isCoreFeatureEnabled` helper used by the call sites.
 */

import {
  InMemoryBackendNodeRegistry,
  type StableUid,
} from '../../../src/core/perception/backend-node-registry';
import { isCoreFeatureEnabled } from '../../../src/harness/flags';
import {
  NODE_REF_OFF,
  formatNodeRefToken,
  formatUidEvictedError,
  isNodeRefEnabled,
  mintNodeRefSync,
  resolveNodeRef,
} from '../../../src/core/perception/node-ref';

describe('BackendNodeRegistry — invariants from issue #844', () => {
  test('mints + reuses the same uid within one loaderId', () => {
    const reg = new InMemoryBackendNodeRegistry();
    const a = reg.get('loader-A', 42);
    const b = reg.get('loader-A', 42);
    expect(b.uid).toBe(a.uid);
    expect(b.backendNodeId).toBe(42);
    expect(b.loaderId).toBe('loader-A');
    // lastSeenAt should be monotonically non-decreasing on reuse.
    expect(b.lastSeenAt).toBeGreaterThanOrEqual(a.lastSeenAt);
    expect(reg.size()).toBe(1);
  });

  test('mints distinct uids for distinct backendNodeIds within one loaderId', () => {
    const reg = new InMemoryBackendNodeRegistry();
    const a = reg.get('loader-A', 1);
    const b = reg.get('loader-A', 2);
    expect(a.uid).not.toBe(b.uid);
    expect(reg.size()).toBe(2);
  });

  test('rotates on loaderId change and reports eviction count', () => {
    const reg = new InMemoryBackendNodeRegistry();
    reg.get('loader-A', 1);
    reg.get('loader-A', 2);
    reg.get('loader-A', 3);
    const result = reg.rotate('loader-B');
    expect(result.evicted).toBe(3);
    expect(result.kept).toBe(0);
    expect(reg.size()).toBe(0);
  });

  test('rotate keeps entries already on the current loaderId', () => {
    const reg = new InMemoryBackendNodeRegistry();
    reg.get('loader-A', 1);
    // Mint another on loader-B as if a navigation already happened
    // mid-stream — typically callers rotate first, but the data structure
    // must handle the heterogeneous case.
    reg.get('loader-B', 2);
    const result = reg.rotate('loader-B');
    expect(result.evicted).toBe(1);
    expect(result.kept).toBe(1);
    expect(reg.size()).toBe(1);
  });

  test('resolve returns null after rotation evicts the uid', () => {
    const reg = new InMemoryBackendNodeRegistry();
    const minted: StableUid = reg.get('loader-A', 99);
    expect(reg.resolve(minted.uid)).toEqual({ loaderId: 'loader-A', backendNodeId: 99 });
    reg.rotate('loader-B');
    expect(reg.resolve(minted.uid)).toBeNull();
  });

  test('resolve returns null for an unknown uid', () => {
    const reg = new InMemoryBackendNodeRegistry();
    expect(reg.resolve('n_99999')).toBeNull();
  });

  test('uid is opaque: never echoes backendNodeId', () => {
    const reg = new InMemoryBackendNodeRegistry();
    const a = reg.get('loader-A', 142857);
    expect(a.uid.startsWith(reg.UID_PREFIX)).toBe(true);
    expect(a.uid).not.toContain('142857');
  });

  test('uid counter is monotonic across rotations to prevent aliasing', () => {
    const reg = new InMemoryBackendNodeRegistry();
    const before = reg.get('loader-A', 1).uid;
    reg.rotate('loader-B');
    const after = reg.get('loader-B', 1).uid;
    // Issuing a new uid for the same backendNodeId after rotation MUST
    // produce a fresh uid, never the previously-evicted one.
    expect(after).not.toBe(before);
  });

  test('rejects malformed inputs', () => {
    const reg = new InMemoryBackendNodeRegistry();
    expect(() => reg.get('', 1)).toThrow(/loaderId/);
    expect(() => reg.get('loader-A', 0)).toThrow(/backendNodeId/);
    expect(() => reg.get('loader-A', -1)).toThrow(/backendNodeId/);
    expect(() => reg.get('loader-A', 1.5)).toThrow(/backendNodeId/);
    expect(() => reg.rotate('')).toThrow(/currentLoaderId/);
  });
});

describe('isCoreFeatureEnabled — #844 helper', () => {
  const PREV: Record<string, string | undefined> = {};

  function setEnv(key: string, val: string | undefined): void {
    if (!(key in PREV)) PREV[key] = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(PREV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('defaults to ON when defaultOn=true and env is unset', () => {
    setEnv('OPENCHROME_TEST_FLAG_844', undefined);
    expect(isCoreFeatureEnabled('OPENCHROME_TEST_FLAG_844', true)).toBe(true);
  });

  test('defaults to OFF when defaultOn=false and env is unset', () => {
    setEnv('OPENCHROME_TEST_FLAG_844', undefined);
    expect(isCoreFeatureEnabled('OPENCHROME_TEST_FLAG_844', false)).toBe(false);
  });

  test('honours explicit falsy override when defaultOn=true', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'Off']) {
      setEnv('OPENCHROME_TEST_FLAG_844', v);
      expect(isCoreFeatureEnabled('OPENCHROME_TEST_FLAG_844', true)).toBe(false);
    }
  });

  test('honours explicit truthy override when defaultOn=false', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
      setEnv('OPENCHROME_TEST_FLAG_844', v);
      expect(isCoreFeatureEnabled('OPENCHROME_TEST_FLAG_844', false)).toBe(true);
    }
  });

  test('treats whitespace-only as unset', () => {
    setEnv('OPENCHROME_TEST_FLAG_844', '   ');
    expect(isCoreFeatureEnabled('OPENCHROME_TEST_FLAG_844', true)).toBe(true);
    expect(isCoreFeatureEnabled('OPENCHROME_TEST_FLAG_844', false)).toBe(false);
  });

  test('does not depend on isPilotEnabled state', () => {
    // Core flags are evaluated independently of `--pilot`.
    setEnv('OPENCHROME_PILOT', undefined);
    setEnv('OPENCHROME_NODE_REF', undefined);
    expect(isCoreFeatureEnabled('OPENCHROME_NODE_REF', true)).toBe(true);
  });
});

describe('node-ref helpers (#844 tool-side facade)', () => {
  const PREV: Record<string, string | undefined> = {};
  function setEnv(key: string, val: string | undefined): void {
    if (!(key in PREV)) PREV[key] = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(PREV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('formatNodeRefToken renders nodeRef=null when uid is null', () => {
    expect(formatNodeRefToken(null)).toBe('nodeRef=null');
    expect(formatNodeRefToken('n_42')).toBe('nodeRef=n_42');
  });

  test('formatUidEvictedError starts with the uid_evicted: prefix and embeds JSON', () => {
    const out = formatUidEvictedError('n_7', 'loader-NEW');
    expect(out.startsWith('uid_evicted:')).toBe(true);
    expect(out).toContain('"uid":"n_7"');
    expect(out).toContain('"currentLoaderId":"loader-NEW"');
  });

  test('isNodeRefEnabled defaults to true', () => {
    setEnv('OPENCHROME_NODE_REF', undefined);
    expect(isNodeRefEnabled()).toBe(true);
  });

  test('isNodeRefEnabled is false when OPENCHROME_NODE_REF=0', () => {
    setEnv('OPENCHROME_NODE_REF', '0');
    expect(isNodeRefEnabled()).toBe(false);
  });

  test('mintNodeRefSync returns null when feature flag is off', () => {
    setEnv('OPENCHROME_NODE_REF', '0');
    // Page is unused on the off branch; cast accordingly.
    const fakePage = {} as unknown as Parameters<typeof mintNodeRefSync>[0];
    expect(mintNodeRefSync(fakePage, 'loader-A', 42)).toBe(NODE_REF_OFF);
  });

  test('resolveNodeRef returns null when feature flag is off', () => {
    setEnv('OPENCHROME_NODE_REF', '0');
    const fakePage = {} as unknown as Parameters<typeof resolveNodeRef>[0];
    expect(resolveNodeRef(fakePage, 'n_1')).toBeNull();
  });
});
