/**
 * Unit tests for src/core/lifecycle/event-bus.ts (issue #857).
 *
 * Covers:
 *   - subscribe / unsubscribe
 *   - dispatch order (kind-specific before wildcard)
 *   - error isolation: sync throwing listener does not affect other listeners
 *   - error isolation: async (rejected promise) listener is counted but not re-thrown
 *   - wildcard subscription receives all event kinds
 *   - off-switch: OPENCHROME_LIFECYCLE_BUS=0 makes emit() a no-op
 *   - metrics counter incremented on listener error
 */

import {
  createLifecycleBus,
  isLifecycleBusEnabled,
  LIFECYCLE_LISTENER_ERROR_METRIC,
  resetLifecycleBusForTests,
} from '../../../src/core/lifecycle/event-bus';
import { MetricsCollector } from '../../../src/metrics/collector';
import type { LifecycleEvent } from '../../../src/core/lifecycle/events';

function makeLaunchEvent(overrides: Partial<LifecycleEvent & { kind: 'chrome:launch' }> = {}): LifecycleEvent {
  return {
    kind: 'chrome:launch',
    pid: 12345,
    port: 9222,
    userDataDir: '/tmp/test-profile',
    lifecycleMode: 'isolated',
    ts: Date.now(),
    ...overrides,
  } as LifecycleEvent;
}

function makeSessionEvent(): LifecycleEvent {
  return {
    kind: 'session:create',
    sessionId: 'sess-1',
    tenantId: 'default',
    ts: Date.now(),
  };
}

