export type SupportedMCPClient = 'claude' | 'codex';
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

const SUPPORTED_CLIENTS: SupportedMCPClient[] = ['claude', 'codex'];

export function getSupportedMCPClients(): SupportedMCPClient[] {
  return [...SUPPORTED_CLIENTS];
}

export function isSupportedMCPClient(value: string): value is SupportedMCPClient {
  return SUPPORTED_CLIENTS.includes(value as SupportedMCPClient);
}

export function getClientLabel(client: SupportedMCPClient): string {
  return client === 'claude' ? 'Claude Code' : 'Codex CLI';
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
    command: 'npm',
    args: ['exec', '--yes', '--prefer-online', 'openchrome-mcp@latest', '--', ...getServeArgs(options)],
  };
}

export function getClaudeManualServerConfig(options: ServeArgOptions = {}): MCPServerConfig {
  return {
    command: 'npx',
    args: ['-y', 'openchrome-mcp@latest', ...getServeArgs(options)],
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
    'npx',
    '--prefer-online',
    '-y',
    'openchrome-mcp@latest',
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
