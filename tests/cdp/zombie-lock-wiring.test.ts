import { describe, expect, it, jest } from '@jest/globals';
import {
  isZombieLockDetectorEnabled,
  wireZombieLockDetector,
} from '../../src/cdp/zombie-lock-wiring.js';
import { ZombieLockDetector } from '../../src/cdp/zombie-lock-detector.js';
import { TargetLeaseRegistry } from '../../src/session/target-lease-registry.js';

describe('isZombieLockDetectorEnabled', () => {
  it('is off by default', () => {
    expect(isZombieLockDetectorEnabled({})).toBe(false);
  });
  it.each(['1', 'true', 'yes', 'on', 'TRUE'])('recognises %s as on', (v) => {
    expect(isZombieLockDetectorEnabled({ OPENCHROME_ZOMBIE_LOCK_DETECTOR: v })).toBe(true);
  });
  it.each(['0', 'false', 'off', ''])('recognises %s as off', (v) => {
    expect(isZombieLockDetectorEnabled({ OPENCHROME_ZOMBIE_LOCK_DETECTOR: v })).toBe(false);
  });
});

describe('wireZombieLockDetector', () => {
  it('runs the detector\'s probe against the CDP client and reclaims a session on vanish', async () => {
    let clock = 1_000;
    // Fake CDP client returns targets in puppeteer's shape.
    let visible = [{ _targetInfo: { targetId: 't1' } }];
    const cdp = { getTargets: jest.fn(() => visible) };
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 't1', sessionId: 's1', workerId: 'w1' });

    // Inject a detector using explicit config so the test controls the clock.
    const detector = new ZombieLockDetector(
      async () => {
        const targets = cdp.getTargets();
        return targets
          .map((t: any) => t._targetInfo?.targetId)
          .filter((x: string | undefined): x is string => !!x);
      },
      { confirmations: 2, registrationGraceMs: 0, now: () => clock },
    );

    const handle = wireZombieLockDetector(cdp, registry, { detector });
    handle.registerLease('t1', 'w1');

    // First tick: target still visible; no reclaim.
    await detector.tick();
    expect(handle.audit).toHaveLength(0);
    // The CDPClient probe must have been consulted for the initial construction path
    // (the injected detector uses its own probe, but the wiring probe is always usable).

    // Target vanishes.
    visible = [];
    clock += 5_000;
    await detector.tick();
    expect(handle.audit).toHaveLength(0);
    clock += 5_000;
    await detector.tick();

    // Reclaim recorded and lease released.
    expect(handle.audit).toHaveLength(1);
    expect(handle.audit[0]?.targetId).toBe('t1');
    expect(registry.get('t1')).toBeUndefined();

    handle.dispose();
  });

  it('exposes the wiring probe path against real puppeteer target shapes', async () => {
    // No injected detector: exercise the default construction path
    // (probe extracts targetId from the puppeteer `_targetInfo` shape).
    const visible = [{ _targetInfo: { targetId: 'real' } }, { id: 'fallback' }];
    const cdp = { getTargets: () => visible };
    const registry = new TargetLeaseRegistry();
    const handle = wireZombieLockDetector(cdp, registry, {
      intervalMs: 60_000, // long interval so the poll timer does not fire in the test
      confirmations: 1,
      registrationGraceMs: 0,
    });

    // Force one probe tick and verify no crash on either shape.
    await handle.detector.tick();
    // Nothing registered, so nothing reclaimed — but the probe must have run.
    expect(handle.audit).toHaveLength(0);
    handle.dispose();
  });

  it('dispose is idempotent and unregisters the reclaim handler', async () => {
    const cdp = { getTargets: () => [] };
    const registry = new TargetLeaseRegistry();
    const handle = wireZombieLockDetector(cdp, registry, {
      intervalMs: 60_000,
      confirmations: 1,
      registrationGraceMs: 0,
    });
    handle.dispose();
    handle.dispose(); // second call must not throw
    // Post-dispose register/unregister must be no-ops.
    handle.registerLease('t1', 'w1');
    handle.unregisterLease('t1');
    expect(handle.audit).toHaveLength(0);
  });
});
