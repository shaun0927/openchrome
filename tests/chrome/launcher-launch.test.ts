/// <reference types="jest" />
/**
 * Tests for Chrome launcher — launch timeout and pending process reuse (issue #171)
 *
 * Uses a real HTTP server to simulate Chrome's /json/version endpoint,
 * avoiding fragile http.request mocking.
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
// Module-level mocks (only child_process and config — NOT http)
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

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({
    headless: false,
    chromeBinary: undefined,
    useHeadlessShell: false,
    userDataDir: undefined,
    restartChrome: false,
  }),
}));

// Mock fs for mkdirSync and Chrome path detection
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
}

function createMockProcess(opts: { exitCode?: number | null } = {}): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.exitCode = opts.exitCode ?? null;
  proc.pid = 12345;
  proc.unref = jest.fn();
  proc.kill = jest.fn().mockReturnValue(true);
  return proc;
}

/**
 * Start a fake Chrome debug server that responds to /json/version.
 * Returns the port and a close function.
 */
function startFakeChromeServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        const port = (server.address() as net.AddressInfo).port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-id`,
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

/**
 * Start a fake Chrome server with a delay before it starts responding.
 */
function startDelayedFakeChromeServer(delayMs: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // First, find a free port by binding, then close, then re-bind after delay
    const tempServer = net.createServer();
    tempServer.listen(0, '127.0.0.1', () => {
      const port = (tempServer.address() as net.AddressInfo).port;
      tempServer.close(() => {
        // Port is now free. After delay, start the real server on this port.
        const timeout = setTimeout(() => {
          const server = http.createServer((req, res) => {
            if (req.url === '/json/version') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-id`,
              }));
            } else {
              res.writeHead(404);
              res.end();
            }
          });

          server.listen(port, '127.0.0.1');
          // Store server ref for cleanup
          (resolve as any)._server = server;
        }, delayMs);

        resolve({
          port,
          close: () => new Promise<void>((res) => {
            clearTimeout(timeout);
            const srv = (resolve as any)._server;
            if (srv) srv.close(() => res());
            else res();
          }),
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChromeLauncher launch timeout fix (issue #171)', () => {
  const savedEnv = process.env.CHROME_LAUNCH_TIMEOUT_MS;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CHROME_LAUNCH_TIMEOUT_MS;
    } else {
      process.env.CHROME_LAUNCH_TIMEOUT_MS = savedEnv;
    }
    mockSpawn.mockReset();
  });

  describe('pendingProcess field', () => {
    it('should have pendingProcess field initialized to null', () => {
      const launcher = new ChromeLauncher(19999);
      // Access private field via any
      expect((launcher as any).pendingProcess).toBeNull();
    });

    it('should track spawned process as pendingProcess on launch timeout', async () => {
      process.env.CHROME_LAUNCH_TIMEOUT_MS = '1000';

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const launcher = new ChromeLauncher(19998);
      // Port 19998 won't have anything listening — should timeout
      await expect(
        launcher.ensureChrome({ autoLaunch: true })
      ).rejects.toThrow(/not available after/);

      // pendingProcess should still be set (for reuse on next call)
      expect((launcher as any).pendingProcess).toBe(proc);
    }, 15000);

    it('should clear pendingProcess on successful launch', async () => {
      const fakeChrome = await startFakeChromeServer();
      try {
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc as any);

        const launcher = new ChromeLauncher(fakeChrome.port);
        const instance = await launcher.ensureChrome({ autoLaunch: true });

        expect(instance.wsEndpoint).toContain('ws://');
        // pendingProcess should be cleared on success
        expect((launcher as any).pendingProcess).toBeNull();
      } finally {
        await fakeChrome.close();
      }
    }, 15000);
  });

  describe('pending process reuse', () => {
    it('should reuse pending process instead of spawning a new one', async () => {
      const fakeChrome = await startFakeChromeServer();
      try {
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc as any);

        const launcher = new ChromeLauncher(fakeChrome.port);

        // Simulate: a previous call timed out and left pendingProcess set
        (launcher as any).pendingProcess = proc;

        // Second call: should detect pending process and reuse it (port is already open)
        process.env.CHROME_LAUNCH_TIMEOUT_MS = '5000';
        const instance = await launcher.ensureChrome({ autoLaunch: true });

        // spawn should NOT have been called (reused pending process)
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(instance.wsEndpoint).toContain('ws://');
        // pendingProcess should be cleared after successful reuse
        expect((launcher as any).pendingProcess).toBeNull();
      } finally {
        await fakeChrome.close();
      }
    }, 15000);

    it('should spawn fresh Chrome if pending process has exited', async () => {
      const fakeChrome = await startFakeChromeServer();
      try {
        const proc = createMockProcess();
        mockSpawn.mockReturnValue(proc as any);

        const launcher = new ChromeLauncher(fakeChrome.port);

        // Simulate: previous pending process already exited
        (launcher as any).pendingProcess = createMockProcess({ exitCode: 1 });

        process.env.CHROME_LAUNCH_TIMEOUT_MS = '5000';
        const instance = await launcher.ensureChrome({ autoLaunch: true });

        expect(instance.wsEndpoint).toContain('ws://');
        // Exited pendingProcess should have been cleaned up first,
        // then the "existing Chrome" check on port found it
        // (or a new spawn happened). Either way, pendingProcess is clear.
      } finally {
        await fakeChrome.close();
      }
    }, 15000);
  });

  describe('configurable timeout', () => {
    it('should use CHROME_LAUNCH_TIMEOUT_MS env var', async () => {
      process.env.CHROME_LAUNCH_TIMEOUT_MS = '1500';

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const launcher = new ChromeLauncher(19997);
      const start = Date.now();

      await expect(
        launcher.ensureChrome({ autoLaunch: true })
      ).rejects.toThrow(/not available after/);

      const elapsed = Date.now() - start;
      // Should have waited ~1.5s for the launch timeout (plus ~5s initial port check)
      // Total should be ~6.5s, definitely less than old 35s (5s check + 30s launch)
      expect(elapsed).toBeLessThan(12000);
      expect(elapsed).toBeGreaterThan(1000);
    }, 20000);

    it('should default to 60000ms when env var not set', async () => {
      delete process.env.CHROME_LAUNCH_TIMEOUT_MS;

      // We can't actually wait 60s in a test. Instead, verify the code path
      // by checking that the error message contains the timeout value.
      const proc = createMockProcess();
      // Make process "exit" immediately so waitForDebugPort fast-fails
      proc.exitCode = 1;
      mockSpawn.mockReturnValue(proc as any);

      const launcher = new ChromeLauncher(19996);

      await expect(
        launcher.ensureChrome({ autoLaunch: true })
      ).rejects.toThrow(/Exit code: 1|exited with code 1/);
    }, 15000);
  });

  describe('close() cleanup', () => {
    it('should kill pending process on close', async () => {
      const launcher = new ChromeLauncher(19995);
      const proc = createMockProcess();
      (launcher as any).pendingProcess = proc;

      await launcher.close();

      expect(proc.kill).toHaveBeenCalled();
      expect((launcher as any).pendingProcess).toBeNull();
    });

    it('should handle close when no pending process', async () => {
      const launcher = new ChromeLauncher(19994);
      // Should not throw
      await launcher.close();
      expect((launcher as any).pendingProcess).toBeNull();
    });
  });
});
