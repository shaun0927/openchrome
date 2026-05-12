/// <reference types="jest" />
/**
 * Tests for console_buffer_pressure event emission in TabHealthMonitor (#897).
 */

import { TabHealthMonitor } from '../../src/cdp/tab-health-monitor';
import { captureStates } from '../../src/tools/console-capture';
import { createConsoleRingBuffer } from '../../src/core/console-buffer/ring-buffer';
import { Page } from 'puppeteer-core';

function createMockPage(opts: {
  evaluateResult?: unknown;
  evaluateError?: Error;
  evaluateDelay?: number;
} = {}): jest.Mocked<Pick<Page, 'evaluate'>> {
  const evaluate = jest.fn().mockImplementation(async () => {
    if (opts.evaluateDelay) {
      await new Promise(r => setTimeout(r, opts.evaluateDelay));
    }
    if (opts.evaluateError) throw opts.evaluateError;
    return opts.evaluateResult ?? 1;
  });
  return { evaluate } as unknown as jest.Mocked<Pick<Page, 'evaluate'>>;
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 3000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become truthy within ${timeoutMs}ms`);
}

afterEach(() => {
  captureStates.clear();
});

describe('TabHealthMonitor — console_buffer_pressure', () => {
  test('emits console_buffer_pressure when retainedBytes > 0.9 * maxBytes for >= sustainMs', async () => {
    const maxBytes = 1000;
    const tabId = 'pressure-tab-1';

    // Inject a ring buffer that is above the 0.9 threshold.
    // We use a tiny placeholder factory for simplicity.
    const ringBuf = createConsoleRingBuffer<{ type: string; text: string; timestamp: number }>(
      { maxLines: 10000, maxBytes },
      (sz) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: sz } as any),
    );
    // Push 950 bytes worth so retainedBytes = 950 > 0.9 * 1000 = 900
    ringBuf.push({ type: 'log', text: 'x', timestamp: Date.now() }, 950);

    captureStates.set(tabId, {
      logs: ringBuf as any,
      cdpSession: {} as any,
      consoleHandler: () => {},
      exceptionHandler: () => {},
      startedAt: Date.now(),
      filter: undefined,
      maxLogs: 10000,
      maxBytes,
    });

    const monitor = new TabHealthMonitor({
      probeIntervalMs: 30,       // probe every 30 ms
      probeTimeoutMs: 5000,
    });

    // Use a custom pressure sustain of 0 ms for testing by monkey-patching.
    // Instead, set probeIntervalMs=30 and wait >30 ms for the first probe,
    // then inject a very short sustain via the module constant.
    // Since PRESSURE_SUSTAIN_MS=30_000 is hardcoded, we test by confirming
    // the event does NOT fire before sustain and DOES fire after.
    //
    // For this unit test we verify the onset bookkeeping is correct by
    // directly calling checkBufferPressure (which is private). Instead,
    // we expose it via a test-only subclass that shortens sustain duration.

    // Subclass to override PRESSURE_SUSTAIN_MS for testing
    class TestMonitor extends TabHealthMonitor {
      constructor() {
        super({ probeIntervalMs: 30, probeTimeoutMs: 5000 });
      }

      // Expose internal method for direct testing
      testCheckPressure(targetId: string, now: number): void {
        (this as any).checkBufferPressure(targetId, now);
      }
    }

    const testMonitor = new TestMonitor();
    const pressureHandler = jest.fn();
    testMonitor.on('console_buffer_pressure', pressureHandler);

    // Simulate onset: first call records onset
    const t0 = Date.now();
    testMonitor.testCheckPressure(tabId, t0);
    expect(pressureHandler).not.toHaveBeenCalled(); // sustain not elapsed yet

    // Second call 35 seconds later (simulated) should fire
    testMonitor.testCheckPressure(tabId, t0 + 35_000);
    expect(pressureHandler).toHaveBeenCalledTimes(1);
    expect(pressureHandler).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: tabId }),
    );

    // Third call should NOT fire again (one-shot debounce)
    testMonitor.testCheckPressure(tabId, t0 + 40_000);
    expect(pressureHandler).toHaveBeenCalledTimes(1);

    testMonitor.stopAll();
    captureStates.delete(tabId);
  });

  test('pressure event resets when retainedBytes drops below threshold', () => {
    const maxBytes = 1000;
    const tabId = 'pressure-tab-2';

    const ringBuf = createConsoleRingBuffer<{ type: string; text: string; timestamp: number }>(
      { maxLines: 10000, maxBytes },
      (sz) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: sz } as any),
    );
    ringBuf.push({ type: 'log', text: 'x', timestamp: Date.now() }, 950);

    captureStates.set(tabId, {
      logs: ringBuf as any,
      cdpSession: {} as any,
      consoleHandler: () => {},
      exceptionHandler: () => {},
      startedAt: Date.now(),
      filter: undefined,
      maxLogs: 10000,
      maxBytes,
    });

    class TestMonitor extends TabHealthMonitor {
      testCheckPressure(targetId: string, now: number): void {
        (this as any).checkBufferPressure(targetId, now);
      }
    }

    const testMonitor = new TestMonitor();
    const pressureHandler = jest.fn();
    testMonitor.on('console_buffer_pressure', pressureHandler);

    const t0 = Date.now();
    // Record onset
    testMonitor.testCheckPressure(tabId, t0);
    // Fire
    testMonitor.testCheckPressure(tabId, t0 + 35_000);
    expect(pressureHandler).toHaveBeenCalledTimes(1);

    // Now clear the buffer so retainedBytes drops to 0 (below threshold)
    ringBuf.clear();
    // Pressure should reset
    testMonitor.testCheckPressure(tabId, t0 + 36_000);

    // Refill to above threshold again
    ringBuf.push({ type: 'log', text: 'y', timestamp: Date.now() }, 950);
    testMonitor.testCheckPressure(tabId, t0 + 37_000); // new onset
    testMonitor.testCheckPressure(tabId, t0 + 72_000); // sustain elapsed again
    expect(pressureHandler).toHaveBeenCalledTimes(2);

    testMonitor.stopAll();
    captureStates.delete(tabId);
  });

  test('no pressure event when tab has no capture state', async () => {
    const monitor = new TabHealthMonitor({ probeIntervalMs: 50, probeTimeoutMs: 5000 });
    const pressureHandler = jest.fn();
    monitor.on('console_buffer_pressure', pressureHandler);

    const page = createMockPage();
    monitor.monitorTab('no-capture-tab', page as unknown as Page);

    // Wait for a couple of probes
    await new Promise(r => setTimeout(r, 150));
    expect(pressureHandler).not.toHaveBeenCalled();

    monitor.stopAll();
  });
});
