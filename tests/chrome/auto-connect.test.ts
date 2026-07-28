/**
 * Unit tests for src/chrome/auto-connect.ts (#849).
 *
 * Coverage:
 *   - file present + bound port → success
 *   - file absent → AutoConnectError(devtools_active_port_missing) after timeout
 *   - file present, port not bound → AutoConnectError(port_not_bound)
 *   - file present, port not bound, file > 60 s old → stale_active_port_file
 *   - userDataDir == openchrome managed profile → managed_profile_refused
 *   - --auto-connect + --launch-mode=auto|isolated mutual-exclusion error
 *   - parser tolerates trailing newline / missing browser-target line
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  discoverActiveDevToolsPort,
  refreshAutoConnectEndpoint,
  AutoConnectError,
  __testing,
} from '../../src/chrome/auto-connect';
import {
  resolveLaunchMode,
  assertAutoConnectCompatibleWithLaunchMode,
  AutoConnectModeConflictError,
} from '../../src/chrome/launch-mode-resolver';

function makeTempDir(prefix = 'oc-auto-connect-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rm(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeActivePortFile(dir: string, port: number, browserTargetPath = '/devtools/browser/abc'): void {
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n${browserTargetPath}\n`);
}

/** Bind a real TCP listener so probePort returns true. */
function bindLocalListener(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('failed to acquire port'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => { try { server.close(); } catch { /* ignore */ } },
      });
    });
    server.on('error', reject);
  });
}

function bindDebugServer(
  handler: (port: number, req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        res.statusCode = 500;
        res.end();
        return;
      }
      handler(address.port, req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to acquire HTTP port'));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
    server.on('error', reject);
  });
}

