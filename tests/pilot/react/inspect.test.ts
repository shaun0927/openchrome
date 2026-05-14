import { assertShimBudget, REACT_DEVTOOLS_SHIM_SOURCE } from '../../../src/pilot/react/devtools-shim';
import { redactSensitive, summarizeFiberTree } from '../../../src/pilot/react/inspect';

describe('pilot React inspection helpers (#838)', () => {
  test('keeps DevTools shim under 8 KiB', () => {
    expect(Buffer.byteLength(REACT_DEVTOOLS_SHIM_SOURCE, 'utf8')).toBeLessThanOrEqual(8192);
    expect(() => assertShimBudget()).not.toThrow();
  });

  test('summarizes a mock fiber tree', () => {
    const child = { type: { displayName: 'Child' }, key: 'c', child: null, sibling: null };
    const root = { current: { type: { name: 'App' }, key: null, child, sibling: null } };
    const snapshot = summarizeFiberTree(root);
    expect(snapshot.available).toBe(true);
    expect(snapshot.tree.map((n) => [n.ref, n.name, n.depth])).toEqual([
      ['@e1', 'App', 0],
      ['@e2', 'Child', 1],
    ]);
  });

  test('redacts sensitive props', () => {
    expect(redactSensitive({ apiKey: 'secret', nested: { token: 'abc', ok: true, note: 'password=hunter2' } })).toEqual({
      apiKey: '[REDACTED]',
      nested: { token: '[REDACTED]', ok: true, note: 'password=[REDACTED]' },
    });
  });
});
