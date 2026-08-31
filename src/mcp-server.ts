import {
  MCPServer,
  getMCPServer as getMCPServerImpl,
  setMCPServerOptions as setMCPServerOptionsImpl,
  _resetMCPServerForTesting as resetMCPServerForTestingImpl,
  summarizeMcpResultForJournal as summarizeMcpResultForJournalImpl,
  isConnectionError as isConnectionErrorImpl,
  estimateOutputTokensFromChars as estimateOutputTokensFromCharsImpl,
  extractCacheStatus as extractCacheStatusImpl,
} from './mcp/server';
import type { MCPResult } from './types/mcp';

export { MCPServer, type MCPServerOptions } from './mcp/server';

export function summarizeMcpResultForJournal(result: MCPResult): string | undefined {
  return summarizeMcpResultForJournalImpl(result);
}

export function isConnectionError(error: unknown): boolean {
  return isConnectionErrorImpl(error);
}

export function setMCPServerOptions(options: Partial<import('./mcp/server').MCPServerOptions>): void {
  setMCPServerOptionsImpl(options);
}

export function getMCPServer(): MCPServer {
  return getMCPServerImpl();
}

export function _resetMCPServerForTesting(): void {
  resetMCPServerForTestingImpl();
}

export function estimateOutputTokensFromChars(chars: number): number {
  return estimateOutputTokensFromCharsImpl(chars);
}

export function extractCacheStatus(result: MCPResult): { status: string; keyVersion: string } | null {
  return extractCacheStatusImpl(result);
}