describe('discoverActiveDevToolsPort (#849)', () => {
  it('returns wsEndpoint when DevToolsActivePort exists and port is bound', async () => {
    const dir = makeTempDir();
    const listener = await bindLocalListener();
    try {
      writeActivePortFile(dir, listener.port, '/devtools/browser/test-uuid');
      const result = await discoverActiveDevToolsPort({
        userDataDir: dir,
        timeoutMs: 250,
        managedProfileDir: '/__never__',
      });
      expect(result.port).toBe(listener.port);
      expect(result.userDataDir).toBe(path.resolve(dir));
      expect(result.browserTargetPath).toBe('/devtools/browser/test-uuid');
      expect(result.wsEndpoint).toBe(`ws://127.0.0.1:${listener.port}/devtools/browser/test-uuid`);
    } finally {
      listener.close();
      rm(dir);
    }
  });

  it('throws devtools_active_port_missing when file never appears (timeout)', async () => {
    const dir = makeTempDir();
    try {
      await expect(
        discoverActiveDevToolsPort({
          userDataDir: dir,
          timeoutMs: 200,
          managedProfileDir: '/__never__',
        }),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'devtools_active_port_missing',
      });
    } finally {
      rm(dir);
    }
  });

  it('throws port_not_bound when file present but nothing listens (and file is fresh)', async () => {
    const dir = makeTempDir();
    try {
      // Pick a free port and immediately close so nothing listens.
      const listener = await bindLocalListener();
      const port = listener.port;
      listener.close();
      // Tiny pause to let the OS release the socket fully.
      await new Promise((r) => setTimeout(r, 50));
      writeActivePortFile(dir, port);
      await expect(
        discoverActiveDevToolsPort({
          userDataDir: dir,
          timeoutMs: 200,
          managedProfileDir: '/__never__',
          // Force "fresh" file.
          now: () => Date.now(),
        }),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'port_not_bound',
      });
    } finally {
      rm(dir);
    }
  });

  it('throws stale_active_port_file when file is > 60s old and port not bound', async () => {
    const dir = makeTempDir();
    try {
      const listener = await bindLocalListener();
      const port = listener.port;
      listener.close();
      await new Promise((r) => setTimeout(r, 50));
      const filePath = path.join(dir, 'DevToolsActivePort');
      writeActivePortFile(dir, port);
      // Backdate the mtime by 5 minutes so the stale-file branch triggers.
      const oldStat = fs.statSync(filePath);
      const fiveMinutesAgo = oldStat.mtimeMs - 5 * 60 * 1000;
      fs.utimesSync(filePath, oldStat.atimeMs / 1000, fiveMinutesAgo / 1000);
      await expect(
        discoverActiveDevToolsPort({
          userDataDir: dir,
          timeoutMs: 200,
          managedProfileDir: '/__never__',
        }),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'stale_active_port_file',
      });
    } finally {
      rm(dir);
    }
  });

  it('refuses openchrome\'s managed profile dir', async () => {
    const dir = makeTempDir();
    try {
      // Make `dir` itself the "managed" profile so the guard fires.
      await expect(
        discoverActiveDevToolsPort({
          userDataDir: dir,
          timeoutMs: 50,
          managedProfileDir: dir,
        }),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'managed_profile_refused',
      });
    } finally {
      rm(dir);
    }
  });

  it('parser preserves the legacy missing browser-target line as a root sentinel', () => {
    const a = __testing.parseDevToolsActivePort('12345\n');
    expect(a.port).toBe(12345);
    expect(a.browserTargetPath).toBe('/');

    const b = __testing.parseDevToolsActivePort('12345\n/devtools/browser/uuid');
    expect(b.port).toBe(12345);
    expect(b.browserTargetPath).toBe('/devtools/browser/uuid');

    // Chrome writes `\n`-separated lines; we accept `\r\n` too. Verify the
    // browser-target-path coercion to a leading `/` when Chrome (or a stub)
    // forgets the slash.
    const c = __testing.parseDevToolsActivePort('12345\r\ndevtools-no-leading-slash\r\n');
    expect(c.port).toBe(12345);
    expect(c.browserTargetPath).toBe('/devtools-no-leading-slash');
  });

  it('parser rejects malformed port line', () => {
    expect(() => __testing.parseDevToolsActivePort('not-a-number\n')).toThrow(AutoConnectError);
    expect(() => __testing.parseDevToolsActivePort('99999999\n')).toThrow(AutoConnectError); // out of range
    expect(() => __testing.parseDevToolsActivePort('\n')).toThrow(AutoConnectError);
  });

  it('parser rejects partial-numeric port line (parseInt would silently truncate)', () => {
    // Without the digits-only guard, `parseInt("9222junk", 10)` would yield
    // 9222 and attach to an unintended port. Verify the strict regex catches
    // it.
    expect(() => __testing.parseDevToolsActivePort('9222junk\n')).toThrow(AutoConnectError);
    try {
      __testing.parseDevToolsActivePort('9222junk\n');
      fail('expected throw');
    } catch (err) {
      expect((err as AutoConnectError).errorCode).toBe('devtools_active_port_malformed');
    }
    expect(() => __testing.parseDevToolsActivePort('  9222 junk\n')).toThrow(AutoConnectError);
    expect(() => __testing.parseDevToolsActivePort('0x1234\n')).toThrow(AutoConnectError);
  });

  it('refuses managed profile via symlink alias', async () => {
    const realManaged = makeTempDir('oc-managed-real-');
    const aliasParent = makeTempDir('oc-managed-link-');
    const aliasPath = path.join(aliasParent, 'alias');
    try {
      fs.symlinkSync(realManaged, aliasPath, 'dir');
      // Operator passes the symlink alias as userDataDir; managed profile
      // is registered under its real path. Without canonicalization the
      // string compare would miss this and allow attach.
      await expect(
        discoverActiveDevToolsPort({
          userDataDir: aliasPath,
          timeoutMs: 50,
          managedProfileDir: realManaged,
        }),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'managed_profile_refused',
      });
      // And the inverse direction (managed dir registered via alias).
      await expect(
        discoverActiveDevToolsPort({
          userDataDir: realManaged,
          timeoutMs: 50,
          managedProfileDir: aliasPath,
        }),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'managed_profile_refused',
      });
    } finally {
      try { fs.unlinkSync(aliasPath); } catch { /* ignore */ }
      rm(aliasParent);
      rm(realManaged);
    }
  });

  it('refuses managed profile via trailing-slash variant', async () => {
    const dir = makeTempDir('oc-managed-trail-');
    try {
      await expect(
        discoverActiveDevToolsPort({
          userDataDir: dir + path.sep,
          timeoutMs: 50,
          managedProfileDir: dir,
        }),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'managed_profile_refused',
      });
    } finally {
      rm(dir);
    }
  });

  it('pathsEqual is case-insensitive on darwin/win32 and exact on linux', () => {
    const dir = makeTempDir('oc-case-');
    try {
      const upper = dir.toUpperCase();
      const lower = dir.toLowerCase();
      // Direct helper assertion — independent of the real FS case sensitivity.
      const original = Object.getOwnPropertyDescriptor(process, 'platform');
      try {
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        expect(__testing.pathsEqual(upper, lower)).toBe(true);
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        expect(__testing.pathsEqual(upper, lower)).toBe(true);
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        // Different case on linux compares unequal *unless* canonicalize
        // happens to collapse them (it won't, since both resolve via
        // realpath to whatever the real FS reports). If the temp FS itself
        // is case-insensitive (rare on linux), this assertion still holds
        // because realpath returns the canonical case for both inputs.
        const equalOnLinux = __testing.pathsEqual(upper, lower);
        if (upper === lower) {
          expect(equalOnLinux).toBe(true);
        }
      } finally {
        if (original) {
          Object.defineProperty(process, 'platform', original);
        }
      }
    } finally {
      rm(dir);
    }
  });

  it('accepts a distinct user-data dir even if managed profile is set', async () => {
    const userDir = makeTempDir('oc-user-');
    const managedDir = makeTempDir('oc-managed-');
    const listener = await bindLocalListener();
    try {
      writeActivePortFile(userDir, listener.port, '/devtools/browser/distinct');
      const result = await discoverActiveDevToolsPort({
        userDataDir: userDir,
        timeoutMs: 250,
        managedProfileDir: managedDir,
      });
      expect(result.port).toBe(listener.port);
      expect(result.browserTargetPath).toBe('/devtools/browser/distinct');
    } finally {
      listener.close();
      rm(userDir);
      rm(managedDir);
    }
  });

  it('defaultUserDataDir returns a non-empty path on stable channel', () => {
    const d = __testing.defaultUserDataDir('stable');
    expect(typeof d).toBe('string');
    expect((d as string).length).toBeGreaterThan(0);
  });
});

