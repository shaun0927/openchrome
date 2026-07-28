/// <reference types="jest" />

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
}));

import { spawn } from 'child_process';
import { MCPClient, MCPResponse } from './mcp-client';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

class FakeChildProcess extends EventEmitter {
  pid = 1571;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly requests: JSONRPCRequest[] = [];
  readonly killSignals: NodeJS.Signals[] = [];
  autoExitOnKill = false;

  constructor() {
    super();
    this.stdin.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) this.requests.push(JSON.parse(line) as JSONRPCRequest);
      }
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.autoExitOnKill) this.exit(null, signal);
    return true;
  }

  emitReady(): void {
    this.stderr.write('[MCPServer] Ready and waiting\n');
  }

  respond(request: JSONRPCRequest, response: Partial<MCPResponse> = {}): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {}, ...response })}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

async function startReadyClient(child: FakeChildProcess, client = new MCPClient()): Promise<MCPClient> {
  mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
  const startup = client.start();
  child.emitReady();
  expect(child.requests).toHaveLength(1);
  expect(child.requests[0].method).toBe('initialize');
  child.respond(child.requests[0]);
  await startup;
  return client;
}

describe('MCPClient lifecycle', () => {
  const originalServerArgs = process.env.OPENCHROME_E2E_SERVER_ARGS;
  const originalCI = process.env.CI;

  beforeEach(() => {
    jest.useFakeTimers();
    mockSpawn.mockReset();
    delete process.env.OPENCHROME_E2E_SERVER_ARGS;
    delete process.env.CI;
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalServerArgs === undefined) delete process.env.OPENCHROME_E2E_SERVER_ARGS;
    else process.env.OPENCHROME_E2E_SERVER_ARGS = originalServerArgs;
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
  });

  test('rejects startup immediately when the child exits before ready and includes bounded stderr', async () => {
    const child = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
    const client = new MCPClient();

    const startup = client.start();
    const failure: Promise<Error> = startup.then(
      () => new Error('Expected startup to reject'),
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    );
    child.stderr.write(`oldest stderr marker${'x'.repeat(5_000)}\nfatal startup detail\n`);
    child.exit(17);

    const error = await failure;
    expect(error.message).toMatch(/Server exited with code 17 before ready[\s\S]*fatal startup detail/);
    expect(error.message).not.toContain('oldest stderr marker');
    expect(jest.getTimerCount()).toBe(0);
    expect(client.isRunning).toBe(false);
  });

  test('rejects an in-flight request promptly when the ready child exits', async () => {
    const child = new FakeChildProcess();
    const client = await startReadyClient(child, new MCPClient({ timeoutMs: 60_000 }));

    const pendingCall = client.send('tools/call', { name: 'slow_tool', arguments: {} });
    const rejection = expect(pendingCall).rejects.toThrow('Server exited with code 9');
    expect(jest.getTimerCount()).toBe(1);

    child.exit(9);

    await rejection;
    expect(jest.getTimerCount()).toBe(0);
    await expect(client.send('tools/list')).rejects.toThrow('MCP client is not running');
  });

  test('terminates the child before rejecting an initialize failure', async () => {
    const child = new FakeChildProcess();
    child.autoExitOnKill = true;
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
    const client = new MCPClient();

    const startup = client.start();
    child.emitReady();
    child.respond(child.requests[0], {
      error: { code: -32_000, message: 'initialize rejected' },
    });

    await expect(startup).rejects.toThrow('Initialize failed: initialize rejected');
    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(client.isRunning).toBe(false);
  });

  test('waits for actual exit after escalating shutdown to SIGKILL', async () => {
    const child = new FakeChildProcess();
    const client = await startReadyClient(child);
    child.stdin.destroy();

    let stopped = false;
    const stopping = client.stop().then(() => { stopped = true; });
    expect(child.killSignals).toEqual(['SIGTERM']);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(stopped).toBe(false);

    child.exit(null, 'SIGKILL');
    await stopping;
    expect(stopped).toBe(true);
    expect(client.isRunning).toBe(false);
  });

  test('does not spawn a replacement until the old process exits', async () => {
    const oldChild = new FakeChildProcess();
    const client = await startReadyClient(oldChild);
    const newChild = new FakeChildProcess();
    mockSpawn.mockReturnValueOnce(newChild as unknown as ChildProcess);

    const restarting = client.restart();
    expect(oldChild.killSignals).toEqual(['SIGKILL']);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    oldChild.exit(null, 'SIGKILL');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    newChild.emitReady();
    newChild.respond(newChild.requests[0]);
    await restarting;
    expect(client.isRunning).toBe(true);
    newChild.exit(0);
  });

  test('passes harness serve args to spawn and clears each request timeout on response', async () => {
    process.env.CI = 'true';
    process.env.OPENCHROME_E2E_SERVER_ARGS = '--server-mode --headless-shell';
    const child = new FakeChildProcess();
    const client = new MCPClient({ args: ['--port', '9444'], timeoutMs: 10_000 });

    await startReadyClient(child, client);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.slice(1)).toEqual([
      'serve',
      '--auto-launch',
      '--server-mode',
      '--headless-shell',
      '--port',
      '9444',
    ]);
    expect(jest.getTimerCount()).toBe(0);

    const responsePromise = client.send('tools/list', {}, 10_000);
    const request = child.requests.at(-1)!;
    expect(jest.getTimerCount()).toBe(1);
    child.respond(request, { result: { tools: [] } });

    await expect(responsePromise).resolves.toMatchObject({ result: { tools: [] } });
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10_000);
    expect(jest.getTimerCount()).toBe(0);
  });
});
