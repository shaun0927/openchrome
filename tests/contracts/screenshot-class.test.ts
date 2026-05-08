/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  classDir,
  loadClass,
  recommendThreshold,
  scoreHash,
  teachClass,
} from '../../src/contracts/screenshot-class';
import { phashFromHex } from '../../src/contracts/phash';
import { encodeRgbaPng, gradientRgba, checkerRgba, solidRgba } from './png-fixtures';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sshot-class-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePng(name: string, png: Buffer): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, png);
  return file;
}

describe('teachClass / loadClass round-trip', () => {
  test('rejects path-traversal class IDs at the boundary', () => {
    expect(() => classDir('../escape', tmpDir)).toThrow(/invalid class_id/);
    expect(() => classDir('foo/bar', tmpDir)).toThrow(/invalid class_id/);
    // The character class allows literal `.`, so the validator must
    // explicitly reject the dot-only segments that path.join() would
    // resolve to the registry root or its parent.
    expect(() => classDir('.', tmpDir)).toThrow(/invalid class_id/);
    expect(() => classDir('..', tmpDir)).toThrow(/invalid class_id/);
  });

  test('first teach creates dir, hash, and threshold.json with mode 0o600', async () => {
    const png = encodeRgbaPng(32, 32, gradientRgba(32, 32));
    const file = writePng('exemplar-1.png', png);
    const meta = await teachClass('checkout.success', file, tmpDir);
    expect(meta.exemplarCount).toBe(1);
    expect(meta.hashBits).toBe(64);

    const dir = classDir('checkout.success', tmpDir);
    const pngPath = path.join(dir, 'exemplars', '0000.png');
    const hashPath = path.join(dir, 'exemplars', '0000.hash');
    const thresholdPath = path.join(dir, 'threshold.json');
    expect(fs.existsSync(pngPath)).toBe(true);
    expect(fs.existsSync(hashPath)).toBe(true);
    const tjson = JSON.parse(fs.readFileSync(thresholdPath, 'utf8'));
    expect(tjson.hash_bits).toBe(64);
    expect(tjson.exemplar_count).toBe(1);
    expect(tjson.value).toBe(meta.threshold);

    // POSIX mode bits are not enforced on Windows, so guard the assertion.
    if (process.platform !== 'win32') {
      for (const p of [pngPath, hashPath, thresholdPath]) {
        const mode = fs.statSync(p).mode & 0o777;
        // Owner read/write only — group/other bits should be cleared.
        expect(mode & 0o077).toBe(0);
      }
    }
  });

  test('second teach increments index and recomputes threshold', async () => {
    const a = encodeRgbaPng(32, 32, gradientRgba(32, 32));
    const b = encodeRgbaPng(32, 32, checkerRgba(32, 32, 4));
    await teachClass('cls', writePng('a.png', a), tmpDir);
    const meta = await teachClass('cls', writePng('b.png', b), tmpDir);
    expect(meta.exemplarCount).toBe(2);

    const loaded = await loadClass('cls', tmpDir);
    expect(loaded.exemplars.map((e) => e.name).sort()).toEqual(['0000', '0001']);
  });

  test('teach fails loud on undecodable PNG without mutating registry', async () => {
    const garbage = Buffer.from('this is not a png at all');
    const file = writePng('garbage.png', garbage);
    await expect(teachClass('cls', file, tmpDir)).rejects.toThrow(/PNG/);
    // Class directory must NOT have been created.
    expect(fs.existsSync(classDir('cls', tmpDir))).toBe(false);
  });

  test('loadClass throws on missing class', async () => {
    await expect(loadClass('does-not-exist', tmpDir)).rejects.toThrow(/not found/);
  });

  test('scoreHash returns nearest exemplar and respects threshold', async () => {
    const png = encodeRgbaPng(32, 32, gradientRgba(32, 32));
    const file = writePng('a.png', png);
    await teachClass('cls', file, tmpDir);
    const loaded = await loadClass('cls', tmpDir);
    const exemplarHash = loaded.exemplars[0].hash;
    const exact = scoreHash(loaded, exemplarHash);
    expect(exact.distance).toBe(0);
    expect(exact.passed).toBe(true);

    // Hash with all bits flipped — distance 64.
    const flipped = exemplarHash ^ ((1n << 64n) - 1n);
    const far = scoreHash(loaded, flipped);
    expect(far.distance).toBe(64);
    expect(far.passed).toBe(false);
  });
});

describe('recommendThreshold', () => {
  test('returns conservative fallback when fewer than 2 exemplars', () => {
    expect(recommendThreshold([])).toBe(8);
    expect(recommendThreshold([phashFromHex('0'.repeat(16))])).toBe(8);
  });

  test('floors at 4 even when exemplars are extremely close', () => {
    const same = phashFromHex('1234567812345678');
    expect(recommendThreshold([same, same, same])).toBe(4);
  });

  test('caps at 16 even when exemplars are far apart', () => {
    const a = phashFromHex('0000000000000000');
    const b = phashFromHex('ffffffffffffffff');
    const c = phashFromHex('aaaaaaaaaaaaaaaa');
    expect(recommendThreshold([a, b, c])).toBe(16);
  });

  test('does not crash on solid-colour exemplars (which all hash to zero)', async () => {
    const a = encodeRgbaPng(32, 32, solidRgba(32, 32, [10, 20, 30, 255]));
    const b = encodeRgbaPng(32, 32, solidRgba(32, 32, [200, 100, 50, 255]));
    const fileA = writePng('a.png', a);
    const fileB = writePng('b.png', b);
    await teachClass('solid', fileA, tmpDir);
    const meta = await teachClass('solid', fileB, tmpDir);
    expect(meta.exemplarCount).toBe(2);
  });
});
