import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  analyzeOpenChromeConfigs,
  classifyOpenChromeCommand,
  findDuplicateDirectGroups,
  getHostConfigMigrationNotice,
  scanOpenChromeHostConfigs,
} from '../../cli/mcp-config-diagnostics';

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-mcp-config-'));
}

describe('cli/mcp-config-diagnostics', () => {
  test('migration notice explains update versus host config activation', () => {
    const notice = getHostConfigMigrationNotice('Codex CLI').join('\n');

    expect(notice).toContain('Package updates do not rewrite existing MCP host registrations');
    expect(notice).toContain('Codex CLI');
    expect(notice).toContain('restart the host session');
  });

  test('classifies direct, broker owner, and broker client commands', () => {
    expect(classifyOpenChromeCommand('openchrome', ['serve', '--auto-launch'])).toMatchObject({
      direct: true,
      broker: false,
      connectBroker: false,
      port: '9222',
      userDataDir: '<openchrome-default-profile>',
    });

    expect(classifyOpenChromeCommand('openchrome', ['serve', '--broker', '--port', '9333'])).toMatchObject({
      direct: false,
      broker: true,
      connectBroker: false,
      port: '9333',
    });

    expect(classifyOpenChromeCommand('openchrome', ['serve', '--connect-broker', '--user-data-dir', '/tmp/oc'])).toMatchObject({
      direct: false,
      broker: false,
      connectBroker: true,
      userDataDir: '/tmp/oc',
    });
  });


  test('classifies equals-style flags and platform-specific openchrome executable names', () => {
    expect(classifyOpenChromeCommand('/opt/bin/openchrome', ['serve', '--port=9333', '--user-data-dir=/tmp/oc'])).toMatchObject({
      direct: true,
      port: '9333',
      userDataDir: '/tmp/oc',
    });

    expect(classifyOpenChromeCommand('C:\\Tools\\openchrome.cmd', ['serve', '-p', '9444'])).toMatchObject({
      direct: true,
      port: '9444',
    });

    expect(classifyOpenChromeCommand('C:\\Tools\\openchrome.exe', ['serve', '--broker'])).toMatchObject({
      broker: true,
      direct: false,
    });
  });

  test('groups duplicate direct configs by port and user data dir', () => {
    const duplicateGroups = findDuplicateDirectGroups([
      {
        client: 'claude',
        label: 'Claude Code',
        path: '/tmp/claude',
        command: 'openchrome',
        args: ['serve', '--auto-launch'],
        port: '9222',
        userDataDir: '<openchrome-default-profile>',
        direct: true,
        broker: false,
        connectBroker: false,
      },
      {
        client: 'codex',
        label: 'Codex CLI',
        path: '/tmp/codex',
        command: 'openchrome',
        args: ['serve', '--auto-launch'],
        port: '9222',
        userDataDir: '<openchrome-default-profile>',
        direct: true,
        broker: false,
        connectBroker: false,
      },
      {
        client: 'opencode',
        label: 'OpenCode',
        path: '/tmp/opencode',
        command: 'openchrome',
        args: ['serve', '--connect-broker'],
        port: '9222',
        userDataDir: '<openchrome-default-profile>',
        direct: false,
        broker: false,
        connectBroker: true,
      },
    ]);

    expect(duplicateGroups).toHaveLength(1);
    expect(duplicateGroups[0].configs.map((config) => config.label)).toEqual(['Claude Code', 'Codex CLI']);
  });

  test('scans Claude JSON, Codex TOML, Codex MCP JSON, and OpenCode JSON configs', () => {
    const home = makeTempHome();
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        openchrome: { command: 'openchrome', args: ['serve', '--auto-launch'] },
      },
    }));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
      '[mcp_servers.openchrome]',
      'command = "openchrome"',
      'args = ["serve", "--auto-launch"]',
    ].join('\n'));
    fs.writeFileSync(path.join(home, '.codex', 'mcp.json'), JSON.stringify({
      mcpServers: {
        openchrome: { command: 'openchrome', args: ['serve', '--connect-broker'] },
      },
    }));
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
      mcp: {
        openchrome: { type: 'local', command: ['openchrome', 'serve', '--auto-launch', '--port', '9444'] },
      },
    }));

    const diagnostics = scanOpenChromeHostConfigs(home);

    expect(diagnostics.configs.map((config) => `${config.label}:${config.port}:${config.direct}`).sort()).toEqual([
      'Claude Code:9222:true',
      'Codex CLI:9222:false',
      'Codex CLI:9222:true',
      'OpenCode:9444:true',
    ]);
    expect(diagnostics.duplicateDirectGroups).toHaveLength(1);
  });

  test('analysis preserves direct config list without duplicate groups', () => {
    const analyzed = analyzeOpenChromeConfigs([
      {
        client: 'claude',
        label: 'Claude Code',
        path: '/tmp/claude',
        command: 'openchrome',
        args: ['serve', '--auto-launch', '--port', '9223'],
        port: '9223',
        userDataDir: '<openchrome-default-profile>',
        direct: true,
        broker: false,
        connectBroker: false,
      },
    ]);

    expect(analyzed.directConfigs).toHaveLength(1);
    expect(analyzed.duplicateDirectGroups).toHaveLength(0);
  });
});
