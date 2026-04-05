/// <reference types="jest" />
/**
 * Tests for Action Cache
 */

import { getCachedSequence, cacheSequence, validateCachedSequence, CachedSequence } from '../../src/actions/action-cache';
import { ParsedAction } from '../../src/actions/action-parser';
import { DomainMemory } from '../../src/memory/domain-memory';

// ─── Mock domain-memory module ───

jest.mock('../../src/memory/domain-memory', () => {
  // Build a real in-memory DomainMemory instance for tests
  const { DomainMemory } = jest.requireActual('../../src/memory/domain-memory');
  let instance: InstanceType<typeof DomainMemory> | null = null;

  return {
    DomainMemory,
    extractDomainFromUrl: (url: string) => {
      try { return new URL(url).hostname; } catch { return ''; }
    },
    getDomainMemory: () => {
      if (!instance) {
        instance = new DomainMemory();
      }
      return instance;
    },
  };
});

// Reset the in-memory store between tests by re-requiring with a fresh instance
beforeEach(() => {
  jest.resetModules();
  jest.mock('../../src/memory/domain-memory', () => {
    const { DomainMemory } = jest.requireActual('../../src/memory/domain-memory');
    const instance = new DomainMemory();
    return {
      DomainMemory,
      extractDomainFromUrl: (url: string) => {
        try { return new URL(url).hostname; } catch { return ''; }
      },
      getDomainMemory: () => instance,
    };
  });
});

// Helper to re-import cache module with fresh mock after resetModules
function getCache() {
  return require('../../src/actions/action-cache') as typeof import('../../src/actions/action-cache');
}

const TEST_URL = 'https://example.com/page';
const TEST_INSTRUCTION = 'click the login button';
const TEST_ACTIONS: ParsedAction[] = [
  { action: 'click', target: 'login button' },
];

describe('action-cache', () => {
  // -------------------------------------------------------------------------
  // cacheSequence + getCachedSequence round-trip
  // -------------------------------------------------------------------------
  describe('cacheSequence and getCachedSequence', () => {
    it('returns null for a cache miss', () => {
      const cache = getCache();
      const result = cache.getCachedSequence(TEST_URL, TEST_INSTRUCTION);
      expect(result).toBeNull();
    });

    it('stores and retrieves a sequence', () => {
      const cache = getCache();
      cache.cacheSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS);

      // Initial confidence is 0.5 which is below MIN_CONFIDENCE (0.6),
      // so we need to boost it first via validateCachedSequence
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);

      const result = cache.getCachedSequence(TEST_URL, TEST_INSTRUCTION);
      expect(result).not.toBeNull();
      expect(result!.instruction).toBe(TEST_INSTRUCTION);
      expect(result!.actions).toEqual(TEST_ACTIONS);
      expect(typeof result!.cachedAt).toBe('number');
    });

    it('is null until confidence reaches MIN_CONFIDENCE (0.6)', () => {
      const cache = getCache();
      cache.cacheSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS);

      // Default confidence is 0.5, just below 0.6 threshold
      expect(cache.getCachedSequence(TEST_URL, TEST_INSTRUCTION)).toBeNull();

      // One success boost: 0.5 + 0.1 = 0.6
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);
      expect(cache.getCachedSequence(TEST_URL, TEST_INSTRUCTION)).not.toBeNull();
    });

    it('returns null for a different domain', () => {
      const cache = getCache();
      cache.cacheSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS);
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);

      const result = cache.getCachedSequence('https://other.com/page', TEST_INSTRUCTION);
      expect(result).toBeNull();
    });

    it('returns null for invalid URL', () => {
      const cache = getCache();
      const result = cache.getCachedSequence('not-a-url', TEST_INSTRUCTION);
      expect(result).toBeNull();
    });

    it('does not cache for invalid URL', () => {
      const cache = getCache();
      // Should not throw
      expect(() => cache.cacheSequence('not-a-url', TEST_INSTRUCTION, TEST_ACTIONS)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // validateCachedSequence — confidence adjustments
  // -------------------------------------------------------------------------
  describe('validateCachedSequence', () => {
    it('increases confidence on success', () => {
      const cache = getCache();
      const { getDomainMemory, extractDomainFromUrl } = require('../../src/memory/domain-memory');
      cache.cacheSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS);

      const domain = extractDomainFromUrl(TEST_URL);
      const memory: DomainMemory = getDomainMemory();
      const before = memory.query(domain)[0]?.confidence ?? 0;

      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);

      const after = memory.query(domain)[0]?.confidence ?? 0;
      expect(after).toBeGreaterThan(before);
    });

    it('decreases confidence on failure', () => {
      const cache = getCache();
      const { getDomainMemory, extractDomainFromUrl } = require('../../src/memory/domain-memory');
      cache.cacheSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS);

      const domain = extractDomainFromUrl(TEST_URL);
      const memory: DomainMemory = getDomainMemory();
      const before = memory.query(domain)[0]?.confidence ?? 0;

      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, false);

      const after = memory.query(domain)[0]?.confidence ?? 0;
      expect(after).toBeLessThan(before);
    });

    it('low-confidence entries are not returned', () => {
      const cache = getCache();
      cache.cacheSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS);

      // Boost to above threshold, then penalize below it
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);
      // Now confidence is ~0.7; fail twice to drop below 0.6
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, false);
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, false);

      expect(cache.getCachedSequence(TEST_URL, TEST_INSTRUCTION)).toBeNull();
    });

    it('does not throw when entry does not exist', () => {
      const cache = getCache();
      expect(() => cache.validateCachedSequence(TEST_URL, 'nonexistent instruction', true)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Normalization — whitespace collapse
  // -------------------------------------------------------------------------
  describe('cache key normalization', () => {
    it('treats instructions with extra whitespace as the same key', () => {
      const cache = getCache();
      cache.cacheSequence(TEST_URL, '  click   the  login button  ', TEST_ACTIONS);
      // Boost confidence so lookup works
      cache.validateCachedSequence(TEST_URL, '  click   the  login button  ', true);
      cache.validateCachedSequence(TEST_URL, '  click   the  login button  ', true);

      // Look up with normalised version
      const result = cache.getCachedSequence(TEST_URL, 'click the login button');
      expect(result).not.toBeNull();
    });

    it('treats instructions with different case as the same key', () => {
      const cache = getCache();
      cache.cacheSequence(TEST_URL, 'CLICK THE LOGIN BUTTON', TEST_ACTIONS);
      cache.validateCachedSequence(TEST_URL, 'CLICK THE LOGIN BUTTON', true);
      cache.validateCachedSequence(TEST_URL, 'CLICK THE LOGIN BUTTON', true);

      const result = cache.getCachedSequence(TEST_URL, 'click the login button');
      expect(result).not.toBeNull();
    });
  });
});
