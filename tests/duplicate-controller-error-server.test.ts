import { PassThrough } from 'stream';
import {
  DUPLICATE_CONTROLLER_ERROR_CODE,
  DuplicateControllerErrorServer,
} from '../src/transports/duplicate-controller-error-server';
import { DuplicateControllerError, type ControllerLockMetadata } from '../src/utils/controller-lock';

function makeServer(): DuplicateControllerErrorServer {
  const owner: ControllerLockMetadata = {
    pid: 95061,
    command: ['node', 'dist/index.js', 'serve', '--auto-launch'],
    version: '1.12.7',
    cwd: '/home/u/repo',
    port: 9222,
    userDataDir: '/home/u/.openchrome/profile',
    startedAt: '2026-06-05T00:00:00.000Z',
    lastHeartbeatAt: '2026-06-05T00:00:00.000Z',
    hostname: 'host',
  };
  return new DuplicateControllerErrorServer(
    new DuplicateControllerError('/home/u/.openchrome/locks/port-9222.json', owner),
  );
}

function parseFrames(server: DuplicateControllerErrorServer, line: string): any[] {
  return server.handleLine(line).map((f) => JSON.parse(f));
}

describe('DuplicateControllerErrorServer (#1474)', () => {
  test('completes the initialize handshake instead of failing it', () => {
    const frames = parseFrames(makeServer(), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    const init = frames.find((f) => f.id === 1);
    expect(init.result.serverInfo.name).toBe('openchrome');
    expect(init.result.protocolVersion).toBe('2024-11-05');
    expect(init.error).toBeUndefined();
  });

  test('pushes a logging notification carrying the remediation after initialize', () => {
    const frames = parseFrames(makeServer(), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    const note = frames.find((f) => f.method === 'notifications/message');
    expect(note).toBeDefined();
    expect(note.params.level).toBe('error');
    // data is a structured object (spec), not a bare string.
    expect(note.params.data.message).toContain('another session');
    expect(note.params.data.remediation.reason).toBe('duplicate_controller');
    expect(note.id).toBeUndefined(); // notification has no id
  });

  test('responds to ping with an empty result (keepalive must not error)', () => {
    const frames = parseFrames(makeServer(), JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
    expect(frames[0].id).toBe(7);
    expect(frames[0].result).toEqual({});
    expect(frames[0].error).toBeUndefined();
  });

  test('handles a JSON-RPC batch: array of responses + the server notification', () => {
    const out = makeServer().handleLine(JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' }, // notification → no response member
    ]));
    const parsed = out.map((f) => JSON.parse(f));
    const batch = parsed.find((f) => Array.isArray(f)) as any[] | undefined;
    expect(batch).toBeDefined();
    expect((batch as any[]).map((r: any) => r.id).sort()).toEqual([1, 2]); // only the two requests
    // the server-originated logging notification is emitted as its own frame
    expect(parsed.some((f) => !Array.isArray(f) && f.method === 'notifications/message')).toBe(true);
  });

  test('an explicit id:null request still gets a reply (not treated as a notification)', () => {
    const frames = parseFrames(makeServer(), JSON.stringify({ jsonrpc: '2.0', id: null, method: 'resources/list' }));
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBeNull();
    expect(frames[0].error.code).toBe(DUPLICATE_CONTROLLER_ERROR_CODE);
  });

  test('an empty batch is rejected as an invalid request', () => {
    const frames = parseFrames(makeServer(), '[]');
    expect(frames[0].error.code).toBe(-32600);
  });

  test('non-object JSON does not crash — returns Invalid Request', () => {
    // valid JSON that is not a JSON-RPC object would make `'id' in message`
    // throw a TypeError (process crash) without the guard.
    for (const line of ['null', '5', '"hello"', 'true']) {
      const frames = parseFrames(makeServer(), line);
      expect(frames[0].error.code).toBe(-32600);
      expect(frames[0].id).toBeNull();
    }
  });

  test('a batch member that is a non-object yields an Invalid Request response', () => {
    const out = makeServer().handleLine(JSON.stringify([1, { jsonrpc: '2.0', id: 2, method: 'ping' }]));
    const batch = JSON.parse(out[0]);
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.some((r: any) => r.error?.code === -32600)).toBe(true); // the bare `1`
    expect(batch.some((r: any) => r.id === 2 && r.result)).toBe(true); // the ping
  });

  test('init-timeout exits(2) when an open non-MCP stdin never sends initialize', () => {
    jest.useFakeTimers();
    const input = new PassThrough(); // open, never emits a line, never closes
    try {
      const exit = jest.fn();
      const owner: ControllerLockMetadata = {
        pid: 1, command: [], version: 'x', cwd: '', port: 9222,
        userDataDir: '/p', startedAt: 't', lastHeartbeatAt: 't', hostname: 'h',
      };
      const server = new DuplicateControllerErrorServer(
        new DuplicateControllerError('/l', owner),
        { exit, initTimeoutMs: 5_000 },
      );
      server.start(input);
      jest.advanceTimersByTime(5_000);
      expect(exit).toHaveBeenCalledWith(2);
    } finally {
      input.end();
      jest.useRealTimers();
    }
  });

  test('lists a single diagnostic tool that names the conflict', () => {
    const frames = parseFrames(makeServer(), JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(frames[0].result.tools).toHaveLength(1);
    expect(frames[0].result.tools[0].name).toBe('openchrome_owner_conflict');
    expect(frames[0].result.tools[0].description).toContain('port 9222');
  });

  test('tools/call returns the remediation as a tool error with structured content', () => {
    const frames = parseFrames(makeServer(), JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'openchrome_owner_conflict' },
    }));
    expect(frames[0].result.isError).toBe(true);
    expect(frames[0].result.content[0].text).toContain('another session');
    expect(frames[0].result.structuredContent.reason).toBe('duplicate_controller');
    expect(frames[0].result.structuredContent.remediations.join(' ')).toContain('--connect-broker');
  });

  test('other requests get a structured JSON-RPC error (not a bare code)', () => {
    const frames = parseFrames(makeServer(), JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' }));
    expect(frames[0].error.code).toBe(DUPLICATE_CONTROLLER_ERROR_CODE);
    expect(frames[0].error.message).toContain('OpenChrome is unavailable');
    expect(frames[0].error.data.ownerPid).toBe(95061);
    expect(frames[0].error.data.lockPath).toContain('port-9222');
  });

  test('notifications (no id) get no reply', () => {
    expect(makeServer().handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toEqual([]);
  });

  test('malformed JSON yields a parse error with null id', () => {
    const frames = parseFrames(makeServer(), '{not json');
    expect(frames[0].id).toBeNull();
    expect(frames[0].error.code).toBe(-32700);
  });

  test('blank lines are ignored', () => {
    expect(makeServer().handleLine('   ')).toEqual([]);
  });

  test('exits with failure (2) when stdin closes without an MCP handshake', () => {
    // e.g. `serve --auto-launch </dev/null` from CI/systemd: non-TTY, immediate
    // EOF, no initialize. Must report refusal-to-start, not silent success.
    expect(makeServer().closeExitCode()).toBe(2);
  });

  test('exits cleanly (0) after a real MCP client handshook and disconnected', () => {
    const server = makeServer();
    server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    expect(server.closeExitCode()).toBe(0);
  });
});
