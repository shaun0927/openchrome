/// <reference types="jest" />
import type { Page } from 'puppeteer-core';
import { safeTitle } from '../../src/utils/safe-title';

describe('safeTitle', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('returns the page title and clears the timeout timer', async () => {
    jest.useFakeTimers();
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const page = {
      title: jest.fn().mockResolvedValue('Example'),
    } as unknown as Page;

    await expect(safeTitle(page, 1000)).resolves.toBe('Example');

    expect(page.title).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('returns an empty title when page.title times out', async () => {
    jest.useFakeTimers();
    const page = {
      title: jest.fn(() => new Promise<string>(() => {})),
    } as unknown as Page;

    const title = safeTitle(page, 1000);
    jest.advanceTimersByTime(1000);

    await expect(title).resolves.toBe('');
    expect(jest.getTimerCount()).toBe(0);
  });
});
