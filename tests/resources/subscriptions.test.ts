import { ResourceSubscriptionManager } from '../../src/resources/subscriptions';
import { ResourceRpcError, RESOURCE_SUBSCRIPTION_LIMIT_CODE } from '../../src/resources/live-state';

describe('ResourceSubscriptionManager (#872)', () => {
  test('enforces per-session subscription limit and allows idempotent repeat', () => {
    const manager = new ResourceSubscriptionManager({ limit: 1, debounceMs: 1 });
    expect(manager.subscribe('oc://session/a/tabs', 'mcp-1')).toEqual({
      uri: 'oc://session/a/tabs',
      subscriptions: 1,
      limit: 1,
    });
    expect(manager.subscribe('oc://session/a/tabs', 'mcp-1').subscriptions).toBe(1);
    expect(() => manager.subscribe('oc://session/a/state', 'mcp-1')).toThrow(ResourceRpcError);
    try {
      manager.subscribe('oc://session/a/state', 'mcp-1');
    } catch (err) {
      expect((err as ResourceRpcError).code).toBe(RESOURCE_SUBSCRIPTION_LIMIT_CODE);
    }
  });

  test('emits updated notifications only to subscribed MCP sessions', async () => {
    const manager = new ResourceSubscriptionManager({ limit: 5, debounceMs: 1 });
    manager.subscribe('oc://session/a/tabs', 's1');
    manager.subscribe('oc://session/b/tabs', 's2');
    const sent: Array<{ sessionId: string; method: string; uri?: string }> = [];
    const transport = {
      sendToSession: (sessionId: string, response: any) => {
        sent.push({ sessionId, method: response.method, uri: response.params?.uri });
        return true;
      },
      send: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
      onMessage: jest.fn(),
    } as any;

    manager.emitUpdated('oc://session/a/tabs', transport);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent).toEqual([
      { sessionId: 's1', method: 'notifications/resources/updated', uri: 'oc://session/a/tabs' },
    ]);
  });

  test('disconnect cleanup removes active subscriptions', () => {
    const manager = new ResourceSubscriptionManager({ limit: 5, debounceMs: 1 });
    manager.subscribe('oc://session/a/tabs', 's1');
    expect(manager.activeCount('s1')).toBe(1);
    manager.cleanupSession('s1');
    expect(manager.activeCount('s1')).toBe(0);
  });
});
