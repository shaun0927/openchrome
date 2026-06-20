import {
  formatCodexMCPServerConfigSnippet,
  formatMCPServerConfigSnippet,
  getClaudeManualServerConfig,
  getClaudeSetupCommand,
  getCodexServerConfig,
  getCodexSetupCommand,
  getOpenCodeServerConfig,
  getServeArgs,
  getTopologyWarning,
  HOST_CONFIG_MIGRATION_NOTE,
  isSupportedMCPClient,
  upsertMCPServerConfig,
} from '../../cli/mcp-client-config';

describe('cli/mcp-client-config', () => {
  test('getServeArgs enables auto-launch by default', () => {
    expect(getServeArgs()).toEqual(['serve', '--auto-launch', '--auto-elect', '--minimal']);
  });

  test('getServeArgs includes dashboard when requested', () => {
    expect(getServeArgs({ dashboard: true })).toEqual(['serve', '--auto-launch', '--auto-elect', '--minimal', '--dashboard']);
  });

  test('getServeArgs preserves explicit port and profile topology', () => {
    expect(getServeArgs({
      port: 9333,
      userDataDir: '/tmp/openchrome-codex',
      profileDirectory: 'Default',
      launchMode: 'isolated',
    })).toEqual([
      'serve',
      '--auto-launch',
      '--auto-elect',
      '--minimal',
      '--port',
      '9333',
      '--user-data-dir',
      '/tmp/openchrome-codex',
      '--profile-directory',
      'Default',
      '--launch-mode',
      'isolated',
    ]);
  });

  test('single-owner topology preset preserves the legacy direct owner explicitly', () => {
    expect(getServeArgs({ topology: 'single-owner' })).toEqual(['serve', '--auto-launch', '--minimal', '--no-auto-elect']);
  });

  test('broker topology presets generate owner and client roles', () => {
    expect(getServeArgs({ topology: 'broker-owner', port: 9222, userDataDir: '/tmp/shared' })).toEqual([
      'serve', '--auto-launch', '--minimal', '--broker', '--port', '9222', '--user-data-dir', '/tmp/shared',
    ]);
    expect(getServeArgs({ topology: 'broker-client', port: 9222, userDataDir: '/tmp/shared' })).toEqual([
      'serve', '--minimal', '--connect-broker', '--port', '9222', '--user-data-dir', '/tmp/shared',
    ]);
  });

  test('isolated topology preset chooses a non-default port and profile', () => {
    expect(getServeArgs({ topology: 'isolated' })).toEqual([
      'serve',
      '--auto-launch',
      '--minimal',
      '--port',
      '9223',
      '--user-data-dir',
      '~/.openchrome/profiles/isolated',
      '--launch-mode',
      'isolated',
    ]);
  });

  test('getServeArgs omits auto-launch when explicitly disabled', () => {
    expect(getServeArgs({ autoLaunch: false })).toEqual(['serve', '--minimal']);
  });


  test('getServeArgs can opt out of generated minimal mode', () => {
    expect(getServeArgs({ minimal: false })).toEqual(['serve', '--auto-launch', '--auto-elect']);
  });

  test('getCodexServerConfig uses the installed openchrome binary', () => {
    expect(getCodexServerConfig()).toEqual({
      command: 'openchrome',
      args: ['serve', '--auto-launch', '--auto-elect', '--minimal'],
    });
  });

  test('getCodexSetupCommand uses the Codex MCP registry add command without a destructive remove step', () => {
    const command = getCodexSetupCommand({ dashboard: true });

    expect(command).toEqual([
      'mcp',
      'add',
      'openchrome',
      '--',
      'openchrome',
      'serve',
      '--auto-launch',
      '--auto-elect',
      '--minimal',
      '--dashboard',
    ]);
    expect(command).not.toContain('remove');
  });

  test('getClaudeManualServerConfig uses the installed openchrome binary', () => {
    expect(getClaudeManualServerConfig()).toEqual({
      command: 'openchrome',
      args: ['serve', '--auto-launch', '--auto-elect', '--minimal'],
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
      '--auto-elect',
      '--minimal',
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
          args: ['serve', '--auto-launch', '--auto-elect', '--minimal'],
        },
      },
    });
  });

  test('formatMCPServerConfigSnippet serializes a full mcpServers document', () => {
    expect(JSON.parse(formatMCPServerConfigSnippet('openchrome', getCodexServerConfig()))).toEqual({
      mcpServers: {
        openchrome: {
          command: 'openchrome',
          args: ['serve', '--auto-launch', '--auto-elect', '--minimal'],
        },
      },
    });
  });

  test('formatCodexMCPServerConfigSnippet serializes Codex config.toml format', () => {
    expect(formatCodexMCPServerConfigSnippet('openchrome', getCodexServerConfig())).toBe(
      [
        '[mcp_servers.openchrome]',
        'command = "openchrome"',
        'args = ["serve", "--auto-launch", "--auto-elect", "--minimal"]',
      ].join('\n')
    );
  });

  test('Codex and Claude generated configs preserve explicit port and user-data-dir', () => {
    const options = { port: 9333, userDataDir: '/tmp/openchrome-codex' };

    expect(formatCodexMCPServerConfigSnippet('openchrome', getCodexServerConfig(options))).toContain(
      'args = ["serve", "--auto-launch", "--auto-elect", "--minimal", "--port", "9333", "--user-data-dir", "/tmp/openchrome-codex"]'
    );
    expect(getClaudeSetupCommand('user', options)).toEqual([
      'mcp',
      'add',
      'openchrome',
      '-s',
      'user',
      '--',
      'openchrome',
      'serve',
      '--auto-launch',
      '--auto-elect',
      '--minimal',
      '--port',
      '9333',
      '--user-data-dir',
      '/tmp/openchrome-codex',
    ]);
  });

  test('OpenCode generated config uses installed openchrome and preserves topology args', () => {
    expect(getOpenCodeServerConfig({ port: 9444, userDataDir: '/tmp/openchrome-opencode' })).toEqual({
      type: 'local',
      command: [
        'openchrome',
        'serve',
        '--auto-launch',
        '--auto-elect',
        '--minimal',
        '--port',
        '9444',
        '--user-data-dir',
        '/tmp/openchrome-opencode',
      ],
    });
  });

  test('single-owner topology warning calls out legacy direct-owner risk', () => {
    expect(getTopologyWarning()).toBeNull();
    expect(getTopologyWarning({ topology: 'single-owner' })).toContain('legacy direct-owner');
    expect(getTopologyWarning({ topology: 'single-owner' })).toContain(HOST_CONFIG_MIGRATION_NOTE);
  });

  test('generated configs do not use transient package runners', () => {
    const serialized = [
      JSON.stringify(getCodexServerConfig()),
      JSON.stringify(getClaudeManualServerConfig()),
      formatCodexMCPServerConfigSnippet('openchrome', getCodexServerConfig()),
      JSON.stringify(getOpenCodeServerConfig()),
      getClaudeSetupCommand('user').join(' '),
      getCodexSetupCommand().join(' '),
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
