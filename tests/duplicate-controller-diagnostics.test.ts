import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findDuplicateControllerGroups,
  getCurrentControllerTopology,
  inferOpenChromeProcess,
  parsePsOutput,
  scanMcpConfigRegistrations,
  summarizeDuplicateControllerDiagnostics,
} from '../src/utils/duplicate-controller-diagnostics';
import { acquireControllerLock } from '../src/utils/controller-lock';

describe('duplicate controller diagnostics', () => {
  let tmpDir: string;
  const oldLockDir = process.env.OPENCHROME_CONTROLLER_LOCK_DIR;
  const oldUnsafe = process.env.OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-diagnostics-test-'));
    process.env.OPENCHROME_CONTROLLER_LOCK_DIR = tmpDir;
    delete process.env.OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (oldLockDir === undefined) delete process.env.OPENCHROME_CONTROLLER_LOCK_DIR;
    else process.env.OPENCHROME_CONTROLLER_LOCK_DIR = oldLockDir;
    if (oldUnsafe === undefined) delete process.env.OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH;
    else process.env.OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH = oldUnsafe;
  });

  test('infers global and npx OpenChrome process topology', () => {
    const globalProc = inferOpenChromeProcess(100, 'openchrome serve --auto-launch --port 9222 --user-data-dir /tmp/shared');
    const npxProc = inferOpenChromeProcess(101, 'npm exec openchrome-mcp@latest -- openchrome serve -p 9222 --user-data-dir /tmp/shared');

    expect(globalProc?.source).toBe('global');
    expect(npxProc?.source).toBe('npx');
    expect(globalProc?.port).toBe(9222);
    expect(globalProc?.userDataDir).toBe(path.resolve('/tmp/shared'));
  });

  test('groups duplicate processes by port and profile', () => {
    const processes = parsePsOutput([
      '100 1 openchrome serve --port 9222 --user-data-dir /tmp/shared',
      '101 1 npm exec openchrome-mcp@latest -- openchrome serve --port 9222 --user-data-dir /tmp/shared',
      '102 1 openchrome serve --port 9223 --user-data-dir /tmp/shared',
    ].join('\n'));

    const groups = findDuplicateControllerGroups(processes);

    expect(groups).toHaveLength(1);
    expect(groups[0].processes.map((proc) => proc.pid)).toEqual([100, 101]);
  });

  test('detects stale Codex mcp.json and mixed registrations', () => {
    const codexToml = path.join(tmpDir, 'config.toml');
    const staleMcp = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(codexToml, '[mcp_servers.openchrome]\ncommand = "openchrome"\nargs = ["serve"]\n');
    fs.writeFileSync(staleMcp, JSON.stringify({ mcpServers: { openchrome: { command: 'npm', args: ['exec', 'openchrome-mcp@latest'] } } }));

    const configs = scanMcpConfigRegistrations([
      { client: 'codex', path: codexToml },
      { client: 'codex', path: staleMcp, stale: true },
    ]);

    expect(configs[0].risk).toBe('openchrome');
    expect(configs[1].risk).toBe('stale-config');
    const summary = summarizeDuplicateControllerDiagnostics({ processes: [], configs });
    expect(summary.mixedInstallations).toBe(true);
    expect(summary.warnings.join(' ')).toContain('stale MCP config');
  });

  test('reports current owner lock topology', () => {
    const profile = path.join(tmpDir, 'profile');
    const handle = acquireControllerLock({ port: 9333, userDataDir: profile }, tmpDir);

    const topology = getCurrentControllerTopology({ port: 9333, userDataDir: profile });

    expect(topology.role).toBe('owner');
    expect(topology.ownerPid).toBe(process.pid);
    handle.release();
  });

  test('reports explicit unsafe secondary attach topology', () => {
    process.env.OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH = '1';

    const topology = getCurrentControllerTopology({ port: 9334, userDataDir: path.join(tmpDir, 'profile') });

    expect(topology.role).toBe('unsafe-secondary-attach');
    expect(topology.remediation).toContain('Disable OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH');
  });
});
