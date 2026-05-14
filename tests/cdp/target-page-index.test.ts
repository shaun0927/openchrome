/// <reference types="jest" />

import { TargetPageIndex } from '../../src/cdp/target-page-index';

describe('TargetPageIndex', () => {
  const page = { isClosed: jest.fn().mockReturnValue(false) } as any;

  test('mirrors the Map operations CDPClient uses for target page lookup', () => {
    const index = new TargetPageIndex();

    expect(index.size).toBe(0);
    expect(index.has('target-1')).toBe(false);

    expect(index.set('target-1', page)).toBe(index);
    expect(index.size).toBe(1);
    expect(index.has('target-1')).toBe(true);
    expect(index.get('target-1')).toBe(page);

    expect(index.delete('target-1')).toBe(true);
    expect(index.delete('target-1')).toBe(false);
    expect(index.size).toBe(0);
  });

  test('clears all indexed pages', () => {
    const index = new TargetPageIndex();
    index.set('target-1', page);
    index.set('target-2', page);

    index.clear();

    expect(index.size).toBe(0);
    expect(index.get('target-1')).toBeUndefined();
    expect(index.get('target-2')).toBeUndefined();
  });
});
