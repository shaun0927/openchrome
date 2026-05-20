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
      connect: jest.fn<Promise<void>, [options?: { autoLaunch?: boolean }]>().mockResolvedValue(undefined),
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
    // Startup probe must never auto-launch Chrome — spawning belongs to tool calls.
    expect(client.connect).toHaveBeenCalledWith({ autoLaunch: false });

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
    // Drain the rejected connect() promise via the mock result so the assertion
    // is robust to changes in the .catch() handler's microtask depth.
    await client.connect.mock.results[0].value.catch(() => { /* expected reject */ });

    expect(states).toEqual(['failing']);
    expect(log.error).toHaveBeenCalledWith('[SelfHealing] Startup Chrome connect failed:', err);
  });

  test('startup initialization leaves chrome non-ready when connect resolves without a connection event', async () => {
    // Readiness is driven by the connection listener, not connect()'s resolution.
    // If connect() short-circuits (browser already attached, recently verified)
    // without emitting a connected/reconnected event, the readiness component
    // must not be touched here — some other path is responsible for it.
    const { client } = createClient();
    const states: ComponentState[] = [];
    const readiness = wireChromeReadiness(client, {
      setChrome: (state) => states.push(state),
    });

    readiness.initializeStartupConnection();
    await client.connect.mock.results[0].value;

    expect(states).toEqual([]);
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
