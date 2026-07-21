import { describe, expect, it } from '@jest/globals';
import {
  isZombieLockDetectorEnabled,
  wireZombieLockDetector,
} from '../../src/cdp/zombie-lock-wiring.js';
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

describe('wireZombieLockDetector default construction', () => {
  it('extracts targetIds from puppeteer _targetInfo and .id fallback shapes', async () => {
    const visible = [{ _targetInfo: { targetId: 'real' } }, { id: 'fallback' }];
    const cdp = { getTargets: () => visible };
    const registry = new TargetLeaseRegistry();
    const handle = wireZombieLockDetector(cdp, registry, {
      intervalMs: 60_000,
      confirmations: 1,
      registrationGraceMs: 0,
    });
    await handle.detector.tick();
    expect(handle.audit).toHaveLength(0);
    handle.dispose();
    handle.dispose(); // idempotent
  });
});
