import {
  formatMCPServerConfigSnippet,
  getClaudeManualServerConfig,
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

  test('getCodexServerConfig uses the installed openchrome binary', () => {
    expect(getCodexServerConfig()).toEqual({
      command: 'openchrome',
      args: ['serve', '--auto-launch'],
    });
  });

  test('getClaudeManualServerConfig uses the installed openchrome binary', () => {
    expect(getClaudeManualServerConfig()).toEqual({
      command: 'openchrome',
      args: ['serve', '--auto-launch'],
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
      'openchrome',
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
          command: 'openchrome',
          args: ['serve', '--auto-launch'],
        },
      },
    });
  });

  test('formatMCPServerConfigSnippet serializes a full mcpServers document', () => {
    expect(JSON.parse(formatMCPServerConfigSnippet('openchrome', getCodexServerConfig()))).toEqual({
      mcpServers: {
        openchrome: {
          command: 'openchrome',
          args: ['serve', '--auto-launch'],
        },
      },
    });
  });

  test('generated configs do not use transient package runners', () => {
    const serialized = [
      JSON.stringify(getCodexServerConfig()),
      JSON.stringify(getClaudeManualServerConfig()),
      formatMCPServerConfigSnippet('openchrome', getCodexServerConfig()),
      getClaudeSetupCommand('user').join(' '),
    ].join('\n');

    expect(serialized).not.toContain('npx');
    expect(serialized).not.toContain('@latest');
    expect(serialized).not.toContain('--prefer-online');
  });

  test('isSupportedMCPClient validates supported names', () => {
    expect(isSupportedMCPClient('claude')).toBe(true);
    expect(isSupportedMCPClient('codex')).toBe(true);
    expect(isSupportedMCPClient('cursor')).toBe(false);
  });
});
