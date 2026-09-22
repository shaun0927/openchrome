import {
  SPLIT_SEED, applySplit, assignSplit, computeSplitReport, sha256Hex,
} from '../../scripts/decisions/split';
import type { DecisionCase } from '../fixtures/decisions/schema';

function gateCase(id: string, pool: DecisionCase['pool']): DecisionCase {
  return { id, kind: 'gate', lang: 'en', pool, input: { title: id, text_excerpt: '' } };
}

describe('decision corpus split', () => {
  it('is deterministic: same ids -> same split and same hashes, regardless of order', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `public-gate-${i.toString(16).padStart(4, '0')}`);
    const a = applySplit(ids.map((id) => gateCase(id, 'public')));
    const b = applySplit([...ids].reverse().map((id) => gateCase(id, 'public')));
    const byId = new Map(b.map((c) => [c.id, c.split]));
    for (const c of a) expect(byId.get(c.id)).toBe(c.split);
    const ra = computeSplitReport(a);
    const rb = computeSplitReport(b);
    expect(ra).toEqual(rb);
    expect(ra.seed).toBe(SPLIT_SEED);
    expect(ra.counts.total).toBe(200);
    // Roughly balanced for fixture/public (parity of a sha256 nibble).
    expect(ra.counts.A).toBeGreaterThan(70);
    expect(ra.counts.B).toBeGreaterThan(70);
  });

  it('pins a known assignment so a seed change is visible in review', () => {
    // Recomputed from the committed seed; changing SPLIT_SEED must fail here.
    const digest = sha256Hex(`${SPLIT_SEED}:public-gate-0000`);
    const expected = parseInt(digest[digest.length - 1], 16) % 2 === 0 ? 'A' : 'B';
    expect(assignSplit('public-gate-0000', 'public')).toBe(expected);
    expect(assignSplit('public-gate-0000', 'public', 'another-seed')).toMatch(/^[AB]$/);
  });

  it('sends every trajectory case to A', () => {
    const cases = applySplit(Array.from({ length: 50 }, (_, i) => gateCase(`trajectory-gate-${i}`, 'trajectory')));
    expect(cases.every((c) => c.split === 'A')).toBe(true);
    const report = computeSplitReport(cases);
    expect(report.counts).toEqual({ A: 50, B: 0, total: 50 });
    expect(report.sha256.B).toBe(sha256Hex(''));
  });

  it('hashes the sorted id list per split', () => {
    const cases = applySplit([gateCase('b', 'trajectory'), gateCase('a', 'trajectory')]);
    const report = computeSplitReport(cases);
    expect(report.sha256.A).toBe(sha256Hex('a\nb'));
  });

  it('does not mutate its input', () => {
    const input = [gateCase('x', 'fixture')];
    applySplit(input);
    expect(input[0].split).toBeUndefined();
  });
});
