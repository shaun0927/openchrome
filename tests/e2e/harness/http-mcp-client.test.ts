/// <reference types="jest" />

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { ClientRequest, IncomingMessage } from 'http';
import { PassThrough } from 'stream';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));
jest.mock('http', () => ({ request: jest.fn() }));

import { spawn } from 'child_process';
import * as http from 'http';
import { HttpMCPClient } from './http-mcp-client';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockRequest = http.request as jest.MockedFunction<typeof http.request>;

class FakeChildProcess extends EventEmitter {
  pid = 15710;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: NodeJS.Signals[] = [];
  autoExitOnKill = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.autoExitOnKill) this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }
}

class FakeRequest extends EventEmitter {
  destroyed = false;

  constructor(private readonly onEnd?: () => void) {
    super();
  }

  write(): boolean {
    return true;
  }

  end(): this {
    this.onEnd?.();
    return this;
  }

  destroy(error?: Error): this {
    this.destroyed = true;
    if (error) this.emit('error', error);
    return this;
  }
}

function emitJsonResponse(
  callback: (response: IncomingMessage) => void,
  body: Record<string, unknown>,
  statusCode = 200,
): void {
  const response = new EventEmitter() as IncomingMessage;
  response.headers = { 'mcp-session-id': 'session-1' };
  response.statusCode = statusCode;
  callback(response);
  response.emit('data', Buffer.from(JSON.stringify(body)));
  response.emit('end');
}

function mockInitializeResponse(
  body: Record<string, unknown> = { jsonrpc: '2.0', id: 1, result: {} },
): void {
  mockRequest.mockImplementationOnce(((options, callback) => {
    const request = new FakeRequest(() => {
      emitJsonResponse(
        callback as (response: IncomingMessage) => void,
        body,
      );
    });
    return request as unknown as ClientRequest;
  }) as typeof http.request);
}

describe('HttpMCPClient lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSpawn.mockReset();
    mockRequest.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('uses isolated Chrome state and the canonical HTTP readiness log', async () => {
    const child = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
    mockInitializeResponse();
    const client = new HttpMCPClient({
      httpPort: 31_001,
      metricsPort: 33_001,
      cdpPort: 35_001,
      userDataDir: '/tmp/openchrome-http-test',
    });

    const startup = client.start();
    child.stderr.write('[HTTPTransport] Listening on 127.0.0.1:31001\n');
    await startup;

    expect(mockSpawn.mock.calls[0][1]).toEqual([
      expect.stringMatching(/dist\/index\.js$/),
      'serve',
      '--http', '31001',
      '--http-host', '127.0.0.1',
      '--server-mode',
      '--port', '35001',
      '--user-data-dir', '/tmp/openchrome-http-test',
    ]);
    expect(mockSpawn.mock.calls[0][2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP: '1',
        OPENCHROME_HEALTH_PORT: '33001',
      }),
    }));
    expect(client.isRunning).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    child.exit(0);
  });

  test('rejects startup immediately when the server exits before HTTP readiness', async () => {
    const child = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
    const client = new HttpMCPClient({ httpPort: 31_002 });

    const startup = client.start();
    child.stderr.write('chrome startup failed\n');
    child.exit(70);

    await expect(startup).rejects.toThrow(/Server exited with code 70 before ready.*chrome startup failed/);
    expect(client.isRunning).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('terminates the server before rejecting an initialize failure', async () => {
    const child = new FakeChildProcess();
    child.autoExitOnKill = true;
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
    mockInitializeResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32_000, message: 'initialize rejected' },
    });
    const client = new HttpMCPClient({ httpPort: 31_004 });

    const startup = client.start();
    child.stderr.write('[HTTPTransport] Listening on 127.0.0.1:31004\n');

    await expect(startup).rejects.toThrow('Initialize failed: initialize rejected');
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(client.isRunning).toBe(false);
  });

  test('destroys and rejects an active HTTP request when the ready server exits', async () => {
    const child = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
    mockInitializeResponse();
    const client = new HttpMCPClient({ httpPort: 31_003, timeoutMs: 60_000 });

    const startup = client.start();
    child.stderr.write('[HTTPTransport] Listening on 127.0.0.1:31003\n');
    await startup;

    const pendingRequest = new FakeRequest();
    mockRequest.mockReturnValueOnce(pendingRequest as unknown as ClientRequest);
    const pending = client.send('tools/list');
    expect(jest.getTimerCount()).toBe(1);

    child.exit(9);

    await expect(pending).rejects.toThrow(/Server exited with code 9/);
    expect(pendingRequest.destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('rejects HTTP 202 for a JSON-RPC request with an id', async () => {
    const child = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
    mockInitializeResponse();
    const client = new HttpMCPClient({ httpPort: 31_005 });

    const startup = client.start();
    child.stderr.write('[HTTPTransport] Listening on 127.0.0.1:31005\n');
    await startup;

    mockRequest.mockImplementationOnce(((options, callback) => {
      const request = new FakeRequest(() => {
        emitJsonResponse(
          callback as (response: IncomingMessage) => void,
          {},
          202,
        );
      });
      return request as unknown as ClientRequest;
    }) as typeof http.request);

    await expect(client.send('tools/list')).rejects.toThrow(
      'Unexpected HTTP 202 for JSON-RPC request: tools/list',
    );
    child.exit(0);
  });

  test('destroys a timed-out health request and clears its timer', async () => {
    const request = new FakeRequest();
    mockRequest.mockReturnValueOnce(request as unknown as ClientRequest);
    const client = new HttpMCPClient();

    const health = client.getHealth();
    const rejection = expect(health).rejects.toThrow('GET /health timeout (10000ms)');
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(request.destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
