/// <reference types="jest" />
/**
 * Resolution-rules tests for tool category selection (#847).
 *
 * Pins the four rules from src/tools/_shared/category.ts::resolveEnabledCategories:
 *   1. slim → SLIM_CATEGORIES + always-on
 *   2. enabled subset → only those + always-on
 *   3. disabled → those subtracted (but always-on still wins)
 *   4. ALWAYS_ON_CATEGORIES (reliability + observe) is unconditional
 *
 * The order check matters: the resolver re-emits in canonical order so
 * snapshot consumers (the disabled-tools resource, the registration snapshot
 * test) get a stable serialization regardless of input order.
 */

import {
  ALL_CATEGORIES,
  ALWAYS_ON_CATEGORIES,
  parseCategoryCsv,
  resolveEnabledCategories,
  SLIM_CATEGORIES,
  ToolCategory,
} from '../../src/tools/_shared/category';

describe('resolveEnabledCategories', () => {
  test('default selection (no flags) returns the full canonical set', () => {
    const result = resolveEnabledCategories();
    expect(Array.from(result)).toEqual(Array.from(ALL_CATEGORIES));
  });

  test('default selection (empty object) returns the full canonical set', () => {
    const result = resolveEnabledCategories({});
    expect(Array.from(result)).toEqual(Array.from(ALL_CATEGORIES));
  });

  describe('rule 1: slim mode', () => {
    test('slim → SLIM_CATEGORIES + always-on, in canonical order', () => {
      const result = Array.from(resolveEnabledCategories({ slim: true }));
      // Every slim category must be present.
      for (const cat of SLIM_CATEGORIES) {
        expect(result).toContain(cat);
      }
      // Every always-on category must be present.
      for (const cat of ALWAYS_ON_CATEGORIES) {
        expect(result).toContain(cat);
      }
      // Nothing else should leak in.
      const expected = new Set<ToolCategory>([
        ...SLIM_CATEGORIES,
        ...ALWAYS_ON_CATEGORIES,
      ]);
      expect(result.length).toBe(expected.size);
    });

    test('slim wins over enabled when both supplied', () => {
      const result = Array.from(
        resolveEnabledCategories({
          slim: true,
          enabled: ['vision', 'crawl'],
        }),
      );
      // vision/crawl must NOT appear — slim path is taken.
      expect(result).not.toContain('vision');
      expect(result).not.toContain('crawl');
      // navigation/interact/inspect (slim) MUST appear.
      expect(result).toContain('navigation');
      expect(result).toContain('interact');
      expect(result).toContain('inspect');
    });

    test('emitted order matches ALL_CATEGORIES ordering', () => {
      const result = Array.from(resolveEnabledCategories({ slim: true }));
      const indexes = result.map((cat) => ALL_CATEGORIES.indexOf(cat));
      const sorted = [...indexes].sort((a, b) => a - b);
      expect(indexes).toEqual(sorted);
    });
  });

  describe('rule 2: enable subset', () => {
    test('enabled subset → only those + always-on', () => {
      const result = Array.from(
        resolveEnabledCategories({ enabled: ['vision', 'crawl'] }),
      );
      const expected = new Set<ToolCategory>([
        'vision',
        'crawl',
        ...ALWAYS_ON_CATEGORIES,
      ]);
      expect(new Set(result)).toEqual(expected);
    });

    test('enabled = [] is treated as default (full set)', () => {
      const result = resolveEnabledCategories({ enabled: [] });
      expect(Array.from(result)).toEqual(Array.from(ALL_CATEGORIES));
    });
  });

  describe('rule 3: disable subtracts', () => {
    test('disabled removes specified categories from the full set', () => {
      const result = resolveEnabledCategories({
        disabled: ['vision', 'crawl', 'memory'],
      });
      expect(result.has('vision')).toBe(false);
      expect(result.has('crawl')).toBe(false);
      expect(result.has('memory')).toBe(false);
      // Sibling categories remain.
      expect(result.has('navigation')).toBe(true);
      expect(result.has('tabs')).toBe(true);
    });

    test('disabled is applied AFTER enabled', () => {
      const result = resolveEnabledCategories({
        enabled: ['vision', 'crawl', 'memory'],
        disabled: ['memory'],
      });
      expect(result.has('vision')).toBe(true);
      expect(result.has('crawl')).toBe(true);
      expect(result.has('memory')).toBe(false);
    });
  });

  describe('rule 4: always-on cannot be disabled', () => {
    test('reliability + observe survive an explicit --disable-categories', () => {
      const result = resolveEnabledCategories({
        disabled: ['reliability', 'observe'],
      });
      for (const cat of ALWAYS_ON_CATEGORIES) {
        expect(result.has(cat)).toBe(true);
      }
    });

    test('reliability + observe survive an --enable-categories that omits them', () => {
      const result = resolveEnabledCategories({
        enabled: ['vision'],
      });
      for (const cat of ALWAYS_ON_CATEGORIES) {
        expect(result.has(cat)).toBe(true);
      }
    });

    test('reliability + observe survive --slim + --disable-categories combo', () => {
      const result = resolveEnabledCategories({
        slim: true,
        disabled: ['reliability', 'observe', 'navigation'],
      });
      // Always-on wins.
      expect(result.has('reliability')).toBe(true);
      expect(result.has('observe')).toBe(true);
      // Slim minus navigation is honored.
      expect(result.has('navigation')).toBe(false);
      expect(result.has('interact')).toBe(true);
      expect(result.has('inspect')).toBe(true);
    });
  });
});

describe('parseCategoryCsv', () => {
  test('parses well-formed csv', () => {
    expect(parseCategoryCsv('vision,crawl,memory', 'test')).toEqual([
      'vision',
      'crawl',
      'memory',
    ]);
  });

  test('trims whitespace and skips empty segments', () => {
    expect(parseCategoryCsv(' vision , , crawl ', 'test')).toEqual([
      'vision',
      'crawl',
    ]);
  });

  test('deduplicates while preserving first-seen order', () => {
    expect(parseCategoryCsv('vision,crawl,vision', 'test')).toEqual([
      'vision',
      'crawl',
    ]);
  });

  test('throws with the source label on unknown category', () => {
    expect(() => parseCategoryCsv('vision,bogus', '--enable-categories')).toThrow(
      /\[--enable-categories\] Unknown tool category "bogus"/,
    );
  });

  test('returns [] for empty input', () => {
    expect(parseCategoryCsv('', 'test')).toEqual([]);
    expect(parseCategoryCsv('  ', 'test')).toEqual([]);
  });
});
