/// <reference types="jest" />

import type { ConnectionEvent } from '../../src/cdp/client';
import { wireChromeReadiness } from '../../src/watchdog/chrome-readiness';
import type { ComponentState } from '../../src/watchdog/readiness';

function createClient() {
  let listener: ((event: ConnectionEvent) => void) | null = null;
  return {
    client: {
      addConnectionListener: jest.fn((fn: (event: ConnectionEvent) => void) => {
        listener = fn;
      }),
      connect: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      forceReconnect: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    },
    emit: (event: ConnectionEvent) => {
      if (!listener) throw new Error('connection listener not registered');
      listener(event);
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('chrome readiness wiring', () => {
  test('startup initialization proactively connects and marks chrome ok on connection', async () => {
    const { client, emit } = createClient();
    const states: ComponentState[] = [];
    const readiness = wireChromeReadiness(client, {
      setChrome: (state) => states.push(state),
    });

    readiness.initializeStartupConnection();
    expect(client.connect).toHaveBeenCalledTimes(1);

    emit({ type: 'connected', timestamp: Date.now() });
    await client.connect.mock.results[0].value;

    expect(states).toEqual(['ok']);
  });

  test('startup initialization marks chrome failing when connect rejects', async () => {
    const { client } = createClient();
    const err = new Error('Chrome unavailable');
    client.connect.mockRejectedValueOnce(err);
    const states: ComponentState[] = [];
    const log = { error: jest.fn() };
    const readiness = wireChromeReadiness(client, {
      setChrome: (state) => states.push(state),
      log,
    });

    readiness.initializeStartupConnection();
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toEqual(['failing']);
    expect(log.error).toHaveBeenCalledWith('[SelfHealing] Startup Chrome connect failed:', err);
  });

  test('watchdog relaunch keeps chrome non-ready until forceReconnect resolves', async () => {
    const { client, emit } = createClient();
    const reconnect = deferred();
    client.forceReconnect.mockReturnValueOnce(reconnect.promise);
    const states: ComponentState[] = [];
    const readiness = wireChromeReadiness(client, {
      setChrome: (state) => states.push(state),
    });

    const relaunchPromise = readiness.handleChromeRelaunched();
    expect(states).toEqual(['failing']);

    emit({ type: 'connected', timestamp: Date.now() });
    emit({ type: 'reconnected', timestamp: Date.now() });
    expect(states).toEqual(['failing']);

    reconnect.resolve();
    await relaunchPromise;

    expect(states).toEqual(['failing', 'ok']);
  });

  test('watchdog relaunch leaves chrome failing when forceReconnect rejects', async () => {
    const { client, emit } = createClient();
    const err = new Error('reconnect failed');
    const reconnect = deferred();
    client.forceReconnect.mockReturnValueOnce(reconnect.promise);
    const states: ComponentState[] = [];
    const readiness = wireChromeReadiness(client, {
      setChrome: (state) => states.push(state),
    });

    const relaunchPromise = readiness.handleChromeRelaunched();
    emit({ type: 'reconnect_failed', timestamp: Date.now(), error: err.message });
    reconnect.reject(err);

    await expect(relaunchPromise).rejects.toThrow('reconnect failed');
    expect(states).toEqual(['failing', 'failing']);
  });
});
