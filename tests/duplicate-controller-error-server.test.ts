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
    expect(String(note.params.data)).toContain('another session');
    expect(note.id).toBeUndefined(); // notification has no id
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
});
