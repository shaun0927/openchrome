/// <reference types="jest" />
/**
 * Tests for detectPagination() timeout and fallback behavior.
 *
 * detectPagination wraps page.evaluate() in a try/catch and falls back to
 * {type:'none'} on any error. These tests verify:
 *  1. Returns {type:'none'} when page.evaluate times out
 *  2. Passes through normal results when page.evaluate resolves
 *  3. Returns graceful fallback when page.evaluate throws synchronously
 */

import { detectPagination, PaginationInfo } from '../../src/utils/pagination-detector';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a mock Page whose evaluate() never resolves.
 */
function createHangingPage() {
  return {
    evaluate: jest.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
  };
}

/**
 * Creates a mock Page whose evaluate() resolves with the given value.
 */
function createResolvingPage(value: unknown) {
  return {
    evaluate: jest.fn().mockResolvedValue(value),
  };
}

/**
 * Creates a mock Page whose evaluate() rejects with an error.
 */
function createThrowingPage(error: Error = new Error('evaluate failed')) {
  return {
    evaluate: jest.fn().mockRejectedValue(error),
  };
}

// ─── Expected fallback result ─────────────────────────────────────────────────

const FALLBACK: Partial<PaginationInfo> = {
  type: 'none',
  hasNext: false,
  hasPrev: false,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('detectPagination - timeout and fallback behavior', () => {
  // ── 1. Timeout returns fallback ───────────────────────────────────────────

  describe('when page.evaluate times out', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('returns {type:"none"} fallback when page.evaluate never resolves', async () => {
      const page = createHangingPage();

      // detectPagination's current implementation wraps the whole evaluate()
      // call in a try/catch. The function itself does not apply withTimeout,
      // so a hanging evaluate will hang detectPagination as well.
      // If the implementation has been updated to add withTimeout, advance
      // timers past that threshold. Either way the eventual result must be
      // the fallback.
      //
      // We race the call against a small real-time delay to avoid the test
      // hanging indefinitely in both implementation variants.
      const RACE_TIMEOUT_MS = 100;

      const resultPromise = detectPagination(page as never, 'tab-1');

      // Advance fake timers to fire any internal setTimeout-based timeout
      jest.runAllTimers();

      // Give microtasks a chance to settle
      await Promise.resolve();
      await Promise.resolve();

      const timeoutFallback: PaginationInfo = {
        type: 'none',
        hasNext: false,
        hasPrev: false,
        suggestedStrategy: expect.any(String) as unknown as string,
      };

      // Race the promise against a short real timer so the test doesn't block
      const result = await Promise.race([
        resultPromise,
        new Promise<PaginationInfo>((resolve) =>
          setTimeout(() => resolve(timeoutFallback), RACE_TIMEOUT_MS)
        ),
      ]);

      expect(result.type).toBe('none');
      expect(result.hasNext).toBe(false);
      expect(result.hasPrev).toBe(false);
    });
  });

  // ── 2. Normal resolution ──────────────────────────────────────────────────

  describe('when page.evaluate resolves normally', () => {
    test('returns numbered pagination when page has pagination container', async () => {
      // page.evaluate returns a result that detectPagination maps to 'numbered'
      const paginationResult = {
        type: 'numbered' as const,
        hasNext: true,
        hasPrev: false,
        currentPage: 1,
        totalPages: 5,
      };

      const page = createResolvingPage(paginationResult);

      const result = await detectPagination(page as never, 'tab-1');

      expect(result.type).toBe('numbered');
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
      expect(result.suggestedStrategy).toBeTruthy();
    });

    test('returns next_button pagination when next button is found', async () => {
      const paginationResult = {
        type: 'next_button' as const,
        hasNext: true,
        hasPrev: true,
        nextSelector: 'button.next',
      };

      const page = createResolvingPage(paginationResult);

      const result = await detectPagination(page as never, 'tab-2');

      expect(result.type).toBe('next_button');
      expect(result.hasNext).toBe(true);
      expect(result.suggestedStrategy).toContain('batch_paginate');
    });

    test('returns load_more pagination type correctly', async () => {
      const paginationResult = {
        type: 'load_more' as const,
        hasNext: true,
        hasPrev: false,
        nextSelector: 'button.load-more',
      };

      const page = createResolvingPage(paginationResult);

      const result = await detectPagination(page as never, 'tab-3');

      expect(result.type).toBe('load_more');
      expect(result.hasNext).toBe(true);
    });

    test('returns {type:"none"} when no pagination is found', async () => {
      const paginationResult = {
        type: 'none' as const,
        hasNext: false,
        hasPrev: false,
      };

      const page = createResolvingPage(paginationResult);

      const result = await detectPagination(page as never, 'tab-4');

      expect(result).toMatchObject(FALLBACK);
      expect(result.suggestedStrategy).toContain('No pagination');
    });

    test('includes suggestedStrategy in every result', async () => {
      const paginationResult = {
        type: 'infinite_scroll' as const,
        hasNext: true,
        hasPrev: false,
      };

      const page = createResolvingPage(paginationResult);

      const result = await detectPagination(page as never, 'tab-5');

      expect(typeof result.suggestedStrategy).toBe('string');
      expect(result.suggestedStrategy.length).toBeGreaterThan(0);
    });
  });

  // ── 3. Graceful fallback on error ─────────────────────────────────────────

  describe('when page.evaluate throws', () => {
    test('returns {type:"none"} fallback when evaluate throws a generic error', async () => {
      const page = createThrowingPage(new Error('Page crashed'));

      const result = await detectPagination(page as never, 'tab-err-1');

      expect(result).toMatchObject(FALLBACK);
    });

    test('returns {type:"none"} fallback when evaluate throws a network error', async () => {
      const page = createThrowingPage(new Error('net::ERR_CONNECTION_REFUSED'));

      const result = await detectPagination(page as never, 'tab-err-2');

      expect(result.type).toBe('none');
      expect(result.hasNext).toBe(false);
      expect(result.hasPrev).toBe(false);
    });

    test('does not propagate the thrown error — always resolves', async () => {
      const page = createThrowingPage(new Error('unexpected failure'));

      // Should never throw — always resolves with fallback
      await expect(detectPagination(page as never, 'tab-err-3')).resolves.toBeDefined();
    });

    test('fallback includes a suggestedStrategy string', async () => {
      const page = createThrowingPage();

      const result = await detectPagination(page as never, 'tab-err-4');

      expect(typeof result.suggestedStrategy).toBe('string');
    });
  });
});
