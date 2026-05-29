import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ProfileManager } from '../chrome/profile-manager';
import { getControllerLockPath, isPidAlive, normalizeControllerUserDataDir } from './controller-lock';

export interface OpenChromeProcessInfo {
  pid: number;
  ppid?: number;
  command: string;
  port: number;
  userDataDir: string;
  source: 'global' | 'npx' | 'local' | 'unknown';
}

export interface DuplicateControllerGroup {
  port: number;
  userDataDir: string;
  processes: OpenChromeProcessInfo[];
}

export interface McpConfigRegistration {
  client: 'codex' | 'claude' | 'opencode' | 'unknown';
  path: string;
  exists: boolean;
  stale?: boolean;
  registrationCount: number;
  commands: string[];
  risk: 'none' | 'openchrome' | 'mixed-installation' | 'stale-config';
}

export interface DuplicateControllerDiagnostics {
  processes: OpenChromeProcessInfo[];
  duplicateGroups: DuplicateControllerGroup[];
  configs: McpConfigRegistration[];
  mixedInstallations: boolean;
  warnings: string[];
  remediation: string[];
}

const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE = '<default-profile>';

function tokenize(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) ?? [];
}

function optionValue(tokens: string[], longName: string, shortName?: string): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === longName || (shortName && token === shortName)) return tokens[i + 1];
    if (token.startsWith(`${longName}=`)) return token.slice(longName.length + 1);
  }
  return undefined;
}

