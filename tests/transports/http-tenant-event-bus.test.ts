import {
  runWithSubscriptionTenant,
  TenantScopedServerEventBus,
} from '../../src/transports/http/tenant-event-bus';

describe('modern HTTP tenant event bus', () => {
  test('scopes resource events while retaining explicit global events', () => {
    const bus = new TenantScopedServerEventBus();
    const tenantA: string[] = [];
    const tenantB: string[] = [];

    runWithSubscriptionTenant('tenant-a', () => {
      bus.subscribe((event) => tenantA.push(event.kind));
    });
    runWithSubscriptionTenant('tenant-b', () => {
      bus.subscribe((event) => tenantB.push(event.kind));
    });

    bus.publishForTenant(
      { kind: 'resource_updated', uri: 'oc://session/a/state' },
      'tenant-a',
    );
    expect(tenantA).toEqual(['resource_updated']);
    expect(tenantB).toEqual([]);

    bus.publish({ kind: 'tools_list_changed' });
    expect(tenantA).toEqual(['resource_updated', 'tools_list_changed']);
    expect(tenantB).toEqual(['tools_list_changed']);
  });
});
