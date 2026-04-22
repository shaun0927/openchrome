/// <reference types="jest" />
/**
 * Tests for safeAsyncListener.
 *
 * Issue #5 (A-5): async EventEmitter listeners must not silently swallow
 * thrown errors or rejections. The wrapper catches them, increments the
 * listener-errors metric, and logs to stderr.
 */

import { EventEmitter } from 'node:events';
import { getListenerErrorStats, resetListenerErrorStatsForTests, safeAsyncListener } from '../../src/utils/safe-listener';
import { getMetricsCollector } from '../../src/metrics/collector';

function counterValueFor(listener: string): number {
  const dump = getMetricsCollector().export();
  const pattern = new RegExp(
    `openchrome_listener_errors_total\\{listener="${listener}"\\}\\s+(\\d+)`,
  );
  const match = dump.match(pattern);
  return match ? parseInt(match[1], 10) : 0;
}

describe('safeAsyncListener', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    resetListenerErrorStatsForTests();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('passes arguments through to the wrapped handler', async () => {
    const ee = new EventEmitter();
    const received: Array<[string, number]> = [];

    ee.on(
      'evt',
      safeAsyncListener('happy', async (a: string, b: number) => {
        received.push([a, b]);
      }),
    );

    ee.emit('evt', 'hello', 42);
    // flush microtasks so the async handler settles before we assert.
    await new Promise((r) => setTimeout(r, 5));

    expect(received).toEqual([['hello', 42]]);
  });

  it('catches thrown errors, increments metric, and keeps the process alive', async () => {
    const before = counterValueFor('throws');
    const ee = new EventEmitter();

    ee.on(
      'evt',
      safeAsyncListener('throws', async () => {
        throw new Error('boom-sync');
      }),
    );

    // No outer try/catch — if safeAsyncListener leaked the throw, this emit
    // would produce an unhandled rejection and fail the test.
    ee.emit('evt');
    await new Promise((r) => setTimeout(r, 5));

    expect(counterValueFor('throws')).toBe(before + 1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[Listener:throws\] swallowed error/),
      expect.any(Error),
    );
  });

  it('catches rejected promises returned asynchronously', async () => {
    const before = counterValueFor('rejects');
    const ee = new EventEmitter();

    ee.on(
      'evt',
      safeAsyncListener('rejects', async () => {
        await new Promise((r) => setTimeout(r, 1));
        return Promise.reject(new Error('boom-async'));
      }),
    );

    ee.emit('evt');
    await new Promise((r) => setTimeout(r, 20));

    expect(counterValueFor('rejects')).toBe(before + 1);
  });


  it('tracks recent listener-error stats for health reporting', async () => {
    const ee = new EventEmitter();
    ee.on('evt', safeAsyncListener('health-stats', async () => {
      throw new Error('stats-boom');
    }));

    ee.emit('evt');
    await new Promise((r) => setTimeout(r, 5));

    expect(getListenerErrorStats().errorCount1m).toBe(1);
    expect(getListenerErrorStats().errorCount1h).toBe(1);
  });

  it('invokes the optional onError hook and shields listener from onError throws', async () => {
    const ee = new EventEmitter();
    const seen: unknown[] = [];
    const onError = jest.fn((err: unknown) => {
      seen.push(err);
      throw new Error('hook failure');
    });

    ee.on(
      'evt',
      safeAsyncListener(
        'with-hook',
        async () => {
          throw new Error('primary');
        },
        onError,
      ),
    );

    ee.emit('evt');
    await new Promise((r) => setTimeout(r, 5));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBeInstanceOf(Error);
    expect((seen[0] as Error).message).toBe('primary');
    // The hook throw should have been captured by our inner try/catch.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[Listener:with-hook\] onError hook failed/),
      expect.any(Error),
    );
  });
});
