/**
 * Unit tests for the state-graph hasher factory.
 *
 * Coverage:
 *   - Returns `null` when `--pilot` is unset (family gate closed).
 *   - Returns `null` when `--pilot` is set but
 *     OPENCHROME_STATE_GRAPH is explicitly falsy.
 *   - Returns a hex hash when both gates are open and the URL parses.
 *   - Swallows a throwing/rejecting URL provider and returns null.
 *   - Returns null for unparseable / empty URLs.
 *   - Resolves a Promise-returning URL provider.
 */

import { createStateHasher } from '../../../src/pilot/state-graph/factory.js';
import { resetFlagsCache } from '../../../src/harness/flags.js';

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_ENV = { ...process.env };

function setPilot(enabled: boolean): void {
  if (enabled) {
    process.argv = ['node', 'cli/index.js', '--pilot'];
  } else {
    process.argv = ['node', 'cli/index.js'];
  }
  resetFlagsCache();
}

beforeEach(() => {
  delete process.env.OPENCHROME_PILOT;
  delete process.env.OPENCHROME_STATE_GRAPH;
});

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
  process.env = { ...ORIGINAL_ENV };
  resetFlagsCache();
});

describe('createStateHasher', () => {
  it('returns null when pilot is off (no --pilot flag)', async () => {
    setPilot(false);
    const hasher = createStateHasher(() => 'https://example.com/cart');
    expect(await hasher()).toBeNull();
  });

  it('returns null when pilot is on but OPENCHROME_STATE_GRAPH is explicitly falsy', async () => {
    setPilot(true);
    process.env.OPENCHROME_STATE_GRAPH = '0';
    const hasher = createStateHasher(() => 'https://example.com/cart');
    expect(await hasher()).toBeNull();
  });

  it('returns a v1 result when pilot + state-graph are enabled (URL-only legacy thunk)', async () => {
    setPilot(true);
    const hasher = createStateHasher(() => 'https://example.com/cart');
    const result = await hasher();
    expect(result).not.toBeNull();
    expect(result?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(result?.version).toBe('v1');
  });

  it('returns a v2 result when the probe supplies a DOM skeleton', async () => {
    setPilot(true);
    const hasher = createStateHasher({
      url: () => 'https://example.com/cart',
      skeleton: () => ({
        tree: { tag: 'body', children: [{ tag: 'form' }] },
        landmarks: ['main'],
        counts: { forms: 1, buttons: 1, inputs: 1, links: 1, headings: 1 },
      }),
    });
    const result = await hasher();
    expect(result?.version).toBe('v2');
    expect(result?.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back to v1 when the skeleton probe yields null', async () => {
    setPilot(true);
    const hasher = createStateHasher({
      url: () => 'https://example.com/cart',
      skeleton: () => null,
    });
    const result = await hasher();
    expect(result?.version).toBe('v1');
  });

  it('falls back to v1 when the skeleton probe throws', async () => {
    setPilot(true);
    const hasher = createStateHasher({
      url: () => 'https://example.com/cart',
      skeleton: () => { throw new Error('probe blew up'); },
    });
    const result = await hasher();
    expect(result?.version).toBe('v1');
  });

  it('swallows a synchronously throwing URL provider and returns null', async () => {
    setPilot(true);
    const hasher = createStateHasher(() => {
      throw new Error('probe exploded');
    });
    expect(await hasher()).toBeNull();
  });

  it('swallows a rejecting promise URL provider and returns null', async () => {
    setPilot(true);
    const hasher = createStateHasher(async () => {
      throw new Error('async probe failure');
    });
    expect(await hasher()).toBeNull();
  });

  it('returns null when the URL provider yields an unparseable string', async () => {
    setPilot(true);
    const hasher = createStateHasher(() => 'not a url');
    expect(await hasher()).toBeNull();
  });

  it('returns null when the URL provider yields null/undefined/empty', async () => {
    setPilot(true);
    expect(await createStateHasher(() => null)()).toBeNull();
    expect(await createStateHasher(() => undefined)()).toBeNull();
    expect(await createStateHasher(() => '')()).toBeNull();
  });

  it('resolves a Promise-returning URL provider', async () => {
    setPilot(true);
    const hasher = createStateHasher(async () => 'https://example.com/cart');
    const result = await hasher();
    expect(result?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(result?.version).toBe('v1');
  });
});
