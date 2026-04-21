/**
 * Transport abstraction for MCP server.
 * Decouples the wire protocol (stdio, HTTP) from the MCP protocol logic.
 */

import { MCPResponse } from '../types/mcp';
import type { ApiKeyStore } from '../auth/api-key-store';

/**
 * Abstraction over the wire protocol (stdio or HTTP).
 * MCPServer delegates all I/O to the transport; it never reads stdin
 * or writes stdout directly.
 */
export interface MCPTransport {
  /**
   * Register the handler that processes incoming parsed JSON-RPC messages.
   * The handler returns a response for requests (those with an id),
   * or null for notifications (no id).
   *
   * The optional `signal` is provided by transports that can detect a client
   * disconnect (e.g. HTTP). When the signal aborts, the handler is expected
   * to abandon long-running tool calls (see issue #8 — B-2).
   */
  onMessage(
    handler: (msg: Record<string, unknown>, signal?: AbortSignal) => Promise<MCPResponse | null>,
  ): void;

  /**
   * Send a JSON-RPC response or notification to the client.
   * For stdio this writes to stdout; for HTTP this is used only for
   * server-initiated notifications (request responses go through the
   * HTTP response object directly).
   */
  send(response: MCPResponse): void;

  /** Start listening for messages (bind port or attach readline). */
  start(): void;

  /** Graceful shutdown. */
  close(): Promise<void>;
}

export type TransportMode = 'stdio' | 'http' | 'both';

export interface TransportOptions {
  port?: number;
  host?: string;
  authToken?: string;
  /**
   * Optional multi-tenant API key store. When provided, the HTTP transport
   * resolves auth to `api-key` mode (see HTTPTransport.resolveAuthMode) and
   * every /mcp request is authenticated against a stored key instead of the
   * legacy shared token. Without this, the transport silently falls through
   * to legacy or disabled mode — so real deployments that want per-tenant
   * keys must pass this option.
   */
  apiKeyStore?: ApiKeyStore;
}

/**
 * Factory: create the appropriate transport based on mode.
 * For 'both' mode, this returns an HTTP transport; stdio is handled
 * separately in the CLI entry point (index.ts).
 */
export function createTransport(mode: TransportMode, options?: TransportOptions): MCPTransport {
  if (mode === 'http' || mode === 'both') {
    // Use require to avoid loading HTTP module when not needed
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HTTPTransport } = require('./http');
    return new HTTPTransport(
      options?.port || 3100,
      options?.host || '127.0.0.1',
      options?.authToken,
      options?.apiKeyStore ? { apiKeyStore: options.apiKeyStore } : undefined,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { StdioTransport } = require('./stdio');
  return new StdioTransport();
}

