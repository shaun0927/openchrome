/// <reference types="jest" />
/**
 * Unit tests for HITL Escalation
 */

import {
  buildHitlContext,
  formatHitlResponse,
  StrategyAttempt,
} from '../../../src/utils/ralph/hitl-escalation';

describe('HITL Escalation', () => {
  const baseAttempts: StrategyAttempt[] = [
    { strategy: 'AX tree', strategyId: 'S1_AX', outcome: 'SILENT_CLICK', durationMs: 200 },
    { strategy: 'CSS discovery', strategyId: 'S2_CSS', outcome: 'SILENT_CLICK', durationMs: 300 },
    { strategy: 'CDP coordinates', strategyId: 'S3_CDP_COORD', outcome: 'SILENT_CLICK', durationMs: 150 },
    { strategy: 'JS injection', strategyId: 'S4_JS_INJECT', outcome: 'SILENT_CLICK', durationMs: 100 },
    { strategy: 'Keyboard', strategyId: 'S5_KEYBOARD', outcome: 'SILENT_CLICK', durationMs: 100 },
    { strategy: 'CDP raw events', strategyId: 'S6_CDP_RAW', outcome: 'SILENT_CLICK', durationMs: 150 },
  ];

  describe('buildHitlContext', () => {
    test('should build context with all fields', () => {
      const ctx = buildHitlContext('외부 radio button', 'https://console.cloud.google.com', 'tab1', baseAttempts, undefined, 1000);

      expect(ctx.query).toBe('외부 radio button');
      expect(ctx.url).toBe('https://console.cloud.google.com');
      expect(ctx.tabId).toBe('tab1');
      expect(ctx.strategiesTried).toHaveLength(6);
      expect(ctx.diagnosis).toBeTruthy();
      expect(ctx.suggestion).toBeTruthy();
      expect(ctx.totalDurationMs).toBe(1000);
    });

    test('should diagnose all SILENT_CLICK as custom component', () => {
      const ctx = buildHitlContext('radio', 'https://example.com', 'tab1', baseAttempts, undefined, 1000);
      expect(ctx.diagnosis).toContain('custom framework component');
    });

    test('should diagnose all ELEMENT_NOT_FOUND', () => {
      const notFoundAttempts: StrategyAttempt[] = [
        { strategy: 'AX tree', strategyId: 'S1_AX', outcome: 'ELEMENT_NOT_FOUND' },
        { strategy: 'CSS discovery', strategyId: 'S2_CSS', outcome: 'ELEMENT_NOT_FOUND' },
      ];
      const ctx = buildHitlContext('missing', 'https://example.com', 'tab1', notFoundAttempts, undefined, 500);
      expect(ctx.diagnosis).toContain('could not be found');
    });

    test('should diagnose all WRONG_ELEMENT', () => {
      const wrongAttempts: StrategyAttempt[] = [
        { strategy: 'AX tree', strategyId: 'S1_AX', outcome: 'WRONG_ELEMENT' },
        { strategy: 'CSS', strategyId: 'S2_CSS', outcome: 'WRONG_ELEMENT' },
      ];
      const ctx = buildHitlContext('btn', 'https://example.com', 'tab1', wrongAttempts, undefined, 400);
      expect(ctx.diagnosis).toContain('wrong element');
    });

    test('should diagnose mixed SILENT_CLICK + WRONG_ELEMENT', () => {
      const mixedAttempts: StrategyAttempt[] = [
        { strategy: 'AX tree', strategyId: 'S1_AX', outcome: 'WRONG_ELEMENT' },
        { strategy: 'CSS', strategyId: 'S2_CSS', outcome: 'SILENT_CLICK' },
      ];
      const ctx = buildHitlContext('radio', 'https://example.com', 'tab1', mixedAttempts, undefined, 600);
      expect(ctx.diagnosis).toContain('tooltip trigger');
    });

    test('should diagnose EXCEPTION as security issue', () => {
      const exceptionAttempts: StrategyAttempt[] = [
        { strategy: 'JS injection', strategyId: 'S4_JS_INJECT', outcome: 'EXCEPTION' },
      ];
      const ctx = buildHitlContext('input', 'https://example.com', 'tab1', exceptionAttempts, undefined, 200);
      expect(ctx.diagnosis).toContain('security policies');
    });

    test('should diagnose all TIMEOUT', () => {
      const timeoutAttempts: StrategyAttempt[] = [
        { strategy: 'AX tree', strategyId: 'S1_AX', outcome: 'TIMEOUT' },
        { strategy: 'CSS', strategyId: 'S2_CSS', outcome: 'TIMEOUT' },
      ];
      const ctx = buildHitlContext('btn', 'https://example.com', 'tab1', timeoutAttempts, undefined, 30000);
      expect(ctx.diagnosis).toContain('timed out');
    });

    test('should diagnose empty attempts as element not found', () => {
      const ctx = buildHitlContext('missing', 'https://example.com', 'tab1', [], undefined, 100);
      expect(ctx.diagnosis).toContain('No element matching');
    });

    test('should suggest manual click for SILENT_CLICK', () => {
      const ctx = buildHitlContext('외부', 'https://example.com', 'tab1', baseAttempts, undefined, 1000);
      expect(ctx.suggestion).toContain('manually');
    });

    test('should suggest verify existence for ELEMENT_NOT_FOUND', () => {
      const notFoundAttempts: StrategyAttempt[] = [
        { strategy: 'AX', strategyId: 'S1_AX', outcome: 'ELEMENT_NOT_FOUND' },
      ];
      const ctx = buildHitlContext('missing', 'https://example.com', 'tab1', notFoundAttempts, undefined, 200);
      expect(ctx.suggestion).toContain('verify');
    });
  });

  describe('formatHitlResponse', () => {
    test('should produce readable output with all sections', () => {
      const ctx = buildHitlContext('외부 radio button', 'https://console.cloud.google.com/apis', 'tab1', baseAttempts, undefined, 1500);
      const response = formatHitlResponse(ctx);

      expect(response).toContain('ALL AUTOMATION STRATEGIES EXHAUSTED');
      expect(response).toContain('외부 radio button');
      expect(response).toContain('Strategies tried:');
      expect(response).toContain('AX tree: SILENT_CLICK');
      expect(response).toContain('CDP coordinates: SILENT_CLICK');
      expect(response).toContain('Diagnosis:');
      expect(response).toContain('Suggestion:');
      expect(response).toContain('console.cloud.google.com');
      expect(response).toContain('1500ms');
    });

    test('should include duration per strategy when available', () => {
      const ctx = buildHitlContext('btn', 'https://example.com', 'tab1', [
        { strategy: 'AX tree', strategyId: 'S1_AX', outcome: 'SILENT_CLICK', durationMs: 250 },
      ], undefined, 250);
      const response = formatHitlResponse(ctx);
      expect(response).toContain('(250ms)');
    });

    test('should handle missing duration', () => {
      const ctx = buildHitlContext('btn', 'https://example.com', 'tab1', [
        { strategy: 'AX tree', strategyId: 'S1_AX', outcome: 'ELEMENT_NOT_FOUND' },
      ], undefined, 100);
      const response = formatHitlResponse(ctx);
      expect(response).toContain('AX tree: ELEMENT_NOT_FOUND');
      expect(response).not.toContain('(undefined');
    });
  });
});
