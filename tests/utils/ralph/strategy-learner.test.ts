/// <reference types="jest" />
/**
 * Unit tests for Strategy Learner
 */

// Mock domain memory before importing
const mockRecord = jest.fn().mockReturnValue({ id: 'dk-test', confidence: 0.6 });
const mockQuery = jest.fn().mockReturnValue([]);
const mockValidate = jest.fn().mockReturnValue(null);

jest.mock('../../../src/memory/domain-memory', () => ({
  getDomainMemory: () => ({
    record: mockRecord,
    query: mockQuery,
    validate: mockValidate,
  }),
  extractDomainFromUrl: (url: string) => {
    try { return new URL(url).hostname; } catch { return null; }
  },
}));

import {
  learnStrategy,
  getLearnedStrategy,
  recordStrategyFailure,
} from '../../../src/utils/ralph/strategy-learner';

describe('Strategy Learner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('learnStrategy', () => {
    test('should record S3+ strategies in domain memory', () => {
      learnStrategy('https://console.cloud.google.com/apis', 'radio', 'S3_CDP_COORD');
      expect(mockRecord).toHaveBeenCalledWith(
        'console.cloud.google.com',
        'ralph:strategy:radio',
        'S3_CDP_COORD'
      );
    });

    test('should record S4 JS inject strategy', () => {
      learnStrategy('https://app.example.com/settings', 'checkbox', 'S4_JS_INJECT');
      expect(mockRecord).toHaveBeenCalledWith(
        'app.example.com',
        'ralph:strategy:checkbox',
        'S4_JS_INJECT'
      );
    });

    test('should record S5 keyboard strategy', () => {
      learnStrategy('https://salesforce.com/dashboard', 'switch', 'S5_KEYBOARD');
      expect(mockRecord).toHaveBeenCalledWith(
        'salesforce.com',
        'ralph:strategy:switch',
        'S5_KEYBOARD'
      );
    });

    test('should NOT record S1 (default AX strategy)', () => {
      learnStrategy('https://example.com', 'button', 'S1_AX');
      expect(mockRecord).not.toHaveBeenCalled();
    });

    test('should NOT record S2 (default CSS strategy)', () => {
      learnStrategy('https://example.com', 'link', 'S2_CSS');
      expect(mockRecord).not.toHaveBeenCalled();
    });

    test('should NOT record S7 HITL', () => {
      learnStrategy('https://example.com', 'button', 'S7_HITL');
      expect(mockRecord).not.toHaveBeenCalled();
    });

    test('should handle invalid URL gracefully', () => {
      learnStrategy('not-a-url', 'radio', 'S3_CDP_COORD');
      expect(mockRecord).not.toHaveBeenCalled();
    });

    test('should lowercase the role in the key', () => {
      learnStrategy('https://example.com/page', 'RADIO', 'S3_CDP_COORD');
      expect(mockRecord).toHaveBeenCalledWith(
        'example.com',
        'ralph:strategy:radio',
        'S3_CDP_COORD'
      );
    });
  });

  describe('getLearnedStrategy', () => {
    test('should return learned strategy when confidence is sufficient', () => {
      mockQuery.mockReturnValueOnce([
        { id: 'dk-1', value: 'S3_CDP_COORD', confidence: 0.8 },
      ]);

      const result = getLearnedStrategy('https://console.cloud.google.com/apis', 'radio');
      expect(result).toBe('S3_CDP_COORD');
      expect(mockQuery).toHaveBeenCalledWith('console.cloud.google.com', 'ralph:strategy:radio');
    });

    test('should return null when no learning exists', () => {
      mockQuery.mockReturnValueOnce([]);
      const result = getLearnedStrategy('https://example.com', 'button');
      expect(result).toBeNull();
    });

    test('should return null when confidence is too low', () => {
      mockQuery.mockReturnValueOnce([
        { id: 'dk-1', value: 'S3_CDP_COORD', confidence: 0.1 },
      ]);
      const result = getLearnedStrategy('https://example.com', 'radio');
      expect(result).toBeNull();
    });

    test('should return null when role is undefined', () => {
      const result = getLearnedStrategy('https://example.com', undefined);
      expect(result).toBeNull();
    });

    test('should return null for invalid URL', () => {
      const result = getLearnedStrategy('bad-url', 'radio');
      expect(result).toBeNull();
    });

    test('should return highest confidence entry', () => {
      mockQuery.mockReturnValueOnce([
        { id: 'dk-1', value: 'S5_KEYBOARD', confidence: 0.9 },
        { id: 'dk-2', value: 'S3_CDP_COORD', confidence: 0.5 },
      ]);
      const result = getLearnedStrategy('https://example.com', 'radio');
      expect(result).toBe('S5_KEYBOARD'); // query returns sorted by confidence desc
    });
  });

  describe('recordStrategyFailure', () => {
    test('should validate with failure when matching entry exists', () => {
      mockQuery.mockReturnValueOnce([
        { id: 'dk-test-1', value: 'S3_CDP_COORD', confidence: 0.6 },
      ]);

      recordStrategyFailure('https://example.com', 'radio', 'S3_CDP_COORD');

      expect(mockValidate).toHaveBeenCalledWith('dk-test-1', false);
    });

    test('should not call validate when no matching entry', () => {
      mockQuery.mockReturnValueOnce([
        { id: 'dk-test-1', value: 'S5_KEYBOARD', confidence: 0.6 },
      ]);

      recordStrategyFailure('https://example.com', 'radio', 'S3_CDP_COORD');

      expect(mockValidate).not.toHaveBeenCalled();
    });

    test('should not call validate when no entries at all', () => {
      mockQuery.mockReturnValueOnce([]);
      recordStrategyFailure('https://example.com', 'radio', 'S3_CDP_COORD');
      expect(mockValidate).not.toHaveBeenCalled();
    });

    test('should handle invalid URL gracefully', () => {
      recordStrategyFailure('bad-url', 'radio', 'S3_CDP_COORD');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
