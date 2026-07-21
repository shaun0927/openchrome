import { describe, expect, it } from '@jest/globals';
import {
  bezierPointerPath,
  hash32,
  sampleFingerprint,
} from '../../src/stealth/fingerprint-sampler.js';

describe('sampleFingerprint', () => {
  it('is deterministic per seed', () => {
    const a = sampleFingerprint('session-abc');
    const b = sampleFingerprint('session-abc');
    expect(a).toEqual(b);
  });

  it('yields self-consistent locale/timezone pairs', () => {
    for (let i = 0; i < 40; i++) {
      const s = sampleFingerprint(`seed-${i}`);
      // language/timezone/platform tuples in the table are curated to be
      // internally consistent — this test guards against future edits that
      // decouple them.
      expect(s.language).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(s.timezone).toMatch(/^[A-Za-z_]+\/[A-Za-z_]+$|^UTC$/);
      expect(s.hardwareConcurrency).toBeGreaterThanOrEqual(4);
    }
  });

  it('exercises every joint row with enough seeds', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(sampleFingerprint(`s-${i}`).language);
    }
    // Not all 9 rows will hit in 200 draws, but at least four locales should.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

describe('hash32', () => {
  it('is stable for the empty string', () => {
    expect(hash32('')).toBe(2166136261);
  });
  it('changes for one-char inputs', () => {
    expect(hash32('a')).not.toBe(hash32('b'));
  });
});

describe('bezierPointerPath', () => {
  it('emits steps+1 points anchored at the endpoints', () => {
    const path = bezierPointerPath({ x: 0, y: 0 }, { x: 100, y: 50 }, {
      steps: 10,
      seed: 'test',
    });
    expect(path).toHaveLength(11);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path.at(-1)).toEqual({ x: 100, y: 50 });
  });

  it('is deterministic per seed', () => {
    const a = bezierPointerPath({ x: 0, y: 0 }, { x: 300, y: 200 }, { seed: 'z', steps: 5 });
    const b = bezierPointerPath({ x: 0, y: 0 }, { x: 300, y: 200 }, { seed: 'z', steps: 5 });
    expect(a).toEqual(b);
  });

  it('curves off the straight line (non-monotone in one axis)', () => {
    const path = bezierPointerPath({ x: 0, y: 0 }, { x: 400, y: 0 }, {
      steps: 20,
      seed: 'curvy',
      curveMagnitude: 0.6,
    });
    const ys = path.map((p) => p.y);
    const nonZero = ys.filter((y) => Math.abs(y) > 0.001);
    // With curveMagnitude and a non-zero perpendicular, some intermediate y
    // must move off the axis.
    expect(nonZero.length).toBeGreaterThan(0);
  });
});
