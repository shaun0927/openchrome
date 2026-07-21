/**
 * End-to-end integration + micro-benchmark for the zombie-lock detector
 * (#1474). Simulates the full path a real broker would take:
 *
 *   1. Session A acquires a lease on a target via the wiring's
 *      `registerLease` hook (this is the same call SessionManager makes
 *      in `acquireTargetLease`).
 *   2. Chrome loses the target — the CDPClient's `getTargets()` no longer
 *      lists it.
 *   3. Detector confirms the miss, fires `owner_reclaim`, the wiring's
 *      audit ledger records it, and the lease registry releases the
 *      session so Session B can acquire without hitting a
 *      `TargetLeaseConflictError`.
 *
 * Also records recovery-time and success-rate numbers over N trials
 * and asserts them against a conservative floor so regressions surface
 * as test failures rather than silent perf drift.
 */

import { describe, expect, it } from '@jest/globals';
import { wireZombieLockDetector } from '../../src/cdp/zombie-lock-wiring.js';
import { TargetLeaseRegistry } from '../../src/session/target-lease-registry.js';

const TRIALS = 50;

describe('zombie-lock end-to-end recovery', () => {
  it('detects a vanished target and lets a new session re-acquire the lease', async () => {
    const times: number[] = [];
    let successes = 0;

    for (let i = 0; i < TRIALS; i++) {
      let clock = 0;
      const targetId = `t-${i}`;
      let visible = [{ _targetInfo: { targetId } }];
      const cdp = { getTargets: () => visible };
      const registry = new TargetLeaseRegistry();

      const handle = wireZombieLockDetector(cdp, registry, {
        intervalMs: 60_000, // manual ticks; the poll timer must not fire
        confirmations: 2,
        registrationGraceMs: 0,
        now: () => clock,
      });

      // Session A takes the lease (this mirrors SessionManager.acquireTargetLease).
      registry.acquire({ targetId, sessionId: 'A', workerId: 'wA' });
      handle.registerLease(targetId, 'wA');

      const t0 = clock;

      // Session B tries to acquire the same target → conflict.
      let conflicted = false;
      try {
        registry.acquire({ targetId, sessionId: 'B', workerId: 'wB' });
      } catch {
        conflicted = true;
      }
      expect(conflicted).toBe(true);

      // Chrome drops the target (owner A crashed). Advance the clock and
      // tick until confirmations satisfied.
      visible = [];
      clock += 5_000;
      await handle.detector.tick(); // miss 1
      clock += 5_000;
      await handle.detector.tick(); // miss 2 → reclaim

      // Session B can now acquire without conflict.
      let reacquired = false;
      try {
        registry.acquire({ targetId, sessionId: 'B', workerId: 'wB' });
        reacquired = true;
      } catch {
        reacquired = false;
      }

      if (reacquired && handle.audit.length === 1) {
        successes++;
        times.push(handle.audit[0]!.detectedAt - t0);
      }

      handle.dispose();
    }

    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
    const successRate = successes / TRIALS;

    // Bench print — surfaces in `jest --verbose` output and CI logs.
    // Values are simulated-clock ms (interval=5s, confirmations=2).
    // eslint-disable-next-line no-console
    console.log(
      `[bench] zombie-lock: trials=${TRIALS} success_rate=${(successRate * 100).toFixed(1)}% ` +
        `detect_p50=${p50}ms detect_p95=${p95}ms`,
    );

    expect(successRate).toBe(1);
    // Two 5s ticks = 10_000ms floor; anything above 12_000 signals drift.
    expect(p95).toBeLessThanOrEqual(12_000);
  });
});
