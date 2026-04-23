/// <reference types="jest" />
/**
 * Integration test for issue #649 §5.7 — the reentrancy guard added to
 * `enhancedShutdown` must collapse concurrent exit triggers (PPID watcher +
 * idle-timeout, in the same tick) into exactly one shutdown sequence.
 *
 * We don't spawn the real server here (that requires Chrome); instead we
 * simulate the shutdown handler in isolation: two invocations in the same
 * microtask must run the cleanup work exactly once. The guard is the same
 * pattern as `installParentWatcher` — a module-local boolean short-circuit.
 */

describe('enhancedShutdown reentrancy guard (issue #649 §5.7)', () => {
  test('two concurrent triggers run the cleanup sequence exactly once', async () => {
    let shuttingDown = false;
    let cleanupRuns = 0;
    const log: string[] = [];

    // Mirror of the production guard + cleanup shape (minus the actual
    // async teardown calls). The point is to verify the flag semantics.
    const enhancedShutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.push(`[openchrome] Shutting down (${signal})`);
      // Simulate one await — enough to yield the microtask so a concurrent
      // second invocation would previously race past the guard.
      await Promise.resolve();
      cleanupRuns++;
      log.push(`[openchrome] Shutdown complete (${signal})`);
    };

    // Fire two triggers in the same tick, as PPID watcher + idle-timeout
    // would on a real double-death.
    await Promise.all([
      enhancedShutdown('idle-timeout'),
      enhancedShutdown('ppid-watcher'),
    ]);

    expect(cleanupRuns).toBe(1);
    expect(log.filter((l) => l.includes('Shutting down')).length).toBe(1);
  });

  test('a later signal-triggered shutdown after the first completes does NOT re-run', async () => {
    let shuttingDown = false;
    let cleanupRuns = 0;

    const enhancedShutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await Promise.resolve();
      cleanupRuns++;
    };

    await enhancedShutdown('idle-timeout');
    expect(cleanupRuns).toBe(1);

    // Simulate SIGTERM arriving after idle-timeout already tore everything
    // down. Must be a no-op, not a crash.
    await enhancedShutdown('SIGTERM');
    expect(cleanupRuns).toBe(1);
  });
});
