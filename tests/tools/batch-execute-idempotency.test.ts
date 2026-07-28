/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));

import { MCPServer } from '../../src/mcp-server';
import { getSessionManager } from '../../src/session-manager';
import { clearBatchIdempotencyCachesForTests, registerBatchExecuteTool } from '../../src/tools/batch-execute';
import { addTimeoutResponseGraceMs } from '../../src/utils/with-timeout';

const mockSend = jest.fn();
const page = {
  waitForSelector: jest.fn().mockResolvedValue(undefined),
  waitForFunction: jest.fn().mockResolvedValue(undefined),
  waitForNavigation: jest.fn().mockResolvedValue(undefined),
};

function makeHandler(): Function {
  (getSessionManager as jest.Mock).mockReturnValue({
    getCDPClient: () => ({ send: mockSend }),
    getPage: jest.fn().mockResolvedValue(page),
  });
  const server = new MCPServer({} as any);
  registerBatchExecuteTool(server);
  return server.getToolHandler('batch_execute')!;
}

function ok(value: unknown) {
  return { result: { type: 'string', value: JSON.stringify(value) } };
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('batch_execute idempotency and inter-item waits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearBatchIdempotencyCachesForTests();
    delete process.env.OPENCHROME_BATCH_IDEMPOTENCY_TTL_MS;
    delete process.env.OPENCHROME_BATCH_IDEMPOTENCY_MAX;
    mockSend.mockResolvedValue(ok({ value: 'ran' }));
  });

  test('idempotency hit returns cached success without re-executing script', async () => {
    const handler = makeHandler();
    const args = {
      concurrency: 1,
      tasks: [{ tabId: 'tab-1', script: 'window.count++', idempotencyKey: 'step-A' }],
    };

    const first = parse(await handler('session-1', args));
    const second = parse(await handler('session-1', args));

    expect(first.results[0]).toMatchObject({ success: true, data: { value: 'ran' } });
    expect(second.results[0]).toMatchObject({ success: true, skipped: 'idempotent', data: { value: 'ran' } });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('an aborted request does not return a cached idempotent success', async () => {
    const handler = makeHandler();
    const args = {
      concurrency: 1,
      tasks: [{ tabId: 'tab-1', script: 'window.count++', idempotencyKey: 'step-aborted' }],
    };

    const first = parse(await handler('session-1', args));
    const controller = new AbortController();
    controller.abort(new Error('client disconnected'));
    const second = parse(await handler(
      'session-1',
      args,
      { startTime: Date.now(), deadlineMs: 5_000, signal: controller.signal },
    ));

    expect(first.results[0]).toMatchObject({ success: true, data: { value: 'ran' } });
    expect(second.results[0]).toMatchObject({ success: false });
    expect(second.results[0].error).toContain('client disconnected');
    expect(second.results[0].skipped).toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('failed prior run is not cached', async () => {
    mockSend
      .mockResolvedValueOnce({ exceptionDetails: { text: 'boom' }, result: { type: 'undefined' } })
      .mockResolvedValueOnce(ok({ value: 'retry-ok' }));
    const handler = makeHandler();
    const args = { concurrency: 1, tasks: [{ tabId: 'tab-1', script: 'mayFail()', idempotencyKey: 'step-B' }] };

    const first = parse(await handler('session-1', args));
    const second = parse(await handler('session-1', args));

    expect(first.results[0].success).toBe(false);
    expect(second.results[0]).toMatchObject({ success: true, data: { value: 'retry-ok' } });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('forwards each task timeout with renderer response grace', async () => {
    const handler = makeHandler();

    await handler('session-1', {
      concurrency: 1,
      tasks: [
        { tabId: 'tab-1', script: '1', timeout: 250 },
        { tabId: 'tab-1', script: '2', timeout: 500 },
      ],
    });

    expect(mockSend).toHaveBeenNthCalledWith(
      1,
      page,
      'Runtime.evaluate',
      expect.objectContaining({ expression: '1', timeout: 250 }),
      expect.objectContaining({
        timeoutMs: addTimeoutResponseGraceMs(250),
        reserveRuntimeEvaluateResponseGrace: true,
      }),
    );
    expect(mockSend).toHaveBeenNthCalledWith(
      2,
      page,
      'Runtime.evaluate',
      expect.objectContaining({ expression: '2', timeout: 500 }),
      expect.objectContaining({
        timeoutMs: addTimeoutResponseGraceMs(500),
        reserveRuntimeEvaluateResponseGrace: true,
      }),
    );
  });

  test('caps a task timeout to the remaining parent budget', async () => {
    const handler = makeHandler();

    const startTime = Date.now() - 750;
    await handler(
      'session-1',
      { concurrency: 1, tasks: [{ tabId: 'tab-1', script: '1', timeout: 5_000 }] },
      { startTime, deadlineMs: 1_000 },
    );

    const params = mockSend.mock.calls[0][2];
    const options = mockSend.mock.calls[0][3];
    expect(params.timeout).toBe(5_000);
    expect(options).toMatchObject({
      timeoutMs: addTimeoutResponseGraceMs(5_000),
      deadlineAt: startTime + 1_000,
      reserveRuntimeEvaluateResponseGrace: true,
    });
  });

  test('shares one task timeout window with Runtime.awaitPromise formatting', async () => {
    jest.useFakeTimers({ now: 10_000 });
    try {
      const handler = makeHandler();
      mockSend
        .mockImplementationOnce(() => new Promise((resolve) => {
          setTimeout(() => resolve({
            result: {
              type: 'object',
              subtype: 'promise',
              className: 'Promise',
              description: 'Promise',
              objectId: 'pending-batch-promise',
            },
          }), 250);
        }))
        .mockImplementationOnce(() => new Promise(() => {}));

      let settled = false;
      const resultPromise = handler('session-1', {
        concurrency: 1,
        tasks: [{ tabId: 'tab-1', script: 'new Promise(() => {})', timeout: 250 }],
      }).then((result: unknown) => {
        settled = true;
        return parse(result);
      });

      await jest.advanceTimersByTimeAsync(299);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(2);

      const result = await resultPromise;
      expect(result.results[0]).toMatchObject({ success: false });
      expect(result.results[0].error).toContain('Promise resolution timed out');
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][3].deadlineAt).toBe(10_300);
      expect(mockSend.mock.calls[1][3].deadlineAt).toBe(10_300);
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not dispatch tasks when the request is already aborted', async () => {
    const handler = makeHandler();
    const controller = new AbortController();
    controller.abort(new Error('client disconnected'));

    const result = parse(await handler(
      'session-1',
      {
        concurrency: 2,
        tasks: [
          { tabId: 'tab-1', script: 'window.__first = true' },
          { tabId: 'tab-1', script: 'window.__second = true' },
        ],
      },
      { startTime: Date.now(), deadlineMs: 5_000, signal: controller.signal },
    ));

    expect(result.results).toHaveLength(2);
    expect(result.results.every((item: { success: boolean }) => item.success === false)).toBe(true);
    expect(result.results[0].error).toContain('client disconnected');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('stops queued tasks when the request aborts during execution', async () => {
    const handler = makeHandler();
    const controller = new AbortController();
    mockSend.mockReturnValueOnce(new Promise(() => {}));

    const resultPromise = handler(
      'session-1',
      {
        concurrency: 1,
        tasks: [
          { tabId: 'tab-1', script: 'while (true) {}' },
          { tabId: 'tab-1', script: 'window.__shouldNotRun = true' },
        ],
      },
      { startTime: Date.now(), deadlineMs: 5_000, signal: controller.signal },
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSend).toHaveBeenCalledTimes(1);
    controller.abort(new Error('client disconnected'));

    const result = parse(await resultPromise);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[1]).toMatchObject({ success: false });
    expect(result.results[1].error).toContain('client disconnected');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('does not dispatch a queued task after the shared parent deadline expires', async () => {
    jest.useFakeTimers({ now: 10_000 });
    try {
      const handler = makeHandler();
      mockSend
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementationOnce(() => new Promise(() => {}));

      const resultPromise = handler(
        'session-1',
        {
          concurrency: 2,
          tasks: [
            { tabId: 'tab-1', script: '1', timeout: 5_000 },
            { tabId: 'tab-1', script: '2', timeout: 5_000 },
            { tabId: 'tab-1', script: '3', timeout: 5_000 },
          ],
        },
        { startTime: Date.now(), deadlineMs: 1_000 },
      );

      await jest.advanceTimersByTimeAsync(0);
      expect(mockSend).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1_001);

      const result = parse(await resultPromise);
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(result.results[2]).toMatchObject({ success: false });
      expect(result.results[2].error).toContain('deadline exceeded');
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not dispatch a task after the parent budget is exhausted', async () => {
    const handler = makeHandler();

    const result = parse(await handler(
      'session-1',
      { concurrency: 1, tasks: [{ tabId: 'tab-1', script: 'window.__shouldNotRun = true' }] },
      { startTime: Date.now() - 2_000, deadlineMs: 1_000 },
    ));

    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[0].error).toContain('deadline exceeded');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('rejects a negative task timeout without dispatching or caching it', async () => {
    const handler = makeHandler();
    const args = {
      concurrency: 1,
      tasks: [{
        tabId: 'tab-1',
        script: 'window.__shouldNotRun = true',
        timeout: -1,
        idempotencyKey: 'invalid-timeout',
      }],
    };

    const first = parse(await handler('session-1', args));
    const second = parse(await handler('session-1', args));

    expect(first.results[0]).toMatchObject({ success: false });
    expect(first.results[0].error).toContain('positive finite number');
    expect(second.results[0]).toMatchObject({ success: false });
    expect(second.results[0].skipped).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('does not add package dependencies for idempotency support', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json');
    expect(pkg.dependencies?.['lru-cache']).toBeUndefined();
    expect(pkg.devDependencies?.['lru-cache']).toBeUndefined();
  });

  test('inter-item wait rejects concurrency above one before executing', async () => {
    const handler = makeHandler();
    const result = await handler('session-1', {
      concurrency: 2,
      tasks: [{ tabId: 'tab-1', script: '1', interItemWaitMs: 10 }],
    });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toBe('invalid_input');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('sequential interItemWaitFor runs between sibling items', async () => {
    const handler = makeHandler();
    const result = parse(await handler('session-1', {
      concurrency: 1,
      tasks: [
        { tabId: 'tab-1', script: 'click()', interItemWaitFor: { type: 'function', value: 'window.__ready === true', pollIntervalMs: 100 } },
        { tabId: 'tab-1', script: 'read()' },
      ],
    }));

    expect(result.results[0].wait).toMatchObject({ success: true, type: 'function' });
    expect(page.waitForFunction).toHaveBeenCalledWith('window.__ready === true', { timeout: 30000, polling: 100 });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('aborts an in-flight inter-item delay without starting the next task', async () => {
    const handler = makeHandler();
    const controller = new AbortController();

    const resultPromise = handler(
      'session-1',
      {
        concurrency: 1,
        tasks: [
          { tabId: 'tab-1', script: 'click()', interItemWaitMs: 10_000 },
          { tabId: 'tab-1', script: 'read()' },
        ],
      },
      { startTime: Date.now(), deadlineMs: 30_000, signal: controller.signal },
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSend).toHaveBeenCalledTimes(1);
    controller.abort(new Error('client disconnected'));

    const result = parse(await resultPromise);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[0].error).toContain('client disconnected');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('caps interItemWaitFor to the remaining parent deadline', async () => {
    jest.useFakeTimers({ now: 10_000 });
    try {
      const handler = makeHandler();
      page.waitForFunction.mockImplementationOnce(() => new Promise(() => {}));

      const resultPromise = handler(
        'session-1',
        {
          concurrency: 1,
          tasks: [
            {
              tabId: 'tab-1',
              script: 'click()',
              interItemWaitFor: { type: 'function', value: 'window.__ready === true', timeout: 30_000 },
            },
            { tabId: 'tab-1', script: 'read()' },
          ],
        },
        { startTime: Date.now(), deadlineMs: 100 },
      );

      await jest.advanceTimersByTimeAsync(0);
      expect(page.waitForFunction).toHaveBeenCalledWith(
        'window.__ready === true',
        expect.objectContaining({ timeout: 100 }),
      );
      await jest.advanceTimersByTimeAsync(101);

      const result = parse(await resultPromise);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ success: false });
      expect(result.results[0].error).toContain('deadline exceeded');
      expect(mockSend).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('failed interItemWaitFor stops before the next sibling starts', async () => {
    page.waitForFunction.mockRejectedValueOnce(new Error('not ready'));
    const handler = makeHandler();
    const result = parse(await handler('session-1', {
      concurrency: 1,
      tasks: [
        { tabId: 'tab-1', script: 'click()', interItemWaitFor: { type: 'function', value: 'window.__ready === true', pollIntervalMs: 100 } },
        { tabId: 'tab-1', script: 'read()' },
      ],
    }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      success: false,
      error: 'interItemWaitFor failed: not ready',
      wait: { success: false, type: 'function', error: 'not ready' },
    });
    expect(result.summary).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

});
