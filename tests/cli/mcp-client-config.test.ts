import {
  formatMCPServerConfigSnippet,
  getClaudeSetupCommand,
  getCodexServerConfig,
  getServeArgs,
  isSupportedMCPClient,
  upsertMCPServerConfig,
} from '../../cli/mcp-client-config';

describe('cli/mcp-client-config', () => {
  test('getServeArgs enables auto-launch by default', () => {
    expect(getServeArgs()).toEqual(['serve', '--auto-launch']);
  });

  test('getServeArgs includes dashboard when requested', () => {
    expect(getServeArgs({ dashboard: true })).toEqual(['serve', '--auto-launch', '--dashboard']);
  });

  test('getServeArgs omits auto-launch when explicitly disabled', () => {
    expect(getServeArgs({ autoLaunch: false })).toEqual(['serve']);
  });

  test('getCodexServerConfig uses npm exec with argument separator', () => {
    expect(getCodexServerConfig()).toEqual({
      command: 'npm',
      args: ['exec', '--yes', '--prefer-online', 'openchrome-mcp@latest', '--', 'serve', '--auto-launch'],
    });
  });

  test('getClaudeSetupCommand preserves the Claude-specific mcp add flow', () => {
    expect(getClaudeSetupCommand('project', { dashboard: true })).toEqual([
      'mcp',
      'add',
      'openchrome',
      '-s',
      'project',
      '--',
      'npx',
      '--prefer-online',
      '-y',
      'openchrome-mcp@latest',
      'serve',
      '--auto-launch',
      '--dashboard',
    ]);
  });

  test('upsertMCPServerConfig preserves sibling servers', () => {
    const updated = upsertMCPServerConfig(
      {
        mcpServers: {
          existing: {
            command: 'node',
            args: ['example.js'],
          },
        },
      },
      'openchrome',
      getCodexServerConfig()
    );

    expect(updated).toEqual({
      mcpServers: {
        existing: {
          command: 'node',
          args: ['example.js'],
        },
        openchrome: {
          command: 'npm',
          args: ['exec', '--yes', '--prefer-online', 'openchrome-mcp@latest', '--', 'serve', '--auto-launch'],
        },
      },
    });
  });

  test('formatMCPServerConfigSnippet serializes a full mcpServers document', () => {
    expect(JSON.parse(formatMCPServerConfigSnippet('openchrome', getCodexServerConfig()))).toEqual({
      mcpServers: {
        openchrome: {
          command: 'npm',
          args: ['exec', '--yes', '--prefer-online', 'openchrome-mcp@latest', '--', 'serve', '--auto-launch'],
        },
      },
    });
  });

  test('isSupportedMCPClient validates supported names', () => {
    expect(isSupportedMCPClient('claude')).toBe(true);
    expect(isSupportedMCPClient('codex')).toBe(true);
    expect(isSupportedMCPClient('cursor')).toBe(false);
  });
});
