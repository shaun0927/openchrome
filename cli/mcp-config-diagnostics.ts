import fs from 'fs';
import os from 'os';
import path from 'path';

export interface DetectedOpenChromeConfig {
  client: 'claude' | 'codex' | 'opencode';
  label: string;
  path: string;
  command: string;
  args: string[];
  port: string;
  userDataDir: string;
  direct: boolean;
  broker: boolean;
  connectBroker: boolean;
}

export interface DirectConfigGroup {
  key: string;
  port: string;
  userDataDir: string;
  configs: DetectedOpenChromeConfig[];
}

export interface MCPConfigDiagnostics {
  configs: DetectedOpenChromeConfig[];
  duplicateDirectGroups: DirectConfigGroup[];
  directConfigs: DetectedOpenChromeConfig[];
}

const DEFAULT_PORT = '9222';
const DEFAULT_USER_DATA_DIR = '<openchrome-default-profile>';

export function getHostConfigMigrationNotice(label = 'this MCP host'): string[] {
  return [
    'Package updates do not rewrite existing MCP host registrations.',
    `This setup refreshed ${label}'s OpenChrome command; restart the host session so it loads the new MCP namespace.`,
    'If a release requires a new topology, rerun setup for each host or edit its MCP config manually.',
  ];
}

export function classifyOpenChromeCommand(command: string, args: string[]): Omit<DetectedOpenChromeConfig, 'client' | 'label' | 'path'> | null {
  const commandParts = [command, ...args].filter(Boolean);
  const openchromeIndex = commandParts.findIndex(isOpenChromeExecutable);
  if (openchromeIndex === -1) return null;

  const serveArgs = commandParts.slice(openchromeIndex + 1);
  if (!serveArgs.includes('serve')) return null;

  const broker = serveArgs.includes('--broker');
  const connectBroker = serveArgs.includes('--connect-broker');
  const direct = !broker && !connectBroker;

  return {
    command,
    args,
    port: readFlagValue(serveArgs, '--port') ?? readFlagValue(serveArgs, '-p') ?? DEFAULT_PORT,
    userDataDir: readFlagValue(serveArgs, '--user-data-dir') ?? DEFAULT_USER_DATA_DIR,
    direct,
    broker,
    connectBroker,
  };
}

export function findDuplicateDirectGroups(configs: DetectedOpenChromeConfig[]): DirectConfigGroup[] {
  const groups = new Map<string, DirectConfigGroup>();
  for (const config of configs) {
    if (!config.direct) continue;
    const key = `${config.port}\0${config.userDataDir}`;
    const existing = groups.get(key) ?? {
      key,
      port: config.port,
      userDataDir: config.userDataDir,
      configs: [],
    };
    existing.configs.push(config);
    groups.set(key, existing);
  }
  return [...groups.values()].filter((group) => group.configs.length > 1);
}

export function analyzeOpenChromeConfigs(configs: DetectedOpenChromeConfig[]): MCPConfigDiagnostics {
  return {
    configs,
    duplicateDirectGroups: findDuplicateDirectGroups(configs),
    directConfigs: configs.filter((config) => config.direct),
  };
}

export function scanOpenChromeHostConfigs(homeDir = os.homedir()): MCPConfigDiagnostics {
  return analyzeOpenChromeConfigs([
    ...scanJsonHostConfig('claude', 'Claude Code', path.join(homeDir, '.claude.json')),
    ...scanCodexToml(path.join(homeDir, '.codex', 'config.toml')),
    ...scanJsonHostConfig('codex', 'Codex CLI', path.join(homeDir, '.codex', 'mcp.json')),
    ...scanJsonHostConfig('opencode', 'OpenCode', path.join(homeDir, '.config', 'opencode', 'opencode.json')),
  ]);
}

function isOpenChromeExecutable(part: string): boolean {
  const normalized = part.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  return basename === 'openchrome' || basename === 'openchrome.cmd' || basename === 'openchrome.exe';
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  const equalsValue = args.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length) || undefined;

  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

function scanJsonHostConfig(
  client: DetectedOpenChromeConfig['client'],
  label: string,
  filePath: string
): DetectedOpenChromeConfig[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return findOpenChromeEntriesInJson(document).map((entry) => ({
      ...entry,
      client,
      label,
      path: filePath,
    }));
  } catch {
    return [];
  }
}

function findOpenChromeEntriesInJson(value: unknown): Array<Omit<DetectedOpenChromeConfig, 'client' | 'label' | 'path'>> {
  const found: Array<Omit<DetectedOpenChromeConfig, 'client' | 'label' | 'path'>> = [];
  visitJson(value, (key, candidate) => {
    if (key !== 'openchrome' || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const record = candidate as Record<string, unknown>;
    const parsed = parseJsonOpenChromeEntry(record);
    if (parsed) found.push(parsed);
  });
  return found;
}

function visitJson(value: unknown, visitor: (key: string, value: unknown) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visitor(key, child);
    visitJson(child, visitor);
  }
}

function parseJsonOpenChromeEntry(record: Record<string, unknown>): Omit<DetectedOpenChromeConfig, 'client' | 'label' | 'path'> | null {
  if (typeof record.command === 'string') {
    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : [];
    return classifyOpenChromeCommand(record.command, args);
  }

  if (Array.isArray(record.command) && record.command.every((part) => typeof part === 'string')) {
    const [command, ...args] = record.command as string[];
    return classifyOpenChromeCommand(command, args);
  }

  return null;
}

function scanCodexToml(filePath: string): DetectedOpenChromeConfig[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const block = findTomlTableBlock(text, 'mcp_servers.openchrome');
    if (!block) return [];
    const command = readTomlString(block, 'command');
    const args = readTomlStringArray(block, 'args');
    if (!command) return [];
    const parsed = classifyOpenChromeCommand(command, args ?? []);
    return parsed ? [{ ...parsed, client: 'codex', label: 'Codex CLI', path: filePath }] : [];
  } catch {
    return [];
  }
}

function findTomlTableBlock(text: string, table: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) return null;
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\[/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function readTomlString(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*("(?:\\\\.|[^"])*")`, 'm'));
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

function readTomlStringArray(block: string, key: string): string[] | undefined {
  const match = block.match(new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(\\[(?:.|\\n)*?\\])`, 'm'));
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
