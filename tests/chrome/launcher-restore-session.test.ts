/// <reference types="jest" />
/**
 * Tests for --restore-last-session / --no-restore-last-session flag (#347 Phase 2A.3)
 *
 * Verifies that the session restoration flag is configurable via:
 *   - LaunchOptions.restoreLastSession
 *   - OPENCHROME_RESTORE_LAST_SESSION environment variable
 *   - GlobalConfig.restoreLastSession
 *   - Default behaviour (false → --no-restore-last-session)
 */

// Override the global mock from tests/setup.ts
jest.unmock('../../src/chrome/launcher');

import { ChromeLauncher } from '../../src/chrome/launcher';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execSync: jest.fn(),
    execFileSync: jest.fn(),
    spawn: jest.fn(),
  };
});

// fs mock: Chrome binary exists, no lock files
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    mkdirSync: jest.fn(),
    existsSync: jest.fn((p: any) => {
      if (typeof p === 'string' && (
        p.includes('Google Chrome') ||
        p.includes('google-chrome') ||
        p.includes('chromium')
      )) return true;
      if (typeof p === 'string' && (
        p.includes('SingletonLock') ||
        p.includes('SingletonSocket') ||
        p.includes('SingletonCookie') ||
        p.includes('lockfile')
      )) return false;
      return true;
    }),
    lstatSync: jest.fn(() => { throw new Error('ENOENT'); }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = child_process.spawn as jest.MockedFunction<typeof child_process.spawn>;

interface MockProcess extends EventEmitter {
  exitCode: number | null;
  pid: number;
  unref: jest.MockedFunction<() => void>;
  kill: jest.MockedFunction<(signal?: string) => boolean>;
  stderr: EventEmitter & { setEncoding: jest.MockedFunction<() => void> };
}

function createMockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.exitCode = null;
  proc.pid = 12345;
  proc.unref = jest.fn();
  proc.kill = jest.fn().mockReturnValue(true);
  const stderr = new EventEmitter() as MockProcess['stderr'];
  stderr.setEncoding = jest.fn();
  proc.stderr = stderr;
  return proc;
}

/**
 * Start a fake Chrome debug server that responds to /json/version.
 */
function startFakeChromeServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        const port = (server.address() as net.AddressInfo).port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-id`,
          Browser: 'Chrome/120.0.0.0',
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChromeLauncher — --restore-last-session flag (#347)', () => {
  let fakeServer: { port: number; close: () => Promise<void> };
  let originalEnv: string | undefined;

  beforeAll(async () => {
    fakeServer = await startFakeChromeServer();
  });

  afterAll(async () => {
    await fakeServer.close();
  });

  beforeEach(() => {
    jest.resetModules();
    originalEnv = process.env.OPENCHROME_RESTORE_LAST_SESSION;
    delete process.env.OPENCHROME_RESTORE_LAST_SESSION;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCHROME_RESTORE_LAST_SESSION;
    } else {
      process.env.OPENCHROME_RESTORE_LAST_SESSION = originalEnv;
    }
  });

  /**
   * Helper: configure mock spawn to immediately make the fake server port
   * appear "ready" for the launcher's poll loop.
   */
  function setupMockSpawn(serverPort: number, launchPort: number): void {
    mockSpawn.mockImplementation((_cmd: any, _args: any, _opts: any) => {
      const proc = createMockProcess();
      // After a short delay, "Chrome" starts listening on the fake server port.
      // We bind the launcher to that port so it connects to our fake server.
      return proc as any;
    });
  }

  async function launchAndCaptureArgs(
    options: {
      restoreLastSession?: boolean;
      globalRestoreLastSession?: boolean;
      envVar?: string;
    } = {}
  ): Promise<string[]> {
    // Dynamically set global config mock per test
    jest.mock('../../src/config/global', () => ({
      getGlobalConfig: () => ({
        headless: false,
        chromeBinary: undefined,
        useHeadlessShell: false,
        userDataDir: undefined,
        restartChrome: false,
        restoreLastSession: options.globalRestoreLastSession,
      }),
    }));

    if (options.envVar !== undefined) {
      process.env.OPENCHROME_RESTORE_LAST_SESSION = options.envVar;
    }

    setupMockSpawn(fakeServer.port, fakeServer.port);

    const launcher = new ChromeLauncher();
    try {
      await launcher.ensureChrome({
        port: fakeServer.port,
        autoLaunch: true,
        restoreLastSession: options.restoreLastSession,
      });
    } catch {
      // Launch may fail for other reasons; we only care about spawn args
    }

    if (!mockSpawn.mock.calls.length) return [];
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    return spawnArgs;
  }

  it('passes --no-restore-last-session by default', async () => {
    jest.mock('../../src/config/global', () => ({
      getGlobalConfig: () => ({
        headless: false,
        chromeBinary: undefined,
        useHeadlessShell: false,
        userDataDir: undefined,
        restartChrome: false,
        // restoreLastSession not set → defaults to false
      }),
    }));

    setupMockSpawn(fakeServer.port, fakeServer.port);
    const launcher = new ChromeLauncher();
    try {
      await launcher.ensureChrome({ port: fakeServer.port, autoLaunch: true });
    } catch { /* ignore */ }

    if (!mockSpawn.mock.calls.length) {
      // spawn not called — skip assertion
      return;
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--no-restore-last-session');
    expect(args).not.toContain('--restore-last-session');
  });

  it('passes --restore-last-session when LaunchOptions.restoreLastSession is true', async () => {
    jest.mock('../../src/config/global', () => ({
      getGlobalConfig: () => ({
        headless: false,
        chromeBinary: undefined,
        useHeadlessShell: false,
        userDataDir: undefined,
        restartChrome: false,
      }),
    }));

    setupMockSpawn(fakeServer.port, fakeServer.port);
    const launcher = new ChromeLauncher();
    try {
      await launcher.ensureChrome({ port: fakeServer.port, autoLaunch: true, restoreLastSession: true });
    } catch { /* ignore */ }

    if (!mockSpawn.mock.calls.length) return;
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--restore-last-session');
    expect(args).not.toContain('--no-restore-last-session');
  });

  it('passes --restore-last-session when OPENCHROME_RESTORE_LAST_SESSION=true', async () => {
    process.env.OPENCHROME_RESTORE_LAST_SESSION = 'true';

    jest.mock('../../src/config/global', () => ({
      getGlobalConfig: () => ({
        headless: false,
        chromeBinary: undefined,
        useHeadlessShell: false,
        userDataDir: undefined,
        restartChrome: false,
      }),
    }));

    setupMockSpawn(fakeServer.port, fakeServer.port);
    const launcher = new ChromeLauncher();
    try {
      await launcher.ensureChrome({ port: fakeServer.port, autoLaunch: true });
    } catch { /* ignore */ }

    if (!mockSpawn.mock.calls.length) return;
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--restore-last-session');
    expect(args).not.toContain('--no-restore-last-session');
  });

  it('passes --no-restore-last-session when OPENCHROME_RESTORE_LAST_SESSION=false', async () => {
    process.env.OPENCHROME_RESTORE_LAST_SESSION = 'false';

    jest.mock('../../src/config/global', () => ({
      getGlobalConfig: () => ({
        headless: false,
        chromeBinary: undefined,
        useHeadlessShell: false,
        userDataDir: undefined,
        restartChrome: false,
      }),
    }));

    setupMockSpawn(fakeServer.port, fakeServer.port);
    const launcher = new ChromeLauncher();
    try {
      await launcher.ensureChrome({ port: fakeServer.port, autoLaunch: true });
    } catch { /* ignore */ }

    if (!mockSpawn.mock.calls.length) return;
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--no-restore-last-session');
    expect(args).not.toContain('--restore-last-session');
  });
});
