export type SupportedMCPClient = 'claude' | 'codex' | 'opencode';
export type SetupScope = 'user' | 'project';

export type TopologyPreset = 'single-owner' | 'isolated' | 'ci-headless' | 'dev-profile';

export interface ServeArgOptions {
  autoLaunch?: boolean;
  dashboard?: boolean;
  port?: string | number;
  userDataDir?: string;
  profileDirectory?: string;
  launchMode?: string;
  topology?: TopologyPreset;
}

export interface MCPServerConfig {
  command: string;
  args: string[];
}

export interface MCPConfigDocument {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenCodeLocalMCPServerConfig {
  type: 'local';
  command: string[];
  enabled?: boolean;
}

export interface OpenCodeConfigDocument {
  mcp?: Record<string, unknown>;
  [key: string]: unknown;
}

const SUPPORTED_CLIENTS: SupportedMCPClient[] = ['claude', 'codex', 'opencode'];

export function getSupportedMCPClients(): SupportedMCPClient[] {
  return [...SUPPORTED_CLIENTS];
}

export function isSupportedMCPClient(value: string): value is SupportedMCPClient {
  return SUPPORTED_CLIENTS.includes(value as SupportedMCPClient);
}

export function getClientLabel(client: SupportedMCPClient): string {
  switch (client) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex CLI';
    case 'opencode':
      return 'OpenCode';
  }
}

export function getServeArgs(options: ServeArgOptions = {}): string[] {
  const resolved = resolveTopologyOptions(options);
  const serveArgs = ['serve'];

  if (resolved.autoLaunch !== false) {
    serveArgs.push('--auto-launch');
  }

  if (resolved.port !== undefined) {
    serveArgs.push('--port', String(resolved.port));
  }

  if (resolved.userDataDir) {
    serveArgs.push('--user-data-dir', resolved.userDataDir);
  }

  if (resolved.profileDirectory) {
    serveArgs.push('--profile-directory', resolved.profileDirectory);
  }

  if (resolved.launchMode) {
    serveArgs.push('--launch-mode', resolved.launchMode);
  }

  if (resolved.dashboard) {
    serveArgs.push('--dashboard');
  }

  return serveArgs;
}

export function resolveTopologyOptions(options: ServeArgOptions = {}): ServeArgOptions {
  const next: ServeArgOptions = { ...options };
  switch (options.topology) {
    case 'isolated':
      next.port ??= 9223;
      next.userDataDir ??= '~/.openchrome/profiles/isolated';
      next.launchMode ??= 'isolated';
      break;
    case 'ci-headless':
      next.port ??= 9224;
      next.userDataDir ??= '~/.openchrome/profiles/ci';
      next.launchMode ??= 'isolated';
      break;
    case 'dev-profile':
      next.port ??= 9225;
      next.userDataDir ??= '~/.openchrome/profiles/dev';
      break;
    case 'single-owner':
    case undefined:
      break;
  }
  return next;
}

export function getTopologyWarning(options: ServeArgOptions = {}): string | null {
  const resolved = resolveTopologyOptions(options);
  const usingDefaultPortProfile = resolved.port === undefined && !resolved.userDataDir;
  if (!usingDefaultPortProfile) return null;
  return 'Topology note: this config uses the default single-owner Chrome port/profile. Do not install the same direct config in multiple MCP clients at once; choose --topology isolated or explicit --port + --user-data-dir until broker mode is available.';
}

export function getCodexServerConfig(options: ServeArgOptions = {}): MCPServerConfig {
  return {
    command: 'openchrome',
    args: getServeArgs(options),
  };
}

export function getCodexSetupCommand(options: ServeArgOptions = {}): string[] {
  return ['mcp', 'add', 'openchrome', '--', 'openchrome', ...getServeArgs(options)];
}

export function formatCodexMCPServerConfigSnippet(serverName: string, serverConfig: MCPServerConfig): string {
  const quotedArgs = serverConfig.args.map((arg) => JSON.stringify(arg)).join(', ');
  return [
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(serverConfig.command)}`,
    `args = [${quotedArgs}]`,
  ].join('\n');
}

export function getClaudeManualServerConfig(options: ServeArgOptions = {}): MCPServerConfig {
  return {
    command: 'openchrome',
    args: getServeArgs(options),
  };
}

export function getOpenCodeServerConfig(options: ServeArgOptions = {}): OpenCodeLocalMCPServerConfig {
  return {
    type: 'local',
    command: ['openchrome', ...getServeArgs(options)],
  };
}

export function getClaudeSetupCommand(scope: SetupScope, options: ServeArgOptions = {}): string[] {
  return [
    'mcp',
    'add',
    'openchrome',
    '-s',
    scope,
    '--',
    'openchrome',
    ...getServeArgs(options),
  ];
}

export function upsertMCPServerConfig(
  document: MCPConfigDocument,
  serverName: string,
  serverConfig: MCPServerConfig
): MCPConfigDocument {
  const nextDocument: MCPConfigDocument = { ...document };
  const nextServers =
    document.mcpServers && typeof document.mcpServers === 'object' && !Array.isArray(document.mcpServers)
      ? { ...document.mcpServers }
      : {};

  nextServers[serverName] = serverConfig as unknown as Record<string, unknown>;
  nextDocument.mcpServers = nextServers;
  return nextDocument;
}

export function formatMCPServerConfigSnippet(
  serverName: string,
  serverConfig: MCPServerConfig
): string {
  return JSON.stringify(
    {
      mcpServers: {
        [serverName]: serverConfig,
      },
    },
    null,
    2
  );
}

export function upsertOpenCodeMCPServerConfig(
  document: OpenCodeConfigDocument,
  serverName: string,
  serverConfig: OpenCodeLocalMCPServerConfig
): OpenCodeConfigDocument {
  const nextDocument: OpenCodeConfigDocument = { ...document };
  const nextServers =
    document.mcp && typeof document.mcp === 'object' && !Array.isArray(document.mcp) ? { ...document.mcp } : {};

  nextServers[serverName] = serverConfig as unknown as Record<string, unknown>;
  nextDocument.mcp = nextServers;
  return nextDocument;
}

export function formatOpenCodeMCPServerConfigSnippet(
  serverName: string,
  serverConfig: OpenCodeLocalMCPServerConfig
): string {
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        [serverName]: serverConfig,
      },
    },
    null,
    2
  );
}
