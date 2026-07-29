import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ServerEvent,
  ServerEventBus,
} from '@modelcontextprotocol/server';

const subscriptionTenantStore = new AsyncLocalStorage<string>();

export function runWithSubscriptionTenant<T>(
  tenantId: string,
  callback: () => T,
): T {
  return subscriptionTenantStore.run(tenantId, callback);
}

interface TenantListener {
  tenantId?: string;
  listener: (event: ServerEvent) => void;
}

/**
 * Keeps modern HTTP change streams inside the authenticated tenant that
 * opened them. Global registry events can still be broadcast explicitly.
 */
export class TenantScopedServerEventBus implements ServerEventBus {
  private readonly listeners = new Set<TenantListener>();

  constructor(private readonly onerror?: (error: Error) => void) {}

  publish(event: ServerEvent): void {
    for (const entry of this.listeners) {
      this.deliver(entry.listener, event);
    }
  }

  publishForTenant(event: ServerEvent, tenantId: string): void {
    for (const entry of this.listeners) {
      if (entry.tenantId !== tenantId) continue;
      this.deliver(entry.listener, event);
    }
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    const entry: TenantListener = {
      tenantId: subscriptionTenantStore.getStore(),
      listener,
    };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private deliver(listener: (event: ServerEvent) => void, event: ServerEvent): void {
    try {
      listener(event);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
