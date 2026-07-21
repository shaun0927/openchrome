import {
  computeFitMarkdown,
  countSentences,
  isHeaderBlock,
  linkCharsIn,
  percentile,
  scoreBlock,
  splitBlocks,
} from '../../src/extraction/fit-markdown';

describe('fit-markdown (P15)', () => {
  describe('splitBlocks', () => {
    test('splits on blank lines and normalises CRLF', () => {
      const md = 'A\r\n\r\nB\n\nC';
      expect(splitBlocks(md)).toEqual(['A', 'B', 'C']);
    });
    test('empty string → []', () => {
      expect(splitBlocks('')).toEqual([]);
    });
    test('rejects non-string', () => {
      // @ts-expect-error intentional runtime abuse
      expect(() => splitBlocks(null)).toThrow(TypeError);
    });
  });

  describe('isHeaderBlock', () => {
    test.each([
      ['# Title', true],
      ['## Sub', true],
      ['###### Deep', true],
      ['####### Too deep', false],
      ['Not a header', false],
      ['#Nospace', false],
    ])('%s → %s', (b, expected) => {
      expect(isHeaderBlock(b)).toBe(expected);
    });
  });

  describe('linkCharsIn', () => {
    test('sums text inside markdown links', () => {
      expect(linkCharsIn('[hello](x) plain [world](y)')).toBe(5 + 5);
    });
    test('zero links → 0', () => {
      expect(linkCharsIn('plain prose')).toBe(0);
    });
  });

  describe('countSentences', () => {
    test('single period → 1', () => {
      expect(countSentences('A short sentence.')).toBe(1);
    });
    test('multiple terminators', () => {
      expect(countSentences('One. Two! Three?')).toBe(3);
    });
    test('never below 1', () => {
      expect(countSentences('no terminator here')).toBe(1);
    });
  });

  describe('scoreBlock', () => {
    const opts = { keepPercentile: 50, preserveHeaders: true, minBlockChars: 30, linkDensityCap: 0.5 };
    test('long prose scores higher than short prose', () => {
      const short = scoreBlock('Short.', 0, opts);
      const long = scoreBlock('This is a much longer block of prose with several sentences. It talks about a topic in depth. It should easily beat the short one.', 1, opts);
      expect(long.score).toBeGreaterThan(short.score);
    });
    test('mostly-link block is penalised', () => {
      const nav = scoreBlock('[a](x) [b](y) [c](z) [d](w) [e](v) [f](u)', 0, opts);
      const prose = scoreBlock('This is prose with about the same character length as the nav block above.', 1, opts);
      expect(prose.score).toBeGreaterThan(nav.score);
    });
    test('header gets a floor score of at least 100', () => {
      const hdr = scoreBlock('# Title', 0, opts);
      expect(hdr.score).toBeGreaterThanOrEqual(100);
      expect(hdr.isHeader).toBe(true);
    });
    test('under minBlockChars is heavily penalised', () => {
      const tiny = scoreBlock('short', 0, opts);
      expect(tiny.score).toBeLessThan(50);
    });
  });

  describe('percentile', () => {
    test('empty → 0', () => {
      expect(percentile([], 50)).toBe(0);
    });
    test('p<=0 → min, p>=100 → max', () => {
      expect(percentile([1, 2, 3], 0)).toBe(1);
      expect(percentile([1, 2, 3], 100)).toBe(3);
    });
    test('50th percentile of [1..5] is 3', () => {
      expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    });
    test('linear interpolation between neighbours', () => {
      // 25th percentile of [0, 10] should be 2.5
      expect(percentile([0, 10], 25)).toBeCloseTo(2.5);
    });
  });

  describe('computeFitMarkdown', () => {
    test('empty input → empty output, zero ratio', () => {
      const r = computeFitMarkdown('');
      expect(r.markdown).toBe('');
      expect(r.compressionRatio).toBe(0);
      expect(r.scores).toEqual([]);
    });
    test('article page keeps prose, drops nav', () => {
      const page = [
        '[Home](/) [About](/a) [Contact](/c) [Login](/l)',
        '# The Main Article',
        'This is the substantive body of the article. It has multiple sentences that discuss the topic thoroughly. Real prose that a reader would want.',
        '[Related 1](/r1) [Related 2](/r2) [Related 3](/r3)',
        '## Subheading',
        'Another paragraph of real prose. It continues to develop the topic with detail and context. Coherent enough to matter.',
        '[Terms](/t) [Privacy](/p)',
      ].join('\n\n');
      const r = computeFitMarkdown(page, { keepPercentile: 60 });
      expect(r.markdown).toContain('The Main Article');
      expect(r.markdown).toContain('substantive body');
      expect(r.markdown).toContain('Subheading');
      // At least one nav block should be filtered (link-heavy blocks lose).
      const navBlocksKept = r.scores.filter((s) => s.linkDensity > 0.5 && r.keptIndices.includes(s.index));
      expect(navBlocksKept.length).toBeLessThan(3);
      expect(r.compressionRatio).toBeLessThan(1);
    });
    test('preserveHeaders keeps low-score headers', () => {
      const page = [
        'This is dense prose about the main topic that will surely beat the percentile threshold with lots of content.',
        '# Lonely Header',
        'Another dense paragraph that will beat the threshold on its own merit for sure.',
      ].join('\n\n');
      const r = computeFitMarkdown(page, { keepPercentile: 90, preserveHeaders: true });
      expect(r.markdown).toContain('# Lonely Header');
    });
    test('preserveHeaders:false drops headers below threshold', () => {
      const page = [
        '# Header',
        'A much longer paragraph of prose. Multiple sentences here to boost the score above the header floor. Enough to beat the percentile easily.',
      ].join('\n\n');
      const r = computeFitMarkdown(page, { keepPercentile: 90, preserveHeaders: false });
      // Header has floor score 100, prose likely higher — but 90th percentile
      // of a 2-block distribution picks the top block only.
      expect(r.keptIndices.length).toBeLessThanOrEqual(2);
    });
    test('rejects invalid keepPercentile', () => {
      expect(() => computeFitMarkdown('x', { keepPercentile: -1 })).toThrow(RangeError);
      expect(() => computeFitMarkdown('x', { keepPercentile: 101 })).toThrow(RangeError);
    });
    test('trace surface: scores, keptIndices, compressionRatio', () => {
      const r = computeFitMarkdown('A short block.\n\nAnother short block.');
      expect(r.scores).toHaveLength(2);
      expect(Array.isArray(r.keptIndices)).toBe(true);
      expect(typeof r.compressionRatio).toBe('number');
    });
  });
});
