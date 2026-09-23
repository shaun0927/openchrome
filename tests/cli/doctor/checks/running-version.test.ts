import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeRunningVersionCheck } from '../../../../src/cli/doctor/checks/running-version';
import { getControllerLockPath, normalizeControllerUserDataDir } from '../../../../src/chrome/controller-lock';

describe('running-version doctor check', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-running-version-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function writeOwner(port: number, pid: number, version: string): void {
    const userDataDir = path.join(os.tmpdir(), `oc-running-version-profile-${port}`);
    const lockPath = getControllerLockPath(port, normalizeControllerUserDataDir(userDataDir), rootDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid, version, port, userDataDir }));
  }

  const check = (installedVersion: string) => makeRunningVersionCheck({ rootDir, installedVersion })();

  test('is ok when nothing is running', async () => {
    expect(await check('1.15.0')).toMatchObject({ status: 'ok' });
  });

  test('is ok when the running owner is the installed version', async () => {
    writeOwner(9222, process.pid, '1.15.0');
    expect(await check('1.15.0')).toMatchObject({ status: 'ok' });
  });

  test('warns about an older owner on any port or profile', async () => {
    writeOwner(9222, process.pid, '1.15.0');
    writeOwner(9444, process.pid, '1.14.0');
    const result = await check('1.15.0');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('port 9444');
    expect(result.detail).toContain('1.14.0');
    expect(result.remediation).toMatch(/Restart the MCP host/);
    expect(result.facts).toMatchObject({
      installedVersion: '1.15.0',
      staleOwners: [{ pid: process.pid, runningVersion: '1.14.0', port: 9444 }],
    });
  });

  test('ignores locks left by dead processes and unreadable files', async () => {
    writeOwner(9555, 2_147_000_000, '1.14.0');
    fs.writeFileSync(path.join(rootDir, 'broken.json'), '{not json');
    expect(await check('1.15.0')).toMatchObject({ status: 'ok' });
  });
});
