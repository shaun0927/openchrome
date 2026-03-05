/// <reference types="jest" />
import { safeEvaluate } from '../../src/utils/safe-evaluate';
import type { Page } from 'puppeteer-core';

function makePage(evaluateImpl: (...args: any[]) => any): Page {
  return {
    evaluate: evaluateImpl,
  } as unknown as Page;
}

describe('safeEvaluate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves with the value returned by page.evaluate', async () => {
    const page = makePage((_fn: any, ...args: any[]) => Promise.resolve(42));
    const result = await safeEvaluate(page, () => 42, [], { timeoutMs: 1000 });
    expect(result).toBe(42);
  });

  it('rejects with a descriptive error when timeout fires', async () => {
    const page = makePage((_fn: any, ...args: any[]) => new Promise(() => { /* never resolves */ }));

    const promise = safeEvaluate(page, () => {}, [], { timeoutMs: 5000, label: 'test_op' });

    jest.advanceTimersByTime(5001);

    await expect(promise).rejects.toThrow('test_op timed out after 5000ms');
  });

  it('uses default timeoutMs of 10000 when not specified', async () => {
    const page = makePage((_fn: any, ...args: any[]) => new Promise(() => { /* never resolves */ }));

    const promise = safeEvaluate(page, () => {}, []);

    jest.advanceTimersByTime(10001);

    await expect(promise).rejects.toThrow('evaluate timed out after 10000ms');
  });

  it('uses default label "evaluate" in error message when not specified', async () => {
    const page = makePage((_fn: any, ...args: any[]) => new Promise(() => { /* never resolves */ }));

    const promise = safeEvaluate(page, () => {}, [], { timeoutMs: 100 });

    jest.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow('evaluate timed out after 100ms');
  });

  it('cleans up the timer on success (no timer leak)', async () => {
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    const page = makePage((_fn: any, ...args: any[]) => Promise.resolve('done'));

    await safeEvaluate(page, () => 'done', [], { timeoutMs: 5000 });

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('passes args to page.evaluate', async () => {
    const captured: any[] = [];
    const page = makePage((_fn: any, ...args: any[]) => {
      captured.push(...args);
      return Promise.resolve(true);
    });

    await safeEvaluate(page, (_a: number, _b: string) => true, [1, 'hello'], { timeoutMs: 1000 });

    expect(captured).toEqual([1, 'hello']);
  });
});
