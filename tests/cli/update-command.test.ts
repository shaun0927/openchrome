jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
}));

import { spawnSync } from 'child_process';
import { getUpdateCommandText, runUpdateCommand } from '../../cli/update-command';

const mockedSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe('cli/update-command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('updates the package and refreshes Claude setup by default', () => {
    mockedSpawnSync.mockReturnValue({ status: 0 } as unknown as ReturnType<typeof spawnSync>);

    expect(runUpdateCommand()).toBe(0);
    expect(getUpdateCommandText()).toBe('npm install -g openchrome-mcp@latest');
    expect(mockedSpawnSync).toHaveBeenNthCalledWith(1, 'npm', ['install', '-g', 'openchrome-mcp@latest'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    expect(mockedSpawnSync).toHaveBeenNthCalledWith(2, 'openchrome', ['setup', '--scope', 'user'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  });

  test('can skip setup refresh', () => {
    mockedSpawnSync.mockReturnValue({ status: 0 } as unknown as ReturnType<typeof spawnSync>);

    expect(runUpdateCommand({ setup: false })).toBe(0);

    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockedSpawnSync).toHaveBeenCalledWith('npm', ['install', '-g', 'openchrome-mcp@latest'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  });

  test('can refresh Codex setup after updating', () => {
    mockedSpawnSync.mockReturnValue({ status: 0 } as unknown as ReturnType<typeof spawnSync>);

    expect(runUpdateCommand({ client: 'codex' })).toBe(0);

    expect(mockedSpawnSync).toHaveBeenNthCalledWith(2, 'openchrome', ['setup', '--client', 'codex', '--scope', 'user'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  });

  test('prints actionable guidance when npm is unavailable', () => {
    const error = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
    mockedSpawnSync.mockReturnValue({ error } as unknown as ReturnType<typeof spawnSync>);

    expect(runUpdateCommand()).toBe(1);

    const output = [
      ...consoleLogSpy.mock.calls.map((call: unknown[]) => call[0]),
      ...consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0]),
    ].join('\n');
    expect(output).toContain('npm was not found');
    expect(output).toContain('npm install -g openchrome-mcp@latest');
  });
});
