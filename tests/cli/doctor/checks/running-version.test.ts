import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeRunningVersionCheck } from '../../../../src/cli/doctor/checks/running-version';
import { getControllerLockPath, normalizeControllerUserDataDir } from '../../../../src/chrome/controller-lock';

describe('running-version doctor check', () => {
  let rootDir: string;
  const port = 9444;
  const userDataDir = path.join(os.tmpdir(), 'oc-running-version-profile');

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-running-version-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function writeOwner(pid: number, version: string): void {
    const lockPath = getControllerLockPath(port, normalizeControllerUserDataDir(userDataDir), rootDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid, version, port, userDataDir }));
  }

  const check = (installedVersion: string) => makeRunningVersionCheck({ port, userDataDir, rootDir, installedVersion })();

  test('is ok when nothing is running', async () => {
    expect(await check('1.15.0')).toMatchObject({ status: 'ok' });
  });

  test('is ok when the running owner is the installed version', async () => {
    writeOwner(process.pid, '1.15.0');
    expect(await check('1.15.0')).toMatchObject({ status: 'ok' });
  });

  test('warns when a running owner predates the installed package', async () => {
    writeOwner(process.pid, '1.14.0');
    const result = await check('1.15.0');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('1.14.0');
    expect(result.remediation).toMatch(/Restart the MCP host/);
    expect(result.facts).toMatchObject({ runningVersion: '1.14.0', installedVersion: '1.15.0', ownerPid: process.pid });
  });

  test('ignores a lock left by a dead process', async () => {
    writeOwner(2_147_000_000, '1.14.0');
    expect(await check('1.15.0')).toMatchObject({ status: 'ok' });
  });
});
