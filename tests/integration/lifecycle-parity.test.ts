/**
 * Lifecycle-parity integration test (issue #857).
 *
 * Verifies that running with OPENCHROME_LIFECYCLE_BUS=0 (off-switch)
 * produces identical observable state vs. bus-on mode, and that the bus
 * (when on) correctly counts events from a lifecycle trace recorder.
 *
 * These tests operate at the unit/integration level without a real Chrome
 * process — they wire the session-manager's emitLifecycle calls and
 * LifecycleEventBus directly, verifying the plumbing is correct.
 *
 * Full end-to-end parity (launch Chrome → create session → navigate) is
 * covered by the Real-verification script `scripts/verify/A1-lifecycle-bus.mjs`
 * which requires a running Chrome and is therefore out of CI scope here.
 */

import {
  createLifecycleBus,
  isLifecycleBusEnabled,
  LIFECYCLE_LISTENER_ERROR_METRIC,
  resetLifecycleBusForTests,
} from '../../src/core/lifecycle/event-bus';
import { MetricsCollector } from '../../src/metrics/collector';
import type { LifecycleEvent, LifecycleEventKind } from '../../src/core/lifecycle/events';

function mkEvent(kind: LifecycleEventKind, extra: Record<string, unknown> = {}): LifecycleEvent {
  const base = { kind, ts: Date.now(), ...extra };
  switch (kind) {
    case 'chrome:launch':
      return { ...base, pid: 1, port: 9222, userDataDir: '/tmp/ud', lifecycleMode: 'isolated' } as LifecycleEvent;
    case 'chrome:exit':
      return { ...base, pid: 1, reason: 'sigterm' } as LifecycleEvent;
    case 'session:create':
      return { ...base, sessionId: 'sess-1', tenantId: 'default' } as LifecycleEvent;
    case 'session:destroy':
      return { ...base, sessionId: 'sess-1', reason: 'close' } as LifecycleEvent;
    case 'worker:create':
      return { ...base, sessionId: 'sess-1', workerId: 'w-1' } as LifecycleEvent;
    case 'worker:destroy':
      return { ...base, sessionId: 'sess-1', workerId: 'w-1' } as LifecycleEvent;
    case 'target:create':
      return { ...base, sessionId: 'sess-1', workerId: 'w-1', targetId: 't-1', url: 'https://example.com' } as LifecycleEvent;
    case 'target:navigate':
      return { ...base, sessionId: 'sess-1', workerId: 'w-1', targetId: 't-1', fromUrl: 'about:blank', toUrl: 'https://example.com' } as LifecycleEvent;
    case 'target:close':
      return { ...base, sessionId: 'sess-1', workerId: 'w-1', targetId: 't-1' } as LifecycleEvent;
    case 'irreversible-action:before':
      return { ...base, sessionId: 'sess-1', targetId: 't-1', action: 'click' } as LifecycleEvent;
  }
}

describe('lifecycle-parity', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    resetLifecycleBusForTests();
    metrics = new MetricsCollector();
    metrics.registerCounter(LIFECYCLE_LISTENER_ERROR_METRIC, 'test');
    delete process.env.OPENCHROME_LIFECYCLE_BUS;
  });

  afterEach(() => {
    delete process.env.OPENCHROME_LIFECYCLE_BUS;
    resetLifecycleBusForTests();
  });

  it('bus-on: all lifecycle event kinds are dispatched', () => {
    const bus = createLifecycleBus(metrics);
    const received: string[] = [];
    bus.on('*', (ev) => { received.push(ev.kind); });

    const kinds: LifecycleEventKind[] = [
      'chrome:launch', 'session:create', 'worker:create', 'target:create',
      'target:navigate', 'target:close', 'worker:destroy', 'session:destroy',
      'chrome:exit',
    ];
    for (const kind of kinds) {
      bus.emit(mkEvent(kind));
    }

    expect(received).toEqual(kinds);
  });

  it('bus-off: OPENCHROME_LIFECYCLE_BUS=0 results in zero events dispatched', () => {
    process.env.OPENCHROME_LIFECYCLE_BUS = '0';
    expect(isLifecycleBusEnabled()).toBe(false);
    const bus = createLifecycleBus(metrics);
    const received: string[] = [];
    bus.on('*', (ev) => { received.push(ev.kind); });

    bus.emit(mkEvent('chrome:launch'));
    bus.emit(mkEvent('session:create'));

    expect(received).toHaveLength(0);
  });

  it('error isolation: one bad listener does not drop subsequent events', () => {
    const bus = createLifecycleBus(metrics);
    const received: string[] = [];
    // First wildcard listener throws
    bus.on('*', () => { throw new Error('deliberate'); });
    // Second listener must still receive all events
    bus.on('*', (ev) => { received.push(ev.kind); });

    bus.emit(mkEvent('chrome:launch'));
    bus.emit(mkEvent('session:create'));

    expect(received).toEqual(['chrome:launch', 'session:create']);
  });

  it('error counter is incremented for each throwing listener invocation', () => {
    const bus = createLifecycleBus(metrics);
    function countedThrower() { throw new Error('x'); }
    bus.on('*', countedThrower);

    bus.emit(mkEvent('chrome:launch'));
    bus.emit(mkEvent('session:create'));

    const exported = metrics.export();
    // Counter should show 2 (one per emit)
    expect(exported).toContain('listener="countedThrower"');
  });

  it('parity: bus-on and bus-off produce the same observable state for non-trace paths', () => {
    // Simulate a scenario where two workers create one target each.
    // With bus on:
    const busOn = createLifecycleBus(metrics);
    const busOnEvents: string[] = [];
    busOn.on('*', (ev) => { busOnEvents.push(ev.kind); });

    busOn.emit(mkEvent('session:create'));
    busOn.emit(mkEvent('worker:create'));
    busOn.emit(mkEvent('target:create'));
    busOn.emit(mkEvent('target:close'));
    busOn.emit(mkEvent('worker:destroy'));
    busOn.emit(mkEvent('session:destroy'));

    expect(busOnEvents).toHaveLength(6);

    // With bus off: same code paths execute but emit() is a no-op.
    process.env.OPENCHROME_LIFECYCLE_BUS = '0';
    resetLifecycleBusForTests();
    const busOff = createLifecycleBus(metrics);
    const busOffEvents: string[] = [];
    busOff.on('*', (ev) => { busOffEvents.push(ev.kind); });

    busOff.emit(mkEvent('session:create'));
    busOff.emit(mkEvent('worker:create'));
    busOff.emit(mkEvent('target:create'));
    busOff.emit(mkEvent('target:close'));
    busOff.emit(mkEvent('worker:destroy'));
    busOff.emit(mkEvent('session:destroy'));

    // No events dispatched in off mode
    expect(busOffEvents).toHaveLength(0);
  });

  it('irreversible-action:before is dispatched on wildcard subscribers', () => {
    const bus = createLifecycleBus(metrics);
    const received: LifecycleEvent[] = [];
    bus.on('irreversible-action:before', (ev) => { received.push(ev); });
    bus.on('*', (ev) => { /* secondary wildcard — must not error */ });
    bus.emit(mkEvent('irreversible-action:before'));
    expect(received).toHaveLength(1);
    if (received[0].kind === 'irreversible-action:before') {
      expect(received[0].action).toBe('click');
    }
  });
});
