/**
 * Unit tests for orphan-chrome check
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('check: orphan-chrome', () => {
  const originalEnv = process.env;
  const testPort = 39222;
  const chromePidPath = path.join(os.tmpdir(), `openchrome-chrome-${testPort}.pid`);
  const serverPidPath = path.join(os.tmpdir(), `openchrome-${testPort}.pid`);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv, CHROME_PORT: String(testPort) };
    try { fs.unlinkSync(chromePidPath); } catch { /* ignore */ }
    try { fs.unlinkSync(serverPidPath); } catch { /* ignore */ }
  });

  afterEach(() => {
    process.env = originalEnv;
    try { fs.unlinkSync(chromePidPath); } catch { /* ignore */ }
    try { fs.unlinkSync(serverPidPath); } catch { /* ignore */ }
  });

  test('ok when no chrome PID files exist', async () => {
    const { checkOrphanChrome } = await import('../../../../src/cli/doctor/checks/orphan-chrome');
    const result = await checkOrphanChrome();

    expect(result.id).toBe('orphan-chrome');
    expect(result.status).toBe('ok');
  });

  test('ok when chrome PID file exists with a managed server PID', async () => {
    // Write current process PID as both chrome and server
    fs.writeFileSync(chromePidPath, String(process.pid) + '\n', 'utf8');
    fs.writeFileSync(serverPidPath, String(process.pid) + '\n', 'utf8');

    const { checkOrphanChrome } = await import('../../../../src/cli/doctor/checks/orphan-chrome');
    const result = await checkOrphanChrome();

    expect(result.id).toBe('orphan-chrome');
    // Server is alive, so not orphan
    expect(result.status).toBe('ok');
  });

  test('ok when chrome PID file has dead PID (stale, not an orphan)', async () => {
    fs.writeFileSync(chromePidPath, '99999\n', 'utf8');

    const { checkOrphanChrome } = await import('../../../../src/cli/doctor/checks/orphan-chrome');
    const result = await checkOrphanChrome();

    expect(result.id).toBe('orphan-chrome');
    // Dead chrome PID = stale file, not orphan
    expect(result.status).toBe('ok');
  });

  test('warn when chrome PID is alive but no server managing it', async () => {
    // Use the current process PID as chrome (it's alive) and no server PID file
    fs.writeFileSync(chromePidPath, String(process.pid) + '\n', 'utf8');
    // No server PID file = orphan

    const { checkOrphanChrome } = await import('../../../../src/cli/doctor/checks/orphan-chrome');
    const result = await checkOrphanChrome();

    expect(result.id).toBe('orphan-chrome');
    expect(result.status).toBe('warn');
    expect(result.remediation).toContain('reap');
  });
});
