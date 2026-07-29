/**
 * Dual-era stdio transport backed by the official MCP TypeScript SDK.
 *
 * The SDK owns opening-message negotiation: legacy clients initialize as
 * before, while 2026-07-28 clients can start with server/discover and carry
 * the required envelope on every request.
 */

import * as crypto from 'node:crypto';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { Server, Transport } from '@modelcontextprotocol/server';
import {
  createSdkServerAdapter,
  type CoreMcpMessageHandler,
} from '../mcp/sdk-adapter';
import type { MCPResponse } from '../types/mcp';
import type { MCPTransport } from './index';
import { shutdownSyncBestEffort } from '../utils/sync-shutdown';

type SessionCloseHandler = (sessionId: string) => void;

export class SdkStdioTransport implements MCPTransport {
  private messageHandler: CoreMcpMessageHandler | null = null;
  private handle: StdioServerHandle | null = null;
  private readonly servers = new Map<
    string,
    { server: Server; era: 'legacy' | 'modern'; legacySessionId?: string }
  >();
  private sessionCloseHandler: SessionCloseHandler | null = null;
  private started = false;

  constructor(private readonly wire?: Transport) {}

  private readonly onStdinEnd = (): void => {
    console.error('[SdkStdioTransport] stdin ended, shutting down...');
    try { shutdownSyncBestEffort(); } catch { /* never throw at exit */ }
    process.exit(0);
  };

  private readonly onStdinError = (): void => {
    console.error('[SdkStdioTransport] stdin error, shutting down...');
    try { shutdownSyncBestEffort(); } catch { /* never throw at exit */ }
    process.exit(1);
  };

  onMessage(handler: CoreMcpMessageHandler): void {
    this.messageHandler = handler;
  }

  onSessionClose(handler: SessionCloseHandler): void {
    this.sessionCloseHandler = handler;
  }

  start(): void {
    if (this.started) return;
    if (!this.messageHandler) {
      throw new Error('SdkStdioTransport requires a message handler before start()');
    }
    this.started = true;

    this.handle = serveStdio(
      ({ era }) => {
        const key = crypto.randomUUID();
        const legacySessionId = era === 'legacy' ? `stdio-${key}` : undefined;
        const server = createSdkServerAdapter(this.messageHandler!, {
          era,
          ...(legacySessionId ? { mcpSessionId: legacySessionId } : {}),
        });
        this.servers.set(key, { server, era, legacySessionId });

        const previousOnClose = server.onclose;
        server.onclose = () => {
          this.servers.delete(key);
          if (legacySessionId) {
            this.sessionCloseHandler?.(legacySessionId);
          }
          previousOnClose?.();
        };
        return server;
      },
      {
        legacy: 'serve',
        ...(this.wire ? { transport: this.wire } : {}),
        onerror: (error) => {
          console.error('[SdkStdioTransport] MCP SDK error:', error);
        },
      },
    );

    if (!this.wire) {
      process.stdin.once('end', this.onStdinEnd);
      process.stdin.once('error', this.onStdinError);
    }
  }

  send(response: MCPResponse): void {
    for (const { server, era } of this.servers.values()) {
      if (era === 'legacy') {
        this.sendNotification(server, response);
      }
    }
  }

  sendToSession(sessionId: string, response: MCPResponse): boolean {
    for (const entry of this.servers.values()) {
      if (entry.legacySessionId !== sessionId) continue;
      this.sendNotification(entry.server, response);
      return true;
    }
    return false;
  }

  publishToolsChanged(): void {
    this.publishModern((server) => server.sendToolListChanged());
  }

  publishResourcesChanged(_tenantId?: string): void {
    this.publishModern((server) => server.sendResourceListChanged());
  }

  publishResourceUpdated(uri: string, _tenantId?: string): void {
    this.publishModern((server) => server.sendResourceUpdated({ uri }));
  }

  async close(): Promise<void> {
    process.stdin.removeListener('end', this.onStdinEnd);
    process.stdin.removeListener('error', this.onStdinError);
    const handle = this.handle;
    this.handle = null;
    this.started = false;
    if (handle) {
      await handle.close();
    }
    this.servers.clear();
  }

  private sendNotification(server: Server, response: MCPResponse): void {
    const notification = response as unknown as {
      method?: string;
      params?: Record<string, unknown>;
    };
    let pending: Promise<unknown> | undefined;
    switch (notification.method) {
      case 'notifications/tools/list_changed':
        pending = server.sendToolListChanged();
        break;
      case 'notifications/resources/list_changed':
        pending = server.sendResourceListChanged();
        break;
      case 'notifications/resources/updated':
        if (typeof notification.params?.uri === 'string') {
          pending = server.sendResourceUpdated({ uri: notification.params.uri });
        }
        break;
      case 'notifications/message': {
        const level = notification.params?.level;
        if (typeof level === 'string') {
          pending = server.sendLoggingMessage(
            notification.params as Parameters<typeof server.sendLoggingMessage>[0],
          );
        }
        break;
      }
      default:
        break;
    }
    void pending?.catch((error) => {
      console.error('[SdkStdioTransport] notification failed:', error);
    });
  }

  private publishModern(send: (server: Server) => Promise<unknown>): void {
    for (const entry of this.servers.values()) {
      if (entry.era !== 'modern') continue;
      void send(entry.server).catch((error) => {
        console.error('[SdkStdioTransport] subscription event failed:', error);
      });
    }
  }
}
