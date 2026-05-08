import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HASH_BITS,
  ScreenshotClassRegistry,
  normalizeClassId,
  recommendThreshold,
} from '../../src/contracts/screenshot-classes';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scls-'));
}

describe('normalizeClassId', () => {
  test('accepts versioned slash-segmented ids', () => {
    expect(normalizeClassId('order-confirmation/v3')).toBe('order-confirmation/v3');
  });

  test('strips leading/trailing/redundant slashes', () => {
    expect(normalizeClassId('//foo///bar//')).toBe('foo/bar');
  });

  test('rejects path traversal', () => {
    expect(() => normalizeClassId('../etc/passwd')).toThrow();
    expect(() => normalizeClassId('a/../b')).toThrow();
    expect(() => normalizeClassId('a\\b')).toThrow();
  });

  test('rejects dot-only segments (resolve to registry root or parent)', () => {
    expect(() => normalizeClassId('.')).toThrow();
    expect(() => normalizeClassId('./escape')).toThrow();
    expect(() => normalizeClassId('a/./b')).toThrow();
  });

  test('rejects empty / non-string', () => {
    expect(() => normalizeClassId('')).toThrow();
    expect(() => normalizeClassId(undefined as unknown as string)).toThrow();
  });

  test('rejects illegal characters', () => {
    expect(() => normalizeClassId('foo bar')).toThrow();
    expect(() => normalizeClassId('foo$bar')).toThrow();
  });
});

describe('recommendThreshold', () => {
  test('single exemplar → conservative default 8', () => {
    expect(recommendThreshold(['ffffffffffffffff'])).toBe(8);
  });

  test('identical exemplars (zero variance) → minimum 2', () => {
    expect(recommendThreshold(['aaaa000000000000', 'aaaa000000000000', 'aaaa000000000000'])).toBe(2);
  });

  test('result clamped within [2, 16]', () => {
    // Wildly different exemplars would push threshold high; clamp to 16.
    const r = recommendThreshold([
      '0000000000000000',
      'ffffffffffffffff',
      '1234567890abcdef',
    ]);
    expect(r).toBeGreaterThanOrEqual(2);
    expect(r).toBeLessThanOrEqual(16);
  });

  test('hash_bits constant is 64', () => {
    expect(HASH_BITS).toBe(64);
  });
});

describe('ScreenshotClassRegistry — basic teach + load', () => {
  let root: string;
  let reg: ScreenshotClassRegistry;

  beforeEach(() => {
    root = tempRoot();
    reg = new ScreenshotClassRegistry({ rootDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('exists() returns false for unseen class', () => {
    expect(reg.exists('never/seen')).toBe(false);
    expect(reg.load('never/seen')).toBeNull();
  });

  test('teach() then load() round-trips one exemplar', () => {
    reg.teach({
      classId: 'order-confirmation/v1',
      precomputed: { bits: 0x1234n, hex: '0000000000001234' },
    });
    expect(reg.exists('order-confirmation/v1')).toBe(true);
    const rec = reg.load('order-confirmation/v1');
    expect(rec?.exemplars).toEqual(['0000000000001234']);
    expect(rec?.threshold.exemplar_count).toBe(1);
    expect(rec?.threshold.value).toBe(8); // single-exemplar default
  });

  test('teach() de-duplicates identical exemplars', () => {
    reg.teach({ classId: 'c', precomputed: { bits: 0n, hex: '0000000000000000' } });
    reg.teach({ classId: 'c', precomputed: { bits: 0n, hex: '0000000000000000' } });
    expect(reg.load('c')?.exemplars).toEqual(['0000000000000000']);
  });

  test('teach() with multiple distinct exemplars updates threshold', () => {
    reg.teach({ classId: 'c', precomputed: { bits: 0n, hex: '0000000000000000' } });
    reg.teach({ classId: 'c', precomputed: { bits: 0xfn, hex: '000000000000000f' } });
    const rec = reg.load('c')!;
    expect(rec.exemplars).toHaveLength(2);
    expect(rec.threshold.exemplar_count).toBe(2);
    // Mean distance is 4 (bits 0..3 differ), σ=0 → recommended ≈ 4
    expect(rec.threshold.value).toBe(4);
  });

  test('teach() rejects when neither precomputed nor rgba+dims is supplied', () => {
    expect(() => reg.teach({ classId: 'c' })).toThrow();
  });
});

describe('ScreenshotClassRegistry — match', () => {
  let root: string;
  let reg: ScreenshotClassRegistry;

  beforeEach(() => {
    root = tempRoot();
    reg = new ScreenshotClassRegistry({ rootDir: root });
    reg.teach({
      classId: 'cls',
      precomputed: { bits: 0xff00ff00ff00ff00n, hex: 'ff00ff00ff00ff00' },
    });
    reg.teach({
      classId: 'cls',
      precomputed: { bits: 0x00ff00ff00ff00ffn, hex: '00ff00ff00ff00ff' },
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('exact match → distance 0', () => {
    const r = reg.match('cls', 'ff00ff00ff00ff00');
    expect(r.distance).toBe(0);
    expect(r.closestHex).toBe('ff00ff00ff00ff00');
  });

  test('closer-of-two exemplars wins', () => {
    // 'ff00ff00ff00ff01' differs from 'ff00ff00ff00ff00' by 1 bit
    // and from '00ff00ff00ff00ff' by 63 bits.
    const r = reg.match('cls', 'ff00ff00ff00ff01');
    expect(r.distance).toBe(1);
    expect(r.closestHex).toBe('ff00ff00ff00ff00');
  });

  test('unknown class → distance Infinity', () => {
    expect(reg.match('nope', 'ffffffffffffffff').distance).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('ScreenshotClassRegistry — robustness against corrupt exemplars', () => {
  let root: string;
  let reg: ScreenshotClassRegistry;

  beforeEach(() => {
    root = tempRoot();
    reg = new ScreenshotClassRegistry({ rootDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('match() ignores corrupt hex entries instead of throwing', () => {
    reg.teach({
      classId: 'cls',
      precomputed: { bits: 0xff00ff00ff00ff00n, hex: 'ff00ff00ff00ff00' },
    });
    // exemplars.json is documented as human-readable / editable.
    // Inject a hand-edit with one valid hash and several corrupt ones:
    // wrong length, bad chars, completely non-hex.
    const dir = path.join(root, 'cls');
    fs.writeFileSync(
      path.join(dir, 'exemplars.json'),
      JSON.stringify({
        hashes: [
          'ff00ff00ff00ff00', // valid
          'not-a-hash',       // garbage
          'ff00',             // too short
          'ff00ff00ff00ff00ff00', // too long
          'ZZZZZZZZZZZZZZZZ', // bad chars
        ],
      }),
      'utf8',
    );
    expect(() => reg.match('cls', 'ff00ff00ff00ff01')).not.toThrow();
    const r = reg.match('cls', 'ff00ff00ff00ff01');
    expect(r.distance).toBe(1);
    expect(r.closestHex).toBe('ff00ff00ff00ff00');
  });
});
