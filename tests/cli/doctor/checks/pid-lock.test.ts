/**
 * Unit tests for pid-lock check
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('check: pid-lock', () => {
  const originalEnv = process.env;
  const testPort = 29222;
  const pidFilePath = path.join(os.tmpdir(), `openchrome-${testPort}.pid`);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv, CHROME_PORT: String(testPort) };
    // Remove any stale test file
    try { fs.unlinkSync(pidFilePath); } catch { /* ignore */ }
  });

  afterEach(() => {
    process.env = originalEnv;
    try { fs.unlinkSync(pidFilePath); } catch { /* ignore */ }
  });

  test('ok when no PID file exists', async () => {
    const { checkPidLock } = await import('../../../../src/cli/doctor/checks/pid-lock');
    const result = await checkPidLock();

    expect(result.id).toBe('pid-lock');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('No PID file');
  });

  test('ok when PID file contains current process PID (alive)', async () => {
    fs.writeFileSync(pidFilePath, String(process.pid) + '\n', 'utf8');

    const { checkPidLock } = await import('../../../../src/cli/doctor/checks/pid-lock');
    const result = await checkPidLock();

    expect(result.id).toBe('pid-lock');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('Active PID');
  });

  test('fail when PID file contains stale/dead PID', async () => {
    // PID 99999 is very unlikely to be alive
    fs.writeFileSync(pidFilePath, '99999\n', 'utf8');

    const { checkPidLock } = await import('../../../../src/cli/doctor/checks/pid-lock');
    const result = await checkPidLock();

    expect(result.id).toBe('pid-lock');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Stale PID');
    expect(result.remediation).toContain('rm');
  });

  test('warn when PID file is empty', async () => {
    fs.writeFileSync(pidFilePath, '', 'utf8');

    const { checkPidLock } = await import('../../../../src/cli/doctor/checks/pid-lock');
    const result = await checkPidLock();

    expect(result.id).toBe('pid-lock');
    expect(result.status).toBe('warn');
  });
});
