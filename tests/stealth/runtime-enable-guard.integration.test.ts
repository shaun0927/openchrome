/// <reference types="jest" />

/**
 * Integration test: minimal-window contract.
 *
 * Simulates a 10-second stealth console-capture session driven through the
 * guard: one start (one Runtime.enable) followed by one stop (one
 * Runtime.disable). Then repeats over N cycles to confirm enable and
 * disable counts stay paired (no orphan enables).
 *
 * This is the honest bench for what the guard actually delivers: a single
 * choke point plus paired enable/disable, provable via audit counters and
 * the CDP protocol trace recorded on the fake session.
 */

import { EventEmitter } from 'events';
import {
  ensureRuntimeEnabled,
  disableRuntime,
  getGuardStats,
  __resetGuardStatsForTest,
} from '../../src/stealth/runtime-enable-guard';

interface FakeCDPSession extends EventEmitter {
  trace: string[];
  send(method: string): Promise<unknown>;
}

function makeSession(): FakeCDPSession {
  const s = new EventEmitter() as FakeCDPSession;
  s.trace = [];
  s.send = jest.fn(async (method: string) => { s.trace.push(method); return {}; });
  return s;
}

/**
 * Over a 10-second capture window with N start/stop cycles, assert:
 *   - Runtime.enable is emitted at most N times (one per start).
 *   - Runtime.disable is emitted exactly as many times as Runtime.enable.
 *   - The guard's audit counters agree with the on-wire trace.
 *
 * N is fixed at 3 here — a typical stealth session opens capture once,
 * stops, and may reopen after navigation. Three cycles cover that.
 */
describe('runtime-enable-guard: minimal-window integration', () => {
  const CYCLES = 3;

  beforeEach(() => __resetGuardStatsForTest());

  test(`enable-count and disable-count are paired over ${CYCLES} start/stop cycles`, async () => {
    const session = makeSession();

    for (let i = 0; i < CYCLES; i++) {
      await ensureRuntimeEnabled(session as never, {
        isStealthTarget: true, stealthMode: 'allow', callerId: 'console_capture',
      });
      // Simulate work: emit some console events, then stop.
      session.emit('Runtime.consoleAPICalled', { type: 'log', args: [] });
      await disableRuntime(session as never, { callerId: 'console_capture' });
    }

    const enables = session.trace.filter(m => m === 'Runtime.enable').length;
    const disables = session.trace.filter(m => m === 'Runtime.disable').length;

    expect(enables).toBeLessThanOrEqual(CYCLES);
    expect(enables).toBe(CYCLES);
    expect(disables).toBe(enables);

    const stats = getGuardStats();
    expect(stats.enableCalls).toBe(enables);
    expect(stats.disableCalls).toBe(disables);
    expect(stats.byCaller.console_capture.enables).toBe(stats.byCaller.console_capture.disables);
  });

  test('refuse-by-default prevents any Runtime.enable from reaching the wire', async () => {
    const session = makeSession();
    for (let i = 0; i < CYCLES; i++) {
      await expect(
        ensureRuntimeEnabled(session as never, { isStealthTarget: true, callerId: 'validate_page' }),
      ).rejects.toThrow(/Refused to send Runtime.enable/);
    }
    expect(session.trace).toEqual([]);
    expect(getGuardStats().enableCalls).toBe(0);
    expect(getGuardStats().refusals).toBe(CYCLES);
  });

  test('audit trace names the exact caller behind each enable', async () => {
    const session = makeSession();
    await ensureRuntimeEnabled(session as never, {
      isStealthTarget: true, stealthMode: 'allow', callerId: 'console_capture',
    });
    await ensureRuntimeEnabled(session as never, {
      isStealthTarget: true, stealthMode: 'allow', callerId: 'validate_page',
    });
    const stats = getGuardStats();
    expect(stats.byCaller.console_capture.enables).toBe(1);
    expect(stats.byCaller.validate_page.enables).toBe(1);
    expect(stats.enableCalls).toBe(2);
  });
});
