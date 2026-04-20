/// <reference types="jest" />
import { cdpRace } from '../../src/utils/cdp-abort';
import { ClientDisconnectError } from '../../src/errors/abort';
import { ToolContext, isAborted, throwIfAborted } from '../../src/types/mcp';

const ctx = (signal?: AbortSignal): ToolContext => ({
  startTime: Date.now(),
  deadlineMs: 120_000,
  signal,
});

describe('cdpRace', () => {
  test('returns original promise unchanged when no context provided', async () => {
    const result = await cdpRace(Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  test('returns original promise unchanged when context has no signal', async () => {
    const result = await cdpRace(Promise.resolve('ok'), ctx(undefined));
    expect(result).toBe('ok');
  });

  test('resolves normally when signal is not aborted', async () => {
    const controller = new AbortController();
    const result = await cdpRace(Promise.resolve(42), ctx(controller.signal));
    expect(result).toBe(42);
  });

  test('rejects synchronously when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new ClientDisconnectError());
    await expect(cdpRace(Promise.resolve('ok'), ctx(controller.signal))).rejects.toBeInstanceOf(
      ClientDisconnectError,
    );
  });

  test('rejects with abort reason when signal aborts during execution', async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => {});
    setTimeout(() => controller.abort(new ClientDisconnectError('client gone')), 20);
    const start = Date.now();
    await expect(cdpRace(never, ctx(controller.signal))).rejects.toMatchObject({
      name: 'ClientDisconnectError',
      message: 'client gone',
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('falls back to generic Error when abort reason is missing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(cdpRace(Promise.resolve('ok'), ctx(controller.signal))).rejects.toThrow();
  });

  test('propagates promise rejection when signal never fires', async () => {
    const controller = new AbortController();
    const failing = Promise.reject(new Error('cdp failed'));
    await expect(cdpRace(failing, ctx(controller.signal))).rejects.toThrow('cdp failed');
  });

  test('removes abort listener after promise settles to avoid leaks', async () => {
    const controller = new AbortController();
    const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
    await cdpRace(Promise.resolve(1), ctx(controller.signal));
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('ToolContext abort helpers', () => {
  test('isAborted returns false when no context or no signal', () => {
    expect(isAborted(undefined)).toBe(false);
    expect(isAborted(ctx(undefined))).toBe(false);
  });

  test('isAborted reflects signal state', () => {
    const controller = new AbortController();
    expect(isAborted(ctx(controller.signal))).toBe(false);
    controller.abort();
    expect(isAborted(ctx(controller.signal))).toBe(true);
  });

  test('throwIfAborted is a no-op when not aborted', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    const controller = new AbortController();
    expect(() => throwIfAborted(ctx(controller.signal))).not.toThrow();
  });

  test('throwIfAborted throws the signal reason when aborted', () => {
    const controller = new AbortController();
    controller.abort(new ClientDisconnectError('disconnect'));
    expect(() => throwIfAborted(ctx(controller.signal))).toThrow(ClientDisconnectError);
  });

  test('throwIfAborted wraps non-Error reasons', () => {
    const controller = new AbortController();
    controller.abort('stringly typed reason');
    expect(() => throwIfAborted(ctx(controller.signal))).toThrow('stringly typed reason');
  });
});

describe('ClientDisconnectError', () => {
  test('is an Error with stable name', () => {
    const err = new ClientDisconnectError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ClientDisconnectError');
  });

  test('exposes default message', () => {
    expect(new ClientDisconnectError().message).toBe(
      'Client disconnected before tool call completed',
    );
  });
});
