/// <reference types="jest" />

import { RequestQueue } from '../../src/utils/request-queue';

describe('RequestQueue timer lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('clears timeout handles after successful queue items', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const queue = new RequestQueue('success-session');

    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('clears timeout handles after failed queue items', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const queue = new RequestQueue('failure-session');

    await expect(queue.enqueue(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('unrefs timeout handles when the runtime supports unref', async () => {
    const realSetTimeout = global.setTimeout;
    const unrefSpy = jest.fn();
    jest.spyOn(global, 'setTimeout').mockImplementation(
      ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const handle = realSetTimeout(handler as (...callbackArgs: unknown[]) => void, timeout, ...args);
        const originalUnref = (handle as NodeJS.Timeout).unref?.bind(handle);
        (handle as NodeJS.Timeout).unref = () => {
          unrefSpy();
          return originalUnref ? originalUnref() : handle as NodeJS.Timeout;
        };
        return handle;
      }) as unknown as typeof setTimeout,
    );

    const queue = new RequestQueue('unref-session');
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');

    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });
});