describe('LifecycleEventBus', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    resetLifecycleBusForTests();
    metrics = new MetricsCollector();
    metrics.registerCounter(
      LIFECYCLE_LISTENER_ERROR_METRIC,
      'test counter',
    );
    // Ensure bus is enabled for most tests
    delete process.env.OPENCHROME_LIFECYCLE_BUS;
  });

  afterEach(() => {
    delete process.env.OPENCHROME_LIFECYCLE_BUS;
    delete process.env.OPENCHROME_DEV_HOOKS;
    delete process.env.OPENCHROME_LIFECYCLE_INJECT_THROW;
    resetLifecycleBusForTests();
  });

  // ── subscribe / dispatch ────────────────────────────────────────────────

  it('dispatches to a kind-specific listener', () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    bus.on('chrome:launch', (ev) => { received.push(ev); });
    const ev = makeLaunchEvent();
    bus.emit(ev);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(ev);
  });

  it('does not dispatch to a listener for a different kind', () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    bus.on('chrome:exit', (ev) => { received.push(ev); });
    bus.emit(makeLaunchEvent());
    expect(received).toHaveLength(0);
  });

  // ── unsubscribe ─────────────────────────────────────────────────────────

  it('unsubscribe stops further deliveries', () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    const unsub = bus.on('chrome:launch', (ev) => { received.push(ev); });
    bus.emit(makeLaunchEvent());
    expect(received).toHaveLength(1);
    unsub();
    bus.emit(makeLaunchEvent());
    expect(received).toHaveLength(1); // no new delivery
  });

  it('unsubscribe is idempotent', () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    const unsub = bus.on('chrome:launch', (ev) => { received.push(ev); });
    unsub();
    expect(() => unsub()).not.toThrow();
    bus.emit(makeLaunchEvent());
    expect(received).toHaveLength(0);
  });

  // ── wildcard ────────────────────────────────────────────────────────────

  it('wildcard listener receives all event kinds', () => {
    const bus = createLifecycleBus(metrics);
    const kinds: string[] = [];
    bus.on('*', (ev) => { kinds.push(ev.kind); });
    bus.emit(makeLaunchEvent());
    bus.emit(makeSessionEvent());
    expect(kinds).toEqual(['chrome:launch', 'session:create']);
  });

  it('kind-specific listeners fire before wildcard', () => {
    const bus = createLifecycleBus(metrics);
    const order: string[] = [];
    bus.on('*', () => { order.push('wildcard'); });
    bus.on('chrome:launch', () => { order.push('specific'); });
    bus.emit(makeLaunchEvent());
    expect(order).toEqual(['specific', 'wildcard']);
  });

  it('wildcard unsubscribe stops deliveries', () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    const unsub = bus.on('*', (ev) => { received.push(ev); });
    bus.emit(makeLaunchEvent());
    unsub();
    bus.emit(makeLaunchEvent());
    expect(received).toHaveLength(1);
  });

  // ── error isolation (sync) ──────────────────────────────────────────────

  it('sync throwing listener does not prevent other listeners from running', () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    // First listener throws
    bus.on('chrome:launch', () => { throw new Error('boom'); });
    // Second listener must still run
    bus.on('chrome:launch', (ev) => { received.push(ev); });
    expect(() => bus.emit(makeLaunchEvent())).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it('sync throwing listener increments the error counter', () => {
    const bus = createLifecycleBus(metrics);
    function badListener() { throw new Error('sync-boom'); }
    bus.on('chrome:launch', badListener);
    bus.emit(makeLaunchEvent());
    const exported = metrics.export();
    expect(exported).toContain(LIFECYCLE_LISTENER_ERROR_METRIC);
    expect(exported).toContain('listener="badListener"');
    expect(exported).toContain('event="chrome:launch"');
  });

  // ── error isolation (async) ─────────────────────────────────────────────

  it('async rejecting listener is counted but emit() does not throw', async () => {
    const bus = createLifecycleBus(metrics);
    async function asyncBadListener(): Promise<void> {
      throw new Error('async-boom');
    }
    bus.on('chrome:launch', asyncBadListener);
    // emit() must return synchronously without throwing
    expect(() => bus.emit(makeLaunchEvent())).not.toThrow();
    // Give the microtask queue a tick to settle the rejection
    await new Promise((r) => setTimeout(r, 10));
    const exported = metrics.export();
    expect(exported).toContain('listener="asyncBadListener"');
  });

  it('async rejecting listener does not block other listeners', async () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    async function asyncBadListener(): Promise<void> { throw new Error('x'); }
    bus.on('chrome:launch', asyncBadListener);
    bus.on('chrome:launch', (ev) => { received.push(ev); });
    bus.emit(makeLaunchEvent());
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
  });

  // ── removeAllListeners ──────────────────────────────────────────────────

  it('removeAllListeners clears all subscriptions', () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    bus.on('chrome:launch', (ev) => { received.push(ev); });
    bus.on('*', (ev) => { received.push(ev); });
    bus.removeAllListeners();
    bus.emit(makeLaunchEvent());
    expect(received).toHaveLength(0);
  });

  // ── off-switch ──────────────────────────────────────────────────────────

  it('OPENCHROME_LIFECYCLE_BUS=0 makes emit() a no-op', () => {
    process.env.OPENCHROME_LIFECYCLE_BUS = '0';
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    bus.on('chrome:launch', (ev) => { received.push(ev); });
    bus.emit(makeLaunchEvent());
    expect(received).toHaveLength(0);
  });

  it('isLifecycleBusEnabled() returns false when OPENCHROME_LIFECYCLE_BUS=0', () => {
    process.env.OPENCHROME_LIFECYCLE_BUS = '0';
    expect(isLifecycleBusEnabled()).toBe(false);
  });

  it('isLifecycleBusEnabled() returns true when unset', () => {
    delete process.env.OPENCHROME_LIFECYCLE_BUS;
    expect(isLifecycleBusEnabled()).toBe(true);
  });

  // ── dispatch order (multiple kind-specific listeners) ───────────────────

  it('multiple kind-specific listeners run in registration order', () => {
    const bus = createLifecycleBus(metrics);
    const order: number[] = [];
    bus.on('chrome:launch', () => { order.push(1); });
    bus.on('chrome:launch', () => { order.push(2); });
    bus.on('chrome:launch', () => { order.push(3); });
    bus.emit(makeLaunchEvent());
    expect(order).toEqual([1, 2, 3]);
  });

  // ── dev-only error injection ─────────────────────────────────────────────

  it('OPENCHROME_LIFECYCLE_INJECT_THROW triggers error for named listener in dev mode', () => {
    process.env.NODE_ENV = 'test'; // not 'production'
    process.env.OPENCHROME_DEV_HOOKS = '1';
    process.env.OPENCHROME_LIFECYCLE_INJECT_THROW = 'myListener';
    const bus = createLifecycleBus(metrics);
    const otherReceived: LifecycleEvent[] = [];
    function myListener(_ev: LifecycleEvent) { /* will be injected */ }
    bus.on('chrome:launch', myListener);
    bus.on('chrome:launch', (ev) => { otherReceived.push(ev); });
    expect(() => bus.emit(makeLaunchEvent())).not.toThrow();
    // Other listener must still run
    expect(otherReceived).toHaveLength(1);
    // Error must be counted
    const exported = metrics.export();
    expect(exported).toContain('listener="myListener"');
  });
});