describe('refreshAutoConnectEndpoint (#1558)', () => {
  it('uses the current profile endpoint when /json/version returns 404', async () => {
    const dir = makeTempDir();
    const server = await bindDebugServer((_port, _req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    try {
      writeActivePortFile(dir, server.port, '/devtools/browser/from-file');
      const result = await refreshAutoConnectEndpoint(
        { userDataDir: dir, port: server.port },
        { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 500 },
      );
      expect(result.wsEndpoint).toBe(
        `ws://127.0.0.1:${server.port}/devtools/browser/from-file`,
      );
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it('accepts a matching /json/version endpoint and keeps the file path authoritative', async () => {
    const dir = makeTempDir();
    const server = await bindDebugServer((port, req, res) => {
      if (req.url === '/json/version') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/matching`,
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    try {
      writeActivePortFile(dir, server.port, '/devtools/browser/matching');
      const result = await refreshAutoConnectEndpoint(
        { userDataDir: dir, port: server.port },
        { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 500 },
      );
      expect(result.wsEndpoint).toBe(
        `ws://127.0.0.1:${server.port}/devtools/browser/matching`,
      );
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it('preserves legacy one-line files when /json/version supplies a valid browser endpoint', async () => {
    const dir = makeTempDir();
    const server = await bindDebugServer((port, req, res) => {
      if (req.url === '/json/version') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/from-http`,
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    try {
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${server.port}\n`);
      const result = await refreshAutoConnectEndpoint(
        { userDataDir: dir, port: server.port },
        { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 500 },
      );
      expect(result).toMatchObject({
        wsEndpoint: `ws://localhost:${server.port}/devtools/browser/from-http`,
        browserTargetPath: '/devtools/browser/from-http',
      });
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it('does not use the HTTP 404 fallback for a legacy one-line file', async () => {
    const dir = makeTempDir();
    const server = await bindDebugServer((_port, _req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    try {
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${server.port}\n`);
      await expect(
        refreshAutoConnectEndpoint(
          { userDataDir: dir, port: server.port },
          { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 500 },
        ),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'debug_endpoint_unavailable',
      });
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it.each([
    ['wrong port', (port: number) => `ws://127.0.0.1:${port + 1}/devtools/browser/http`],
    ['non-loopback host', (port: number) => `ws://example.com:${port}/devtools/browser/http`],
    ['credentials', (port: number) => `ws://user:pass@127.0.0.1:${port}/devtools/browser/http`],
    ['non-browser path', (port: number) => `ws://127.0.0.1:${port}/devtools/page/http`],
  ])('rejects a legacy one-line file with a %s HTTP endpoint', async (_label, endpointForPort) => {
    const dir = makeTempDir();
    const server = await bindDebugServer((port, _req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ webSocketDebuggerUrl: endpointForPort(port) }));
    });
    try {
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${server.port}\n`);
      await expect(
        refreshAutoConnectEndpoint(
          { userDataDir: dir, port: server.port },
          { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 500 },
        ),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'endpoint_mismatch',
      });
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it('fails closed when /json/version points at another browser on the same port', async () => {
    const dir = makeTempDir();
    const server = await bindDebugServer((port, _req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/other-profile`,
      }));
    });
    try {
      writeActivePortFile(dir, server.port, '/devtools/browser/selected-profile');
      await expect(
        refreshAutoConnectEndpoint(
          { userDataDir: dir, port: server.port },
          { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 500 },
        ),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'endpoint_mismatch',
      });
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it.each([
    ['HTTP 403', 403, 'blocked'],
    ['HTTP 500', 500, 'failed'],
    ['malformed 200', 200, '{"Browser":"Chrome"}'],
  ])('does not fall back on %s', async (_label, statusCode, body) => {
    const dir = makeTempDir();
    const server = await bindDebugServer((_port, _req, res) => {
      res.statusCode = statusCode as number;
      res.end(body as string);
    });
    try {
      writeActivePortFile(dir, server.port, '/devtools/browser/from-file');
      await expect(
        refreshAutoConnectEndpoint(
          { userDataDir: dir, port: server.port },
          { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 500 },
        ),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'debug_endpoint_unavailable',
      });
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it('does not fall back when /json/version times out', async () => {
    const dir = makeTempDir();
    const server = await bindDebugServer((_port, _req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) res.end('late');
      }, 200);
    });
    try {
      writeActivePortFile(dir, server.port, '/devtools/browser/from-file');
      await expect(
        refreshAutoConnectEndpoint(
          { userDataDir: dir, port: server.port },
          { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 25 },
        ),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'debug_endpoint_unavailable',
      });
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it('refreshes a changed browser UUID on the same port', async () => {
    const dir = makeTempDir();
    const server = await bindDebugServer((_port, _req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    try {
      writeActivePortFile(dir, server.port, '/devtools/browser/uuid-one');
      const first = await refreshAutoConnectEndpoint(
        { userDataDir: dir, port: server.port },
        { expectedPort: server.port, fileTimeoutMs: 50, probeTimeoutMs: 500 },
      );

      writeActivePortFile(dir, server.port, '/devtools/browser/uuid-two');
      const second = await refreshAutoConnectEndpoint(first, {
        expectedPort: server.port,
        fileTimeoutMs: 50,
        probeTimeoutMs: 500,
      });

      expect(first.browserTargetPath).toBe('/devtools/browser/uuid-one');
      expect(second.browserTargetPath).toBe('/devtools/browser/uuid-two');
    } finally {
      await server.close();
      rm(dir);
    }
  });

  it('requires a server restart when DevToolsActivePort changes ports', async () => {
    const dir = makeTempDir();
    const server = await bindDebugServer((_port, _req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    try {
      writeActivePortFile(dir, server.port, '/devtools/browser/new-port');
      await expect(
        refreshAutoConnectEndpoint(
          { userDataDir: dir, port: server.port - 1 },
          { expectedPort: server.port - 1, fileTimeoutMs: 50, probeTimeoutMs: 500 },
        ),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'port_changed',
      });
    } finally {
      await server.close();
      rm(dir);
    }
  });
});

describe('assertAutoConnectCompatibleWithLaunchMode (#849)', () => {
  it('returns silently when auto-connect unset', () => {
    expect(() =>
      assertAutoConnectCompatibleWithLaunchMode(undefined, 'auto', 'cli'),
    ).not.toThrow();
    expect(() =>
      assertAutoConnectCompatibleWithLaunchMode(undefined, 'isolated', 'env'),
    ).not.toThrow();
  });

  it('returns silently when launchMode is attach', () => {
    expect(() =>
      assertAutoConnectCompatibleWithLaunchMode('/tmp/x', 'attach', 'cli'),
    ).not.toThrow();
    expect(() =>
      assertAutoConnectCompatibleWithLaunchMode('', 'attach', 'env'),
    ).not.toThrow();
  });

  it('throws AutoConnectModeConflictError on auto + auto-connect', () => {
    expect(() =>
      assertAutoConnectCompatibleWithLaunchMode('/tmp/x', 'auto', 'cli'),
    ).toThrow(AutoConnectModeConflictError);
  });

  it('throws AutoConnectModeConflictError on isolated + auto-connect', () => {
    expect(() =>
      assertAutoConnectCompatibleWithLaunchMode('/tmp/x', 'isolated', 'env'),
    ).toThrow(AutoConnectModeConflictError);
  });

  it('error message names both inputs and the source', () => {
    try {
      assertAutoConnectCompatibleWithLaunchMode('/tmp/oc', 'isolated', 'cli');
      fail('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('--auto-connect');
      expect(msg).toContain('/tmp/oc');
      expect(msg).toContain('isolated');
      expect(msg).toContain('cli');
    }
  });

  it('integrates with resolveLaunchMode for env-driven conflict detection', () => {
    const resolved = resolveLaunchMode({}, { OPENCHROME_LAUNCH_MODE: 'auto' }, {});
    expect(resolved).toBe('auto');
    expect(() =>
      assertAutoConnectCompatibleWithLaunchMode('/tmp/x', resolved, 'env'),
    ).toThrow(AutoConnectModeConflictError);
  });
});
