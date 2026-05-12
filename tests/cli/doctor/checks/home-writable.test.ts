/**
 * Unit tests for home-writable check
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
  accessSync: jest.fn(),
}));

const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;
const mockAccessSync = fs.accessSync as jest.MockedFunction<typeof fs.accessSync>;

describe('check: home-writable', () => {
  const expectedDir = path.join(os.homedir(), '.openchrome');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('ok when directory exists and is writable', async () => {
    mockMkdirSync.mockImplementation(() => undefined);
    mockAccessSync.mockImplementation(() => undefined);

    const { checkHomeWritable } = await import('../../../../src/cli/doctor/checks/home-writable');
    const result = await checkHomeWritable();

    expect(result.id).toBe('home-writable');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain(expectedDir);
  });

  test('fail when mkdir fails', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockMkdirSync.mockImplementation(() => { throw err; });

    jest.resetModules();
    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      mkdirSync: jest.fn(() => { throw err; }),
      accessSync: jest.fn(),
    }));

    const { checkHomeWritable } = await import('../../../../src/cli/doctor/checks/home-writable');
    const result = await checkHomeWritable();

    expect(result.id).toBe('home-writable');
    expect(result.status).toBe('fail');
    expect(result.remediation).toBeDefined();
  });

  test('fail when directory is not writable', async () => {
    mockMkdirSync.mockImplementation(() => undefined);
    const accessErr = new Error('EACCES');
    mockAccessSync.mockImplementation(() => { throw accessErr; });

    const { checkHomeWritable } = await import('../../../../src/cli/doctor/checks/home-writable');
    const result = await checkHomeWritable();

    expect(result.id).toBe('home-writable');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not writable');
    expect(result.remediation).toContain('chmod');
  });
});
