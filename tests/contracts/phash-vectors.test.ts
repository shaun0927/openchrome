/// <reference types="jest" />

import {
  hamming,
  phashFromHex,
  phashFromPng,
  phashFromRgba,
  phashToHex,
} from '../../src/contracts/phash';
import { decodePng } from '../../src/contracts/png-decode';
import {
  checkerRgba,
  encodeRgbaPng,
  gradientRgba,
  solidRgba,
} from './png-fixtures';

describe('pHash — pure-TS perceptual hash', () => {
  test('hex round-trip is lossless', () => {
    const hex = 'fedcba9876543210';
    expect(phashToHex(phashFromHex(hex))).toBe(hex);
  });

  test('phashToHex always emits 16 chars', () => {
    expect(phashToHex(0n)).toHaveLength(16);
    expect(phashToHex(1n)).toBe('0000000000000001');
  });

  test('hamming distance has expected boundaries', () => {
    expect(hamming(0n, 0n)).toBe(0);
    expect(hamming(0n, (1n << 64n) - 1n)).toBe(64);
    expect(hamming(0b101n, 0b011n)).toBe(2);
  });

  test('identical RGBA inputs produce identical hashes', () => {
    const a = gradientRgba(64, 64);
    const b = gradientRgba(64, 64);
    const ha = phashFromRgba({ width: 64, height: 64, rgba: new Uint8ClampedArray(a) });
    const hb = phashFromRgba({ width: 64, height: 64, rgba: new Uint8ClampedArray(b) });
    // Compare via hex — Jest's worker IPC cannot serialize bigint values for
    // assertion diffs, so always lower bigints to strings/numbers in tests.
    expect(phashToHex(ha)).toBe(phashToHex(hb));
  });

  test('different content produces different hashes', () => {
    const a = solidRgba(32, 32, [255, 0, 0, 255]);
    const b = checkerRgba(32, 32, 4);
    const ha = phashFromRgba({ width: 32, height: 32, rgba: new Uint8ClampedArray(a) });
    const hb = phashFromRgba({ width: 32, height: 32, rgba: new Uint8ClampedArray(b) });
    expect(hamming(ha, hb)).toBeGreaterThan(0);
  });

  test('PNG encode → decode → hash matches the in-memory RGBA hash', () => {
    const rgba = gradientRgba(48, 48);
    const png = encodeRgbaPng(48, 48, rgba);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(48);
    expect(decoded.height).toBe(48);
    const fromPng = phashFromPng(png);
    const fromRgba = phashFromRgba({
      width: 48,
      height: 48,
      rgba: new Uint8ClampedArray(rgba),
    });
    expect(phashToHex(fromPng)).toBe(phashToHex(fromRgba));
  });

  test('uniform images hash deterministically (same input → same hash)', () => {
    // Mathematically a uniform image has zero AC energy, but the DCT runs in
    // float64 so the kept block is filled with rounding noise (~1e-12). What
    // matters is reproducibility, not the bit pattern itself.
    const rgba = solidRgba(64, 64, [123, 200, 50, 255]);
    const a = phashFromRgba({
      width: 64,
      height: 64,
      rgba: new Uint8ClampedArray(rgba),
    });
    const b = phashFromRgba({
      width: 64,
      height: 64,
      rgba: new Uint8ClampedArray(rgba),
    });
    expect(phashToHex(a)).toBe(phashToHex(b));
  });

  test('small per-pixel noise keeps Hamming distance small', () => {
    const base = gradientRgba(80, 80);
    const noisy = Buffer.from(base);
    // Add ±2 jitter to luminance channels.
    for (let i = 0; i < noisy.length; i += 4) {
      noisy[i] = Math.min(255, Math.max(0, noisy[i] + ((i % 5) - 2)));
    }
    const a = phashFromRgba({ width: 80, height: 80, rgba: new Uint8ClampedArray(base) });
    const b = phashFromRgba({ width: 80, height: 80, rgba: new Uint8ClampedArray(noisy) });
    expect(hamming(a, b)).toBeLessThanOrEqual(8);
  });

  test('rejects malformed PNG buffers loudly', () => {
    expect(() => phashFromPng(Buffer.from('not a png'))).toThrow(/PNG/);
  });

  test('phashFromHex rejects malformed hex', () => {
    expect(() => phashFromHex('zz')).toThrow();
    expect(() => phashFromHex('0123')).toThrow();
  });
});
