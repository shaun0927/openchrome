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



  describe('action cache v2 page fingerprint keys', () => {
    const keyInput = {
      url: TEST_URL,
      instruction: TEST_INSTRUCTION,
      actionKinds: ['click'],
      viewport: { width: 1280, height: 720 },
      pageFingerprint: JSON.stringify({ title: 'Login', nodes: [{ role: 'button', name: 'Login', tag: 'button' }] }),
      optionFingerprint: 'verify=both',
      locale: 'en-US',
      userAgent: 'Chrome/120',
    };

    it('misses before record, hits after record, and includes bounded v2 metadata', () => {
      const cache = getCache();
      const keyParts = cache.buildActionCacheKeyV2Parts(keyInput)!;

      const miss = cache.getCachedSequenceV2(TEST_URL, TEST_INSTRUCTION, keyParts);
      expect(miss.status).toBe('MISS');
      expect(miss.keyVersion).toBe(2);

      const entry = cache.cacheSequenceV2(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS, keyParts)!;
      const hit = cache.getCachedSequenceV2(TEST_URL, TEST_INSTRUCTION, keyParts);

      expect(entry.version).toBe(2);
      expect(entry.keyParts.pageFingerprint).toHaveLength(24);
      expect(hit.status).toBe('HIT');
      expect(hit.keyVersion).toBe(2);
      expect(hit.actions).toEqual(TEST_ACTIONS);
      expect(JSON.stringify(entry)).not.toContain('<html');
    });

    it('reports stale instead of replaying when the page fingerprint changes', () => {
      const cache = getCache();
      const keyParts = cache.buildActionCacheKeyV2Parts(keyInput)!;
      cache.cacheSequenceV2(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS, keyParts);

      const drifted = cache.buildActionCacheKeyV2Parts({
        ...keyInput,
        pageFingerprint: JSON.stringify({ title: 'Login', nodes: [{ role: 'button', name: 'Cancel', tag: 'button' }] }),
      })!;
      const decision = cache.getCachedSequenceV2(TEST_URL, TEST_INSTRUCTION, drifted);

      expect(decision.status).toBe('STALE');
      expect(decision.reason).toBe('page_or_option_fingerprint_mismatch');
      expect(decision.actions).toBeUndefined();
    });

    it('keeps v1 entries readable as migration fallback when no v2 candidate exists', () => {
      const cache = getCache();
      cache.cacheSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS);
      cache.validateCachedSequence(TEST_URL, TEST_INSTRUCTION, true);

      const keyParts = cache.buildActionCacheKeyV2Parts(keyInput)!;
      const decision = cache.getCachedSequenceV2(TEST_URL, TEST_INSTRUCTION, keyParts, { allowLegacyFallback: true });

      expect(decision.status).toBe('HIT');
      expect(decision.keyVersion).toBe(1);
      expect(decision.reason).toBe('legacy_v1_fallback');
      expect(decision.actions).toEqual(TEST_ACTIONS);
    });

    it('changes the key for viewport and option drift', () => {
      const cache = getCache();
      const base = cache.buildActionCacheKeyV2Parts(keyInput)!;
      const changedViewport = cache.buildActionCacheKeyV2Parts({ ...keyInput, viewport: { width: 800, height: 600 } })!;
      const changedOptions = cache.buildActionCacheKeyV2Parts({ ...keyInput, optionFingerprint: 'verify=none' })!;

      expect(cache.getActionCacheKeyV2Hash(changedViewport)).not.toBe(cache.getActionCacheKeyV2Hash(base));
      expect(cache.getActionCacheKeyV2Hash(changedOptions)).not.toBe(cache.getActionCacheKeyV2Hash(base));
    });
  });

  describe('guarded workflow cache', () => {
    const signature = {
      titleHash: 'title-a',
      actionLabelsHash: 'labels-a',
      actionRolesHash: 'roles-a',
      formShapeHash: 'forms-a',
    };

    it('records and accepts a matching safe workflow only when requested by caller', () => {
      const cache = getCache();
      const entry = cache.cacheWorkflowSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS, signature);

      expect(entry).not.toBeNull();
      const decision = cache.getWorkflowCachedSequence(TEST_URL, TEST_INSTRUCTION, signature);

      expect(decision.decision).toBe('accepted');
      expect(decision.actions).toEqual(TEST_ACTIONS);
      expect(decision.similarity).toBe(1);
    });

    it('rejects workflow replay when the page signature changes', () => {
      const cache = getCache();
      cache.cacheWorkflowSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS, signature);

      const decision = cache.getWorkflowCachedSequence(TEST_URL, TEST_INSTRUCTION, {
        ...signature,
        actionLabelsHash: 'labels-b',
        actionRolesHash: 'roles-b',
      });

      expect(decision.decision).toBe('rejected');
      expect(decision.reason).toBe('page_signature_mismatch');
    });

    it('blocks destructive-looking workflows by default', () => {
      const cache = getCache();
      const riskyActions: ParsedAction[] = [{ action: 'click', target: 'delete account' }];
      cache.cacheWorkflowSequence(TEST_URL, 'click delete account', riskyActions, signature);

      const blocked = cache.getWorkflowCachedSequence(TEST_URL, 'click delete account', signature);
      const allowed = cache.getWorkflowCachedSequence(TEST_URL, 'click delete account', signature, { allowRiskyReplay: true });

      expect(blocked.decision).toBe('rejected');
      expect(blocked.reason).toBe('safety_policy_blocked');
      expect(blocked.safety?.destructiveRisk).toBe('possible');
      expect(allowed.decision).toBe('accepted');
    });

    it('does not store secret-looking text values as replay literals', () => {
      const cache = getCache();
      const secretActions: ParsedAction[] = [
        { action: 'type', target: 'password', value: 'hunter2-fixture-value' },
      ];
      const entry = cache.cacheWorkflowSequence(TEST_URL, 'type hunter2-fixture-value in password', secretActions, signature);

      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain('hunter2-fixture-value');
      expect(entry!.steps[0]).toMatchObject({ valueKind: 'variable' });
      expect(entry!.steps[0]).not.toHaveProperty('value');
      expect(entry!.safety.replayAllowed).toBe(false);
    });

    it('records failed replay reasons and reports confidence decrement', () => {
      const cache = getCache();
      cache.cacheWorkflowSequence(TEST_URL, TEST_INSTRUCTION, TEST_ACTIONS, signature);

      const decision = cache.validateWorkflowCachedSequence(TEST_URL, TEST_INSTRUCTION, false, 'ELEMENT_NOT_FOUND');
      const lookup = cache.getWorkflowCachedSequence(TEST_URL, TEST_INSTRUCTION, signature);

      expect(decision.cacheAction).toBe('decrement_confidence');
      expect(decision.entry?.stats.lastFailureReason).toBe('ELEMENT_NOT_FOUND');
      expect(lookup.decision).toBe('rejected');
      expect(lookup.reason).toBe('confidence_below_threshold');
    });
  });
});
