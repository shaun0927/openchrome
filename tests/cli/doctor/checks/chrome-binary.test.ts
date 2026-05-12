/**
 * Unit tests for chrome-binary check
 */

import * as fs from 'fs';
import { execFileSync, execSync } from 'child_process';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFileSync: jest.fn(),
  execSync: jest.fn(),
}));

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('check: chrome-binary', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.CHROME_PATH;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('ok when Chrome found and returns valid version', async () => {
    process.env.CHROME_PATH = '/usr/bin/chrome';
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue('Google Chrome 120.0.0.0' as unknown as Buffer);

    const { checkChromeBinary } = await import('../../../../src/cli/doctor/checks/chrome-binary');
    const result = await checkChromeBinary();

    expect(result.id).toBe('chrome-binary');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('Chrome');
  });

  test('fail when Chrome not found anywhere', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const { checkChromeBinary } = await import('../../../../src/cli/doctor/checks/chrome-binary');
    const result = await checkChromeBinary();

    expect(result.id).toBe('chrome-binary');
    expect(result.status).toBe('fail');
    expect(result.remediation).toContain('CHROME_PATH');
  });

  test('fail when Chrome version is too old', async () => {
    process.env.CHROME_PATH = '/usr/bin/chrome';
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue('Google Chrome 50.0.0.0' as unknown as Buffer);

    const { checkChromeBinary } = await import('../../../../src/cli/doctor/checks/chrome-binary');
    const result = await checkChromeBinary();

    expect(result.id).toBe('chrome-binary');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('minimum major');
  });

  test('fail when Chrome found but version command fails', async () => {
    process.env.CHROME_PATH = '/usr/bin/chrome';
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => { throw new Error('spawn error'); });

    const { checkChromeBinary } = await import('../../../../src/cli/doctor/checks/chrome-binary');
    const result = await checkChromeBinary();

    expect(result.id).toBe('chrome-binary');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('could not determine version');
  });
});
