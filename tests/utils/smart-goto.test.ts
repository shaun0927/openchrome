/// <reference types="jest" />
/**
 * Tests for smart-goto utility: waitForDomStability and smartGoto
 */

import { waitForDomStability, smartGoto } from '../../src/utils/smart-goto';
import type { Page } from 'puppeteer-core';

function makePage(evaluateValues: number[], gotoResult: object | null = {}): Page {
  let callIndex = 0;
  return {
    evaluate: jest.fn(async () => {
      const val = evaluateValues[callIndex] ?? evaluateValues[evaluateValues.length - 1];
      callIndex++;
      return val;
    }),
    goto: jest.fn().mockResolvedValue(gotoResult),
    on: jest.fn(),
    off: jest.fn(),
    mainFrame: jest.fn().mockReturnValue({}),
  } as unknown as Page;
}

describe('waitForDomStability', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('returns stable=true immediately when element count does not change', async () => {
    // First call (initial) returns 100, second call (after interval) returns 100
    const page = makePage([100, 100]);

    const promise = waitForDomStability(page, { intervalMs: 100, maxIterations: 3, threshold: 0.2 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.stable).toBe(true);
    expect(result.elementCount).toBe(100);
    expect(result.iterations).toBe(1);
  });

  test('retries when element count increases significantly (>20%) and eventually stabilizes', async () => {
    // First check: 100, second check: 150 (50% increase → unstable), third check: 152 (~1.3% → stable)
    const page = makePage([100, 150, 152]);

    const promise = waitForDomStability(page, { intervalMs: 100, maxIterations: 3, threshold: 0.2 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.stable).toBe(true);
    expect(result.elementCount).toBe(152);
    expect(result.iterations).toBe(2);
  });

  test('caps at maxIterations and returns stable=false when DOM keeps changing', async () => {
    // Always growing: 100, 200, 400, 800 — always >20% change
    const page = makePage([100, 200, 400, 800]);

    const promise = waitForDomStability(page, { intervalMs: 100, maxIterations: 3, threshold: 0.2 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.stable).toBe(false);
    expect(result.iterations).toBe(3);
  });

  test('handles page.evaluate errors gracefully on initial call', async () => {
    const page = {
      evaluate: jest.fn().mockRejectedValue(new Error('Target closed')),
    } as unknown as Page;

    const result = await waitForDomStability(page, { intervalMs: 100, maxIterations: 3 });

    expect(result.stable).toBe(true);
    expect(result.elementCount).toBe(0);
    expect(result.iterations).toBe(0);
  });

  test('handles page.evaluate errors gracefully mid-loop (page navigated away)', async () => {
    let callIndex = 0;
    const page = {
      evaluate: jest.fn(async () => {
        if (callIndex === 0) {
          callIndex++;
          return 100;
        }
        throw new Error('Execution context was destroyed');
      }),
    } as unknown as Page;

    const promise = waitForDomStability(page, { intervalMs: 100, maxIterations: 3 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.stable).toBe(true);
    expect(result.elementCount).toBe(100);
    expect(result.iterations).toBe(1);
  });

  test('uses defaults when no options provided', async () => {
    // Stable immediately: 50 elements, no change
    const page = makePage([50, 50]);

    const promise = waitForDomStability(page);
    // Default intervalMs=500, advance timers accordingly
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.stable).toBe(true);
    expect(result.elementCount).toBe(50);
  });
});

describe('smartGoto', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('calls waitForDomStability after navigation when no auth redirect', async () => {
    const evaluateMock = jest.fn().mockResolvedValue(100);
    const page = {
      evaluate: evaluateMock,
      goto: jest.fn().mockResolvedValue({ status: () => 200 }),
      on: jest.fn(),
      off: jest.fn(),
      mainFrame: jest.fn().mockReturnValue({}),
    } as unknown as Page;

    const promise = smartGoto(page, 'https://example.com');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.authRedirect).toBeUndefined();
    // evaluate should have been called at least once (for DOM stability check)
    expect(evaluateMock).toHaveBeenCalled();
  });

  test('does not call waitForDomStability when auth redirect is detected', async () => {
    const evaluateMock = jest.fn().mockResolvedValue(100);
    let frameNavigatedHandler: ((frame: object) => void) | null = null;

    const fakeMainFrame = { url: () => 'https://accounts.google.com/signin' };

    const page = {
      evaluate: evaluateMock,
      goto: jest.fn().mockImplementation(async () => {
        // Simulate auth redirect firing during navigation
        if (frameNavigatedHandler) {
          frameNavigatedHandler(fakeMainFrame);
        }
        // Hang forever (auth redirect resolves the race first)
        await new Promise(() => {});
        return null;
      }),
      on: jest.fn((event: string, handler: (frame: object) => void) => {
        if (event === 'framenavigated') frameNavigatedHandler = handler;
      }),
      off: jest.fn(),
      mainFrame: jest.fn().mockReturnValue(fakeMainFrame),
    } as unknown as Page;

    const promise = smartGoto(page, 'https://example.com');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.authRedirect).toBeDefined();
    expect(result.authRedirect?.host).toBe('accounts.google.com');
    // evaluate must NOT have been called (DOM stability skipped for auth redirects)
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  test('logs console.error when DOM is not stable after navigation', async () => {
    // Always growing element counts to force stable=false
    let callIndex = 0;
    const growingCounts = [100, 200, 400, 800];
    const page = {
      evaluate: jest.fn(async () => growingCounts[callIndex++] ?? 800),
      goto: jest.fn().mockResolvedValue({ status: () => 200 }),
      on: jest.fn(),
      off: jest.fn(),
      mainFrame: jest.fn().mockReturnValue({}),
    } as unknown as Page;

    const promise = smartGoto(page, 'https://example.com');
    await jest.runAllTimersAsync();
    await promise;

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[smartGoto] DOM not stable'),
    );
  });
});
