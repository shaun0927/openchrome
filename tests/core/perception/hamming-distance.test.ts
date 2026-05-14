/// <reference types="jest" />

import { hammingDistance } from '../../../src/core/perception/cache';

describe('hammingDistance', () => {
  test('computes known hex vector distances', () => {
    expect(hammingDistance('0', '0')).toBe(0);
    expect(hammingDistance('f', '0')).toBe(4);
    expect(hammingDistance('0f', 'f0')).toBe(8);
    expect(hammingDistance('ffff', 'fffe')).toBe(1);
  });
});
