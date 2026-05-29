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

  test('can refresh OpenCode setup after updating', () => {
    mockedSpawnSync.mockReturnValue({ status: 0 } as unknown as ReturnType<typeof spawnSync>);

    // opencode was previously missing from the --client type even though `setup`
    // supports it; this guards that regression.
    expect(runUpdateCommand({ client: 'opencode' })).toBe(0);

    expect(mockedSpawnSync).toHaveBeenNthCalledWith(2, 'openchrome', ['setup', '--client', 'opencode', '--scope', 'user'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  });

  test('rejects an unsupported --client before touching npm, pointing to manual config', () => {
    // cursor/windsurf/vscode were advertised in --client help but rejected by the
    // setup layer with exit(1) mid-update. Now we fail fast with guidance.
    expect(runUpdateCommand({ client: 'cursor' })).toBe(1);

    expect(mockedSpawnSync).not.toHaveBeenCalled();

    const output = consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(output).toContain('Unsupported --client "cursor"');
    expect(output).toContain('manual MCP config');
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
