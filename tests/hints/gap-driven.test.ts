import { gapAnalyse, nextActionHint, type Requirement, type EvidenceItem } from '../../src/hints/gap-driven';

describe('gap-driven hints (P21)', () => {
  const reqs: Requirement[] = [
    { label: 'company revenue 2025', keywords: ['revenue', '2025'], weight: 0.9 },
    { label: 'company headcount', keywords: ['headcount', 'employees'], weight: 0.6 },
    { label: 'founding date', keywords: ['founded', 'founding'], weight: 0.3 },
  ];

  describe('gapAnalyse', () => {
    test('empty evidence → everything is a gap sorted by weight', () => {
      const r = gapAnalyse(reqs, []);
      expect(r.covered).toEqual([]);
      expect(r.gaps.map((g) => g.label)).toEqual([
        'company revenue 2025',
        'company headcount',
        'founding date',
      ]);
    });

    test('single keyword overlap satisfies default minOverlap=1', () => {
      const evidence: EvidenceItem[] = [
        { source: 'a', keywords: ['revenue', '2025', 'growth'] },
      ];
      const r = gapAnalyse(reqs, evidence);
      expect(r.covered).toContain('company revenue 2025');
      expect(r.gaps.map((g) => g.label)).not.toContain('company revenue 2025');
    });

    test('minOverlap=2 requires two keyword hits', () => {
      const evidence: EvidenceItem[] = [
        { source: 'a', keywords: ['revenue'] }, // 1 hit only
      ];
      const r = gapAnalyse(reqs, evidence, { minOverlap: 2 });
      expect(r.gaps.map((g) => g.label)).toContain('company revenue 2025');
      const g = r.gaps.find((x) => x.label === 'company revenue 2025')!;
      expect(g.partialHits).toBe(1);
    });

    test('case and whitespace tolerant', () => {
      const evidence: EvidenceItem[] = [
        { source: 'a', keywords: ['  REVENUE  ', '2025'] },
      ];
      const r = gapAnalyse(reqs, evidence);
      expect(r.covered).toContain('company revenue 2025');
    });

    test('gaps sorted by weight desc', () => {
      const evidence: EvidenceItem[] = [
        { source: 'a', keywords: ['revenue', '2025'] }, // covers highest-weight
      ];
      const r = gapAnalyse(reqs, evidence);
      expect(r.gaps[0].label).toBe('company headcount'); // 0.6 > 0.3
    });

    test('requirement with no keywords is skipped', () => {
      const r = gapAnalyse([{ label: 'x', keywords: [] }], []);
      expect(r.covered).toEqual([]);
      expect(r.gaps).toEqual([]);
    });

    test('rejects minOverlap < 1', () => {
      expect(() => gapAnalyse(reqs, [], { minOverlap: 0 })).toThrow(RangeError);
    });
  });

  describe('nextActionHint', () => {
    test('null when there are no gaps', () => {
      expect(nextActionHint({ covered: ['x'], gaps: [] })).toBeNull();
    });

    test('default template includes top gap label and up to 3 keywords', () => {
      const gaps = [{ label: 'company revenue 2025', weight: 0.9, keywords: ['revenue', '2025', 'growth', 'q4'], partialHits: 0 }];
      const hint = nextActionHint({ covered: [], gaps })!;
      expect(hint).toContain('company revenue 2025');
      expect(hint).toContain('"revenue"');
      expect(hint).toContain('"2025"');
      expect(hint).toContain('"growth"');
      expect(hint).not.toContain('"q4"');
    });

    test('per-label template wins', () => {
      const gaps = [{ label: 'x', weight: 0.9, keywords: ['a'], partialHits: 0 }];
      const hint = nextActionHint({ covered: [], gaps }, { templates: { x: 'go fetch x' } });
      expect(hint).toBe('go fetch x');
    });

    test('maxChars truncates with ellipsis', () => {
      const gaps = [{ label: 'x', weight: 0.9, keywords: ['a'], partialHits: 0 }];
      const long = 'a'.repeat(500);
      const hint = nextActionHint({ covered: [], gaps }, { templates: { x: long }, maxChars: 50 })!;
      expect(hint.length).toBe(50);
      expect(hint.endsWith('…')).toBe(true);
    });
  });
});