function envValue(command: string, name: string): string | undefined {
  const match = command.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`));
  return match?.[1];
}

export function inferOpenChromeProcess(pid: number, command: string, ppid?: number): OpenChromeProcessInfo | null {
  if (!/(openchrome|openchrome-mcp)/.test(command)) return null;
  if (!/(serve|dist\/index\.js|openchrome-mcp)/.test(command)) return null;
  if (/grep /.test(command)) return null;

  const tokens = tokenize(command);
  const rawPort = optionValue(tokens, '--port', '-p') ?? envValue(command, 'CHROME_PORT') ?? String(DEFAULT_PORT);
  const port = parseInt(rawPort, 10);
  const userDataDir = optionValue(tokens, '--user-data-dir') ?? envValue(command, 'CHROME_USER_DATA_DIR') ?? envValue(command, 'OPENCHROME_USER_DATA_DIR') ?? DEFAULT_PROFILE;
  let source: OpenChromeProcessInfo['source'] = 'unknown';
  if (command.includes('npm exec') || command.includes('npx') || command.includes('/_npx/') || command.includes('openchrome-mcp@')) source = 'npx';
  else if (command.includes('/node_modules/openchrome-mcp/') || /(^|\s)openchrome(\s|$)/.test(command)) source = 'global';
  else if (command.includes('dist/index.js')) source = 'local';

  return {
    pid,
    ...(ppid !== undefined ? { ppid } : {}),
    command,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    userDataDir: userDataDir === DEFAULT_PROFILE ? DEFAULT_PROFILE : normalizeControllerUserDataDir(userDataDir),
    source,
  };
}

export function parsePsOutput(output: string): OpenChromeProcessInfo[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(?:(\d+)\s+)?(.+)$/);
      if (!match) return null;
      return inferOpenChromeProcess(parseInt(match[1], 10), match[3], match[2] ? parseInt(match[2], 10) : undefined);
    })
    .filter((entry): entry is OpenChromeProcessInfo => entry !== null);
}

export function scanOpenChromeProcesses(): OpenChromeProcessInfo[] {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000 });
    return parsePsOutput(output).filter((proc) => proc.pid !== process.pid);
  } catch {
    return [];
  }
}

export function findDuplicateControllerGroups(processes: OpenChromeProcessInfo[]): DuplicateControllerGroup[] {
  const groups = new Map<string, OpenChromeProcessInfo[]>();
  for (const proc of processes) {
    const key = `${proc.port}\u0000${proc.userDataDir}`;
    groups.set(key, [...(groups.get(key) ?? []), proc]);
  }
  return Array.from(groups.values())
    .filter((items) => items.length > 1)
    .map((items) => ({ port: items[0].port, userDataDir: items[0].userDataDir, processes: items }));
}

function defaultConfigPaths(home = os.homedir()): Array<{ client: McpConfigRegistration['client']; path: string; stale?: boolean }> {
  return [
    { client: 'codex', path: path.join(home, '.codex', 'config.toml') },
    { client: 'codex', path: path.join(home, '.codex', 'mcp.json'), stale: true },
    { client: 'claude', path: path.join(home, '.claude.json') },
    { client: 'claude', path: path.join(home, '.claude', 'mcp.json') },
    { client: 'opencode', path: path.join(home, '.config', 'opencode', 'opencode.json') },
    { client: 'opencode', path: path.join(home, '.opencode.json') },
  ];
}

function extractOpenChromeCommands(content: string): string[] {
  const lines = content.split('\n').filter((line) => /openchrome|openchrome-mcp/.test(line));
  if (lines.length > 0) return lines.map((line) => line.trim()).filter(Boolean);
  return /openchrome|openchrome-mcp/.test(content) ? ['<json registration containing openchrome>'] : [];
}

export function scanMcpConfigRegistrations(pathsToScan?: Array<{ client: McpConfigRegistration['client']; path: string; stale?: boolean }>): McpConfigRegistration[] {
  const envPaths = process.env.OPENCHROME_MCP_CONFIG_PATHS?.split(path.delimiter).filter(Boolean);
  const candidates: Array<{ client: McpConfigRegistration['client']; path: string; stale?: boolean }> =
    pathsToScan ?? (envPaths ? envPaths.map((p) => ({ client: 'unknown' as const, path: p })) : defaultConfigPaths());

  return candidates.map((candidate) => {
    let content = '';
    let exists = false;
    try {
      content = fs.readFileSync(candidate.path, 'utf8');
      exists = true;
    } catch {
      // absent or unreadable config files are treated as no registration.
    }
    const commands = exists ? extractOpenChromeCommands(content) : [];
    const hasNpx = commands.some((cmd) => /npm exec|npx|openchrome-mcp@|_npx/.test(cmd));
    const hasGlobal = commands.some((cmd) => /openchrome(\s|["']|$)|node_modules\/openchrome-mcp/.test(cmd));
    const risk: McpConfigRegistration['risk'] = commands.length === 0
      ? 'none'
      : candidate.stale
        ? 'stale-config'
        : hasNpx && hasGlobal
          ? 'mixed-installation'
          : 'openchrome';
    return {
      client: candidate.client,
      path: candidate.path,
      exists,
      ...(candidate.stale ? { stale: true } : {}),
      registrationCount: commands.length,
      commands,
      risk,
    };
  });
}

export function summarizeDuplicateControllerDiagnostics(options: {
  processes?: OpenChromeProcessInfo[];
  configs?: McpConfigRegistration[];
} = {}): DuplicateControllerDiagnostics {
  const processes = options.processes ?? scanOpenChromeProcesses();
  const duplicateGroups = findDuplicateControllerGroups(processes);
  const configs = options.configs ?? scanMcpConfigRegistrations();
  const processSources = new Set(processes.map((proc) => proc.source).filter((source) => source !== 'unknown'));
  const configMixed = configs.some((config) => config.risk === 'mixed-installation')
    || configs.filter((config) => config.registrationCount > 0).some((config) => config.commands.some((cmd) => /npm exec|npx|openchrome-mcp@|_npx/.test(cmd)))
      && configs.filter((config) => config.registrationCount > 0).some((config) => config.commands.some((cmd) => /openchrome(\s|["']|$)|node_modules\/openchrome-mcp/.test(cmd)));
  const mixedInstallations = processSources.has('npx') && (processSources.has('global') || processSources.has('local')) || configMixed;
  const staleConfigs = configs.filter((config) => config.stale && config.registrationCount > 0);

  const warnings: string[] = [];
  if (duplicateGroups.length > 0) {
    warnings.push(`${duplicateGroups.length} duplicate OpenChrome controller group(s) detected`);
  }
  if (mixedInstallations) warnings.push('mixed OpenChrome registrations detected (for example global openchrome plus npm/npx openchrome-mcp@latest)');
  if (staleConfigs.length > 0) warnings.push(`stale MCP config registration(s) detected: ${staleConfigs.map((config) => config.path).join(', ')}`);

  const remediation = [
    'Keep exactly one direct OpenChrome controller per Chrome port/profile until broker mode is available.',
    'Prefer assigning different --port and --user-data-dir values to independent MCP clients, or route clients through the future broker topology.',
    'Remove stale MCP registrations such as ~/.codex/mcp.json after migrating to the active client config.',
  ];

  return { processes, duplicateGroups, configs, mixedInstallations, warnings, remediation };
}

export function getCurrentControllerTopology(options: { port?: number; userDataDir?: string } = {}): {
  role: 'owner' | 'unsafe-secondary-attach' | 'unlocked' | 'unknown';
  port: number;
  userDataDir: string;
  lockPath: string;
  ownerPid?: number;
  remediation?: string;
} {
  const port = options.port ?? parseInt(process.env.CHROME_PORT ?? String(DEFAULT_PORT), 10);
  const userDataDir = normalizeControllerUserDataDir(options.userDataDir ?? process.env.CHROME_USER_DATA_DIR ?? process.env.OPENCHROME_USER_DATA_DIR ?? ProfileManager.PERSISTENT_PROFILE_DIR);
  const lockPath = getControllerLockPath(port, userDataDir);
  if (process.env.OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH === '1') {
    return {
      role: 'unsafe-secondary-attach',
      port,
      userDataDir,
      lockPath,
      remediation: 'Disable OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH and use one owner per port/profile, isolated profiles, or broker mode.',
    };
  }
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed.pid === 'number' && isPidAlive(parsed.pid)) {
      return { role: parsed.pid === process.pid ? 'owner' : 'unknown', port, userDataDir, lockPath, ownerPid: parsed.pid };
    }
    return { role: 'unlocked', port, userDataDir, lockPath };
  } catch {
    return { role: 'unlocked', port, userDataDir, lockPath };
  }
}
