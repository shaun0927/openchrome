import {
  rankByTrust,
  registerDomainTrustRule,
  resetDomainTrustRulesForTests,
  scoreDomain,
} from '../../src/hints/domain-trust';

describe('domain trust (P21)', () => {
  beforeEach(() => resetDomainTrustRulesForTests());

  describe('scoreDomain — default rules', () => {
    test.each([
      ['https://en.wikipedia.org/wiki/X', 'primary-reference'],
      ['https://arxiv.org/abs/1234.5678', 'academic'],
      ['https://mit.edu/', 'academic'],
      ['https://kaist.ac.kr/', 'academic'],
      ['https://ox.ac.uk/', 'academic'],
      ['https://cdc.gov/', 'government'],
      ['https://mohw.go.kr/', 'government'],
      ['https://army.mil/', 'government'],
      ['https://mozilla.org/', 'organisation'],
      ['https://nytimes.com/a', 'news-established'],
      ['https://www.bbc.co.uk/', 'news-established'],
      ['https://medium.com/@x/y', 'aggregator'],
      ['https://foo.tistory.com/1', 'aggregator'],
      ['https://reddit.com/r/x', 'user-generated'],
      ['https://twitter.com/x', 'user-generated'],
    ])('%s → %s', (url, expected) => {
      expect(scoreDomain(url).category).toBe(expected);
    });

    test('www prefix is stripped', () => {
      const a = scoreDomain('https://wikipedia.org/x');
      const b = scoreDomain('https://www.wikipedia.org/x');
      expect(a.category).toBe(b.category);
      expect(a.score).toBe(b.score);
    });

    test('unknown domain returns 0.4 neutral', () => {
      const r = scoreDomain('https://example.com/');
      expect(r.category).toBe('unknown');
      expect(r.score).toBe(0.4);
    });

    test('malformed url returns 0 unknown', () => {
      const r = scoreDomain('not a url');
      expect(r.category).toBe('unknown');
      expect(r.score).toBe(0);
    });
  });

  describe('registerDomainTrustRule', () => {
    test('custom rules run before defaults', () => {
      registerDomainTrustRule({
        match: (h) => h === 'internal-wiki.corp',
        category: 'primary-reference',
        score: 0.95,
        rationale: 'internal wiki',
      });
      const r = scoreDomain('https://internal-wiki.corp/page');
      expect(r.score).toBe(0.95);
      expect(r.rationale).toBe('internal wiki');
    });

    test('validates score bounds', () => {
      expect(() =>
        registerDomainTrustRule({ match: () => true, category: 'unknown', score: 1.5, rationale: 'x' }),
      ).toThrow(RangeError);
      expect(() =>
        registerDomainTrustRule({ match: () => true, category: 'unknown', score: -0.1, rationale: 'x' }),
      ).toThrow(RangeError);
    });

    test('validates required fields', () => {
      expect(() =>
        registerDomainTrustRule({ match: 'not-a-fn', score: 0.5 } as any),
      ).toThrow(TypeError);
    });
  });

  describe('rankByTrust', () => {
    test('sorts by score desc, ties by input order', () => {
      const ranked = rankByTrust([
        'https://reddit.com/x',
        'https://mit.edu/',
        'https://arxiv.org/x',
        'https://example.com/',
      ]);
      expect(ranked.map((r) => r.url)).toEqual([
        'https://arxiv.org/x',
        'https://mit.edu/',
        'https://example.com/',
        'https://reddit.com/x',
      ]);
    });
  });
});
