/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));

import { MCPServer } from '../../src/mcp-server';
import { getSessionManager } from '../../src/session-manager';
import { clearBatchIdempotencyCachesForTests, registerBatchExecuteTool } from '../../src/tools/batch-execute';

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
