/// <reference types="jest" />

import { aliasFor, RefIdManager, refIdFromAlias } from '../../src/utils/ref-id-manager';

describe('short element aliases', () => {
  test('projects ref_N to @eN and back', () => {
    expect(aliasFor('ref_7')).toBe('@e7');
    expect(refIdFromAlias('@e7')).toBe('ref_7');
    expect(aliasFor('node_7')).toBeUndefined();
  });

  test('resolves @eN through the same target map as ref_N', () => {
    const manager = new RefIdManager();
    const ref = manager.generateRef('s', 't', 123, 'button', 'Save');
    expect(ref).toBe('ref_1');
    expect(manager.getBackendDOMNodeId('s', 't', '@e1')).toBe(123);
    expect(manager.resolveToBackendNodeId('s', 't', '@e1')).toBe(123);
  });

  test('alias projection is collision-free across 10000 mints', () => {
    const manager = new RefIdManager();
    const aliases = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const ref = manager.generateRef('s', 't', i + 1, 'button');
      const alias = aliasFor(ref)!;
      expect(aliases.has(alias)).toBe(false);
      aliases.add(alias);
    }
  });
});
