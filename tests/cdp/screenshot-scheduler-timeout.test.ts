/// <reference types="jest" />
/**
 * Tests for ScreenshotScheduler queue wait timeout behavior
 */

import { ScreenshotScheduler, ScreenshotResult } from '../../src/cdp/screenshot-scheduler';
import { CDPClient } from '../../src/cdp/client';
import { Page } from 'puppeteer-core';

// The timeout constant from the scheduler (30 seconds)
const SCREENSHOT_QUEUE_TIMEOUT_MS = 30_000;

/**
 * Build a minimal mock CDPClient whose send() resolves immediately with fake data.
 */
function makeMockCDPClient(responseDelay = 0): CDPClient {
  return {
    send: jest.fn().mockImplementation(() =>
      new Promise<{ data: string }>((resolve) =>
        setTimeout(() => resolve({ data: 'base64imagedata' }), responseDelay)
      )
    ),
  } as unknown as CDPClient;
}

/**
 * Build a minimal mock Page (we only pass it through; scheduler never calls methods on it).
 */
function makeMockPage(): Page {
  return {} as unknown as Page;
}

describe('ScreenshotScheduler - queue wait timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // 1. Normal flow: slot available → no queue wait
  // ---------------------------------------------------------------------------
  test('proceeds immediately when a slot is available (no queue wait)', async () => {
    const scheduler = new ScreenshotScheduler(2);
    const cdpClient = makeMockCDPClient();
    const page = makeMockPage();

    const promise = scheduler.capture(page, cdpClient, {});

    // Flush micro-tasks + the setTimeout(0) inside the mock
    jest.runAllTimers();
    await Promise.resolve();

    const result = await promise;
    expect(result.data).toBe('base64imagedata');
    expect(result.waitMs).toBeGreaterThanOrEqual(0);

    const stats = scheduler.getStats();
    expect(stats.completed).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.active).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Queue wait resolves when a slot opens
  // ---------------------------------------------------------------------------
  test('queued request proceeds when an active slot finishes', async () => {
    // concurrency = 1 so the second capture must queue
    const scheduler = new ScreenshotScheduler(1);
    const page = makeMockPage();

    // First capture: slow (10 s simulated)
    const slowCDPClient = makeMockCDPClient(10_000);
    const first = scheduler.capture(page, slowCDPClient, {});

    // Tick past the immediate check so the first capture starts
    await Promise.resolve();

    // Second capture: queues immediately
    const fastCDPClient = makeMockCDPClient(0);
    const second = scheduler.capture(page, fastCDPClient, {});

    // Confirm it is queued
    await Promise.resolve();
    expect(scheduler.getStats().pending).toBe(1);

    // Advance past the slow capture duration → first finishes, second is dequeued
    jest.advanceTimersByTime(10_000);
    await Promise.resolve(); // let first's finally run
    await Promise.resolve(); // let second's capture start
    jest.runAllTimers();
    await Promise.resolve();

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.data).toBe('base64imagedata');
    expect(r2.data).toBe('base64imagedata');

    const stats = scheduler.getStats();
    expect(stats.completed).toBe(2);
    expect(stats.pending).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Queue timeout rejects after 30 s with no slot
  // ---------------------------------------------------------------------------
  test('rejects with timeout error when no slot opens within 30 s', async () => {
    // concurrency = 1; the first capture never finishes (mock never resolves)
    const scheduler = new ScreenshotScheduler(1);
    const page = makeMockPage();

    // First capture occupies the single slot forever
    const blockedCDPClient = {
      send: jest.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
    } as unknown as CDPClient;

    // Start first (blocks the slot)
    scheduler.capture(page, blockedCDPClient, {}).catch(() => { /* expected */ });
    await Promise.resolve(); // let it start

    // Second capture must queue and will timeout
    const secondCDPClient = makeMockCDPClient();
    const secondPromise = scheduler.capture(page, secondCDPClient, {});

    // Confirm it is queued
    await Promise.resolve();
    expect(scheduler.getStats().pending).toBe(1);

    // Advance exactly to the timeout boundary
    jest.advanceTimersByTime(SCREENSHOT_QUEUE_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();

    await expect(secondPromise).rejects.toThrow(
      `Screenshot queue wait timed out after ${SCREENSHOT_QUEUE_TIMEOUT_MS}ms`
    );
  });

  // ---------------------------------------------------------------------------
  // 4. Queue cleanup: resolver removed from queue after timeout
  // ---------------------------------------------------------------------------
  test('removes timed-out resolver from the queue', async () => {
    // concurrency = 1 → second and third will queue
    const scheduler = new ScreenshotScheduler(1);
    const page = makeMockPage();

    const blockedCDPClient = {
      send: jest.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
    } as unknown as CDPClient;

    // Occupy the slot
    scheduler.capture(page, blockedCDPClient, {}).catch(() => { /* expected */ });
    await Promise.resolve();

    // Queue two more
    const c2 = scheduler.capture(page, makeMockCDPClient(), {});
    const c3 = scheduler.capture(page, makeMockCDPClient(), {});
    await Promise.resolve();

    expect(scheduler.getStats().pending).toBe(2);

    // Advance past timeout → both queued captures time out
    jest.advanceTimersByTime(SCREENSHOT_QUEUE_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();

    await expect(c2).rejects.toThrow('timed out');
    await expect(c3).rejects.toThrow('timed out');

    // After timeout the queue should be empty
    expect(scheduler.getStats().pending).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 5. Stats tracking: pending / active / completed counts
  // ---------------------------------------------------------------------------
  test('getStats() correctly reflects pending, active, and completed counts', async () => {
    const scheduler = new ScreenshotScheduler(1);
    const page = makeMockPage();

    // Slot 1: slow capture (5 s)
    const slowCDPClient = makeMockCDPClient(5_000);
    const first = scheduler.capture(page, slowCDPClient, {});
    await Promise.resolve();

    // initial state: 1 active, 0 pending, 0 completed
    let stats = scheduler.getStats();
    expect(stats.active).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.completed).toBe(0);

    // Queue a second capture
    const fastCDPClient = makeMockCDPClient(0);
    const second = scheduler.capture(page, fastCDPClient, {});
    await Promise.resolve();

    stats = scheduler.getStats();
    expect(stats.active).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.completed).toBe(0);

    // Finish the first capture
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();

    await first;
    await second;

    stats = scheduler.getStats();
    expect(stats.active).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.completed).toBe(2);
  });
});
