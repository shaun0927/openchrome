/// <reference types="jest" />
import { runBrowserUseNativeTask } from './browser-use-native';

describe('browser-use native loop', () => {
  test('runs task-level instruction through bridge transport', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: true, result: { status: 'passed', finalText: 'done', trace: [{ event: 'x' }] } })) };
    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });
    expect(result.status).toBe('passed');
    expect(transport.send).toHaveBeenCalledWith({ id: expect.any(Number), method: 'run_task', args: { startUrl: 'http://x', instruction: 'do it', timeoutMs: 60000 } });
  });
  test('preserves timeout status from bridge results', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: true, result: { status: 'timeout', finalText: '', trace: [], failureCategory: 'timeout' } })) };

    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });

    expect(result.status).toBe('timeout');
    expect(result.failureCategory).toBe('timeout');
  });

  test('classifies thrown bridge timeouts as timeout outcomes', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => { throw new Error('request timeout after 60000ms'); }) };

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

  test('returns failed result on bridge error', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: false, error: 'missing browser-use' })) };
    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });
    expect(result.status).toBe('failed');
    expect(result.failureCategory).toMatch(/missing/);
  });
});
