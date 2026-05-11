export type SupportedMCPClient = 'claude' | 'codex' | 'opencode';
export type SetupScope = 'user' | 'project';

export interface ServeArgOptions {
  autoLaunch?: boolean;
  dashboard?: boolean;
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
  const serveArgs = ['serve'];

  if (options.autoLaunch !== false) {
    serveArgs.push('--auto-launch');
  }

  if (options.dashboard) {
    serveArgs.push('--dashboard');
  }

  return serveArgs;
}

export function getCodexServerConfig(options: ServeArgOptions = {}): MCPServerConfig {
  return {
    command: 'openchrome',
    args: getServeArgs(options),
  };
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
    command: ['npx', '--prefer-online', '-y', 'openchrome-mcp@latest', ...getServeArgs(options)],
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
