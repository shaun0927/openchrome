import type { MCPResponse } from '../types/mcp';
import type { MCPTransport } from '../transports';
import { currentRequestContext } from '../observability/request-id';
import { parseResourceSubscriptionLimit, RESOURCE_SUBSCRIPTION_LIMIT_CODE, ResourceRpcError } from './live-state';

interface SubscriptionSession {
  uris: Set<string>;
  pending: Map<string, ReturnType<typeof setTimeout>>;
}

export class ResourceSubscriptionManager {
  private readonly sessions = new Map<string, SubscriptionSession>();
  private readonly limit: number;
  private readonly debounceMs: number;

  constructor(opts?: { limit?: number; debounceMs?: number }) {
    this.limit = opts?.limit ?? parseResourceSubscriptionLimit();
    this.debounceMs = opts?.debounceMs ?? 100;
  }

  subscribe(uri: string, mcpSessionId = currentRequestContext()?.mcpSessionId ?? 'stdio'): { uri: string; subscriptions: number; limit: number } {
    const session = this.getOrCreate(mcpSessionId);
    if (!session.uris.has(uri) && session.uris.size >= this.limit) {
      throw new ResourceRpcError(RESOURCE_SUBSCRIPTION_LIMIT_CODE, 'subscription_limit_exceeded', { limit: this.limit });
    }
    session.uris.add(uri);
    return { uri, subscriptions: session.uris.size, limit: this.limit };
  }

  unsubscribe(uri: string, mcpSessionId = currentRequestContext()?.mcpSessionId ?? 'stdio'): { uri: string; subscriptions: number } {
    if (!mcpSessionId) return { uri, subscriptions: 0 };
    const session = this.sessions.get(mcpSessionId);
    if (!session) return { uri, subscriptions: 0 };
    session.uris.delete(uri);
    const pending = session.pending.get(uri);
    if (pending) clearTimeout(pending);
    session.pending.delete(uri);
    const subscriptions = session.uris.size;
    if (subscriptions === 0) this.sessions.delete(mcpSessionId);
    return { uri, subscriptions };
  }

  cleanupSession(mcpSessionId: string): void {
    const session = this.sessions.get(mcpSessionId);
    if (!session) return;
    for (const timer of session.pending.values()) clearTimeout(timer);
    this.sessions.delete(mcpSessionId);
  }

  activeCount(mcpSessionId: string): number {
    return this.sessions.get(mcpSessionId)?.uris.size ?? 0;
  }

  isSubscribed(mcpSessionId: string, uri: string): boolean {
    return this.sessions.get(mcpSessionId)?.uris.has(uri) ?? false;
  }

  emitUpdated(uri: string, transport: MCPTransport | null): void {
    if (!transport) return;
    for (const [mcpSessionId, session] of this.sessions) {
      if (!session.uris.has(uri)) continue;
      if (session.pending.has(uri)) continue;
      const timer = setTimeout(() => {
        session.pending.delete(uri);
        const notification: MCPResponse = {
          jsonrpc: '2.0',
          id: null,
          method: 'notifications/resources/updated',
          params: { uri },
        } as unknown as MCPResponse;
        if (transport.sendToSession) {
          const sent = transport.sendToSession(mcpSessionId, notification);
          if (!sent) this.cleanupSession(mcpSessionId);
        } else {
          transport.send(notification);
        }
      }, this.debounceMs);
      timer.unref?.();
      session.pending.set(uri, timer);
    }
  }

  emitListChanged(transport: MCPTransport | null): void {
    if (!transport) return;
    const notification: MCPResponse = {
      jsonrpc: '2.0',
      id: null,
      method: 'notifications/resources/list_changed',
    } as unknown as MCPResponse;
    transport.send(notification);
  }

  private getOrCreate(mcpSessionId: string): SubscriptionSession {
    let session = this.sessions.get(mcpSessionId);
    if (!session) {
      session = { uris: new Set(), pending: new Map() };
      this.sessions.set(mcpSessionId, session);
    }
    return session;
  }
}
