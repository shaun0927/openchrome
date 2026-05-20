/// <reference types="jest" />
import type { BridgeResponse } from '../adapters/browser-use-adapter';
import { runBrowserUseNativeTask } from './browser-use-native';

describe('browser-use native loop', () => {
  test('runs task-level instruction through bridge transport', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: true, result: { status: 'passed', finalText: 'done', trace: [{ event: 'x' }] } })) };
    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });
    expect(result.status).toBe('passed');
    expect(transport.send).toHaveBeenCalledWith({ id: expect.any(Number), method: 'run_task', args: { startUrl: 'http://x', instruction: 'do it', timeoutMs: 30000 } });
  });
  test('preserves timeout status from bridge results', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: true, result: { status: 'timeout', finalText: '', trace: [], failureCategory: 'timeout' } })) };

    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });

    expect(result.status).toBe('timeout');
    expect(result.failureCategory).toBe('timeout');
  });

  test('classifies bridge error timeout responses as timeout outcomes', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: false, error: 'browser-use bridge \"run_task\" timed out after 30000ms' })) };

    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });

    expect(result.status).toBe('timeout');
    expect(result.failureCategory).toBe('timeout');
  });

  test('classifies thrown bridge timeouts as timeout outcomes', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => { throw new Error('request timeout after 30000ms'); }) };

    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });

    expect(result.status).toBe('timeout');
    expect(result.failureCategory).toBe('timeout');
  });

  test('uses a unique request id for each bridge call', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: true, result: { status: 'passed', finalText: 'done', trace: [] } })) };

    await Promise.all([
      runBrowserUseNativeTask(transport, { id: 'rw1', startUrl: 'http://x', goal: 'do it' }),
      runBrowserUseNativeTask(transport, { id: 'rw2', startUrl: 'http://x', goal: 'do it' }),
    ]);

    const ids = (transport.send as jest.Mock).mock.calls.map(([request]) => request.id);
    expect(new Set(ids).size).toBe(2);
  });

  test('awaits shared transport startup before overlapping sends', async () => {
    let releaseStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { releaseStart = resolve; });
    const transport = {
      start: jest.fn(async () => started),
      stop: jest.fn(async () => undefined),
      send: jest.fn(async (): Promise<BridgeResponse> => ({ id: 1, ok: true, result: { status: 'passed', finalText: 'done', trace: [] } })),
    };

    const first = runBrowserUseNativeTask(transport, { id: 'rw1', startUrl: 'http://x', goal: 'one' });
    const second = runBrowserUseNativeTask(transport, { id: 'rw2', startUrl: 'http://x', goal: 'two' });
    await Promise.resolve();
    expect(transport.start).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
    releaseStart?.();
    await Promise.all([first, second]);
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  test('keeps shared transport open until overlapping calls finish', async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise((resolve) => { releaseFirst = () => resolve({ id: 1, ok: true, result: { status: 'passed', finalText: 'one', trace: [] } }); });
    const transport = {
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
      send: jest.fn(async (request): Promise<BridgeResponse> => {
        if (request.args.instruction === 'one') return first as Promise<BridgeResponse>;
        return { id: 2, ok: true, result: { status: 'passed', finalText: 'two', trace: [] } };
      }),
    };

    const pending = runBrowserUseNativeTask(transport, { id: 'rw1', startUrl: 'http://x', goal: 'one' });
    const second = await runBrowserUseNativeTask(transport, { id: 'rw2', startUrl: 'http://x', goal: 'two' });
    expect(second.status).toBe('passed');
    expect(transport.stop).not.toHaveBeenCalled();
    releaseFirst?.();
    await pending;
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  test('returns failed result on bridge error', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: false, error: 'missing browser-use' })) };
    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });
    expect(result.status).toBe('failed');
    expect(result.failureCategory).toMatch(/missing/);
  });
});
