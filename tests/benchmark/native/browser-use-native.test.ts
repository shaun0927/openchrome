/// <reference types="jest" />
import { runBrowserUseNativeTask } from './browser-use-native';

describe('browser-use native loop', () => {
  test('runs task-level instruction through bridge transport', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: true, result: { status: 'passed', finalText: 'done', trace: [{ event: 'x' }] } })) };
    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });
    expect(result.status).toBe('passed');
    expect(transport.send).toHaveBeenCalledWith({ id: 1, method: 'run_task', args: { startUrl: 'http://x', instruction: 'do it', timeoutMs: 60000 } });
  });
  test('returns failed result on bridge error', async () => {
    const transport = { start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined), send: jest.fn(async () => ({ id: 1, ok: false, error: 'missing browser-use' })) };
    const result = await runBrowserUseNativeTask(transport, { id: 'rw', startUrl: 'http://x', goal: 'do it' });
    expect(result.status).toBe('failed');
    expect(result.failureCategory).toMatch(/missing/);
  });
});
