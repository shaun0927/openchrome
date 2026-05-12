/**
 * Unit tests for profile-lock check
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('check: profile-lock', () => {
  let tmpDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-profile-'));
    process.env = { ...originalEnv, OPENCHROME_USER_DATA_DIR: tmpDir };
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('ok when no lock files in profile dir', async () => {
    const { checkProfileLock } = await import('../../../../src/cli/doctor/checks/profile-lock');
    const result = await checkProfileLock();

    expect(result.id).toBe('profile-lock');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('No lock files');
  });

  test('warn when SingletonLock exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'SingletonLock'), '', 'utf8');

    const { checkProfileLock } = await import('../../../../src/cli/doctor/checks/profile-lock');
    const result = await checkProfileLock();

    expect(result.id).toBe('profile-lock');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('SingletonLock');
    expect(result.remediation).toBeDefined();
  });

  test('warn when SingletonCookie exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'SingletonCookie'), '', 'utf8');

    const { checkProfileLock } = await import('../../../../src/cli/doctor/checks/profile-lock');
    const result = await checkProfileLock();

    expect(result.id).toBe('profile-lock');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('SingletonCookie');
  });

  test('ok when profile dir does not exist', async () => {
    process.env.OPENCHROME_USER_DATA_DIR = '/nonexistent/profile/dir/12345';
    jest.resetModules();

    const { checkProfileLock } = await import('../../../../src/cli/doctor/checks/profile-lock');
    const result = await checkProfileLock();

    expect(result.id).toBe('profile-lock');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('not found');
  });
});
