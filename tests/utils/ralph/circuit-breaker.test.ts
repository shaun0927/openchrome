/// <reference types="jest" />
/**
 * Unit tests for 3-Level Circuit Breaker
 */

import { CircuitBreaker, hashQuery } from '../../../src/utils/ralph/circuit-breaker';

describe('Circuit Breaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      elementThreshold: 3,
      elementResetMs: 200,   // short for testing
      pageThreshold: 3,
      pageResetMs: 150,
      globalThreshold: 5,
      globalWindowMs: 1000,
      globalResetMs: 200,
    });
  });

  describe('Element Level', () => {
    test('should start CLOSED', () => {
      const status = breaker.checkElement('tab1', 'q1');
      expect(status.state).toBe('CLOSED');
      expect(status.failures).toBe(0);
    });

    test('should remain CLOSED below threshold', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      const status = breaker.checkElement('tab1', 'q1');
      expect(status.state).toBe('CLOSED');
      expect(status.failures).toBe(2);
    });

    test('should OPEN at threshold', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      const status = breaker.checkElement('tab1', 'q1');
      expect(status.state).toBe('OPEN');
      expect(status.suggestion).toContain('failed');
    });

    test('should auto-reset to HALF_OPEN after cooldown', async () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      expect(breaker.checkElement('tab1', 'q1').state).toBe('OPEN');

      await new Promise(r => setTimeout(r, 250));
      const status = breaker.checkElement('tab1', 'q1');
      expect(status.state).toBe('HALF_OPEN');
    });

    test('should reset to CLOSED on success', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      expect(breaker.checkElement('tab1', 'q1').state).toBe('OPEN');

      breaker.recordElementSuccess('tab1', 'q1');
      expect(breaker.checkElement('tab1', 'q1').state).toBe('CLOSED');
      expect(breaker.checkElement('tab1', 'q1').failures).toBe(0);
    });

    test('should track different elements independently', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q2');

      expect(breaker.checkElement('tab1', 'q1').state).toBe('OPEN');
      expect(breaker.checkElement('tab1', 'q2').state).toBe('CLOSED');
    });

    test('should track different tabs independently', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');

      expect(breaker.checkElement('tab1', 'q1').state).toBe('OPEN');
      expect(breaker.checkElement('tab2', 'q1').state).toBe('CLOSED');
    });
  });

  describe('Page Level', () => {
    test('should start CLOSED', () => {
      const status = breaker.checkPage('tab1');
      expect(status.state).toBe('CLOSED');
    });

    test('should OPEN when enough distinct elements fail', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q2');
      breaker.recordElementFailure('tab1', 'q3');

      const status = breaker.checkPage('tab1');
      expect(status.state).toBe('OPEN');
      expect(status.suggestion).toContain('elements failed');
    });

    test('should not count same element twice', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');

      // Only 1 distinct element, threshold is 3
      const status = breaker.checkPage('tab1');
      expect(status.state).toBe('CLOSED');
    });

    test('should auto-reset after cooldown', async () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q2');
      breaker.recordElementFailure('tab1', 'q3');
      expect(breaker.checkPage('tab1').state).toBe('OPEN');

      await new Promise(r => setTimeout(r, 200));
      expect(breaker.checkPage('tab1').state).toBe('HALF_OPEN');
    });

    test('should reset on resetPage()', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q2');
      breaker.recordElementFailure('tab1', 'q3');

      breaker.resetPage('tab1');
      expect(breaker.checkPage('tab1').state).toBe('CLOSED');
      expect(breaker.checkElement('tab1', 'q1').state).toBe('CLOSED');
    });
  });

  describe('Global Level', () => {
    test('should start CLOSED', () => {
      expect(breaker.checkGlobal().state).toBe('CLOSED');
    });

    test('should OPEN when threshold reached in window', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordElementFailure('tab1', `q${i}`);
      }
      expect(breaker.checkGlobal().state).toBe('OPEN');
      expect(breaker.checkGlobal().suggestion).toContain('paused');
    });

    test('should auto-reset to HALF_OPEN after cooldown', async () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordElementFailure('tab1', `q${i}`);
      }
      expect(breaker.checkGlobal().state).toBe('OPEN');

      await new Promise(r => setTimeout(r, 250));
      expect(breaker.checkGlobal().state).toBe('HALF_OPEN');
    });

    test('should transition HALF_OPEN → CLOSED on success', async () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordElementFailure('tab1', `q${i}`);
      }
      await new Promise(r => setTimeout(r, 250));
      expect(breaker.checkGlobal().state).toBe('HALF_OPEN');

      breaker.recordGlobalSuccess();
      expect(breaker.checkGlobal().state).toBe('CLOSED');
    });
  });

  describe('Combined check()', () => {
    test('should return allowed=true when all breakers CLOSED', () => {
      const result = breaker.check('tab1', 'q1');
      expect(result.allowed).toBe(true);
      expect(result.level).toBeNull();
    });

    test('should block at element level', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');

      const result = breaker.check('tab1', 'q1');
      expect(result.allowed).toBe(false);
      expect(result.level).toBe('element');
    });

    test('should block at global level (most restrictive wins)', () => {
      for (let i = 0; i < 5; i++) {
        breaker.recordElementFailure('tab1', `q${i}`);
      }

      const result = breaker.check('tab1', 'q1');
      expect(result.allowed).toBe(false);
      expect(result.level).toBe('global');
    });

    test('should allow HALF_OPEN state (probe)', async () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');

      await new Promise(r => setTimeout(r, 250));

      const result = breaker.check('tab1', 'q1');
      expect(result.allowed).toBe(true); // HALF_OPEN allows probe
    });
  });

  describe('reset()', () => {
    test('should clear all state', () => {
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');
      breaker.recordElementFailure('tab1', 'q1');

      breaker.reset();

      expect(breaker.checkElement('tab1', 'q1').state).toBe('CLOSED');
      expect(breaker.checkPage('tab1').state).toBe('CLOSED');
      expect(breaker.checkGlobal().state).toBe('CLOSED');
    });
  });

  describe('hashQuery', () => {
    test('should produce consistent hashes', () => {
      expect(hashQuery('test query')).toBe(hashQuery('test query'));
    });

    test('should produce different hashes for different queries', () => {
      expect(hashQuery('query A')).not.toBe(hashQuery('query B'));
    });

    test('should handle empty string', () => {
      expect(hashQuery('')).toBe('0');
    });

    test('should handle unicode', () => {
      const hash = hashQuery('외부 radio button');
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });
  });
});
