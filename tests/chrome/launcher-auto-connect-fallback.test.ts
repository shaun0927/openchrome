jest.unmock('../../src/chrome/launcher');

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

import { ChromeLauncher } from '../../src/chrome/launcher';
import {
  __resetAutoConnectStateForTests,
  getAutoConnectState,
  setAutoConnectState,
} from '../../src/chrome/auto-connect-state';

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: jest.fn(),
  };
});

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({ chromeLaunchMode: 'attach' }),
}));

const mockSpawn = childProcess.spawn as jest.MockedFunction<typeof childProcess.spawn>;

describe('ChromeLauncher auto-connect endpoint refresh (#1558)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    __resetAutoConnectStateForTests();
    mockSpawn.mockReset();
    consoleErrorSpy.mockRestore();
  });

  it('attaches on HTTP 404 and refreshes a changed same-port browser UUID', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-launcher-auto-connect-'));
    let versionRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') versionRequests += 1;
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const activePortPath = path.join(dir, 'DevToolsActivePort');
    fs.writeFileSync(activePortPath, `${port}\n/devtools/browser/uuid-one\n`);

    const initial = setAutoConnectState({
      port,
      wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser/uuid-one`,
      browserTargetPath: '/devtools/browser/uuid-one',
      userDataDir: dir,
    });

    const launcher = new ChromeLauncher(port);
    try {
      const first = await launcher.ensureChrome({
        autoLaunch: false,
        launchMode: 'attach',
      });
      expect(first.wsEndpoint).toBe(
        `ws://127.0.0.1:${port}/devtools/browser/uuid-one`,
      );
      expect(first.launchMode).toBe('attach');

      fs.writeFileSync(activePortPath, `${port}\n/devtools/browser/uuid-two\n`);
      const second = await launcher.ensureChrome({
        autoLaunch: false,
        launchMode: 'attach',
      });

      expect(second.wsEndpoint).toBe(
        `ws://127.0.0.1:${port}/devtools/browser/uuid-two`,
      );
      expect(getAutoConnectState()).toMatchObject({
        wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser/uuid-two`,
        browserTargetPath: '/devtools/browser/uuid-two',
        attachedAt: initial.attachedAt,
      });
      expect(versionRequests).toBe(2);
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      await launcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not accept the cached endpoint when the selected profile file disappears', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-launcher-auto-connect-stale-'));
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const activePortPath = path.join(dir, 'DevToolsActivePort');
    fs.writeFileSync(activePortPath, `${port}\n/devtools/browser/uuid-one\n`);

    setAutoConnectState({
      port,
      wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser/uuid-one`,
      browserTargetPath: '/devtools/browser/uuid-one',
      userDataDir: dir,
    });

    const launcher = new ChromeLauncher(port);
    try {
      await launcher.ensureChrome({ autoLaunch: false, launchMode: 'attach' });
      fs.unlinkSync(activePortPath);

      await expect(
        launcher.ensureChrome({ autoLaunch: false, launchMode: 'attach' }),
      ).rejects.toMatchObject({
        name: 'AutoConnectError',
        errorCode: 'devtools_active_port_missing',
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      await launcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
