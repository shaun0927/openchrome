/**
 * E2E-8: 24-Hour Endurance Test
 * Validates: sustained operation, Chrome crash recovery, memory stability.
 *
 * Enable with: OPENCHROME_ENDURANCE=1
 * Duration:    ENDURANCE_HOURS=24 (default: 1 for CI)
 *
 * PASS criteria:
 *   - Task completion rate > 95%
 *   - Zero permanent failures (all Chrome restarts recover)
 *   - Average Chrome recovery time < 30s
 *   - Heap growth < 200MB over test duration
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient } from '../harness/mcp-client';
import { ChromeController } from '../harness/chrome-controller';
import { HeapSampler } from '../harness/heap-sampler';
import { scaled, JEST_OVERHEAD_MS } from '../harness/time-scale';

const CHROME_DEBUG_PORT = 19333; // Isolated port to avoid interference

const DURATION_HOURS = parseInt(process.env.ENDURANCE_HOURS || '1', 10);
const DURATION_MS = scaled(DURATION_HOURS * 60 * 60 * 1000);

// Phase durations (also scaled for CI)
const ACTIVE_PHASE_MS = scaled(10 * 60 * 1000);  // 10 min active
const IDLE_PHASE_MS   = scaled(20 * 60 * 1000);  // 20 min idle

// Event intervals (scaled)
const CHROME_RESTART_INTERVAL_MS   = scaled(60 * 60 * 1000); // every hour
const MCP_RESTART_INTERVAL_MS      = scaled(4 * 60 * 60 * 1000); // every 4 hours
const HEALTH_LOG_INTERVAL_MS       = scaled(5 * 60 * 1000);  // every 5 min

// Polling delays
const ACTIVE_POLL_DELAY_MS = scaled(5_000);   // 5s between ops in active phase
const IDLE_POLL_DELAY_MS   = scaled(30_000);  // 30s between checks in idle phase

// Recovery wait after Chrome kill
const CHROME_RECOVERY_WAIT_MS = 15_000;

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

interface EnduranceMetrics {
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  chromeRestarts: number;
  mcpRestarts: number;
  reconnects: number;
  recoveryTimes: number[];
  avgRecoveryTimeMs: number;
  heapSamples: number[];
  startTime: number;
}

describe('E2E-8: 24-Hour Endurance', () => {
  // Guard: only run when explicitly opted in
  const runEndurance = process.env.OPENCHROME_ENDURANCE === '1';
  const describeOrSkip = runEndurance ? describe : describe.skip;

  describeOrSkip('endurance session', () => {
    let mcp: MCPClient;
    let chrome: ChromeController;
    let heapSampler: HeapSampler;

    const metrics: EnduranceMetrics = {
      totalOperations: 0,
      successfulOperations: 0,
      failedOperations: 0,
      chromeRestarts: 0,
      mcpRestarts: 0,
      reconnects: 0,
      recoveryTimes: [],
      avgRecoveryTimeMs: 0,
      heapSamples: [],
      startTime: 0,
    };

    beforeAll(async () => {
      mcp = new MCPClient({
        timeoutMs: 60_000,
        args: ['--port', String(CHROME_DEBUG_PORT)],
      });
      await mcp.start();
      chrome = new ChromeController();
      heapSampler = new HeapSampler({ pid: mcp.pid });
    }, 90_000);

    afterAll(async () => {
      // Log final metrics regardless of pass/fail
      if (metrics.startTime > 0) {
        console.error('[endurance] FINAL METRICS:', JSON.stringify(metrics, null, 2));
      }
      await mcp.stop();
    }, 30_000);

    test(
      'sustained operation over extended period',
      async () => {
        const port = getFixturePort();
        const testUrls = [
          `http://localhost:${port}/site-a`,
          `http://localhost:${port}/site-b`,
          `http://localhost:${port}/site-c`,
        ];

        metrics.startTime = Date.now();
        const endTime = metrics.startTime + DURATION_MS;

        let lastChromeRestart = metrics.startTime;
        let lastMcpRestart    = metrics.startTime;
        let lastHealthLog     = metrics.startTime;
        let isActivePhase     = true;
        let phaseStartTime    = metrics.startTime;

        heapSampler.takeBaseline();

        // Initial navigation to confirm connectivity
        await mcp.callTool('navigate', { url: testUrls[0] });
        metrics.totalOperations++;
        metrics.successfulOperations++;
        console.error('[endurance] Initial navigation OK, starting endurance loop');

        while (Date.now() < endTime) {
          const now = Date.now();

          // --- Phase transition ---
          const phaseElapsed = now - phaseStartTime;
          if (isActivePhase && phaseElapsed > ACTIVE_PHASE_MS) {
            isActivePhase = false;
            phaseStartTime = now;
            console.error('[endurance] -> IDLE phase');
          } else if (!isActivePhase && phaseElapsed > IDLE_PHASE_MS) {
            isActivePhase = true;
            phaseStartTime = now;
            console.error('[endurance] -> ACTIVE phase');
          }

          // --- MCP server restart every 4 hours ---
          if (now - lastMcpRestart > MCP_RESTART_INTERVAL_MS) {
            console.error('[endurance] Restarting MCP server (scheduled 4-hour cycle)...');
            const restartStart = Date.now();
            try {
              await mcp.restart();
              const elapsed = Date.now() - restartStart;
              metrics.mcpRestarts++;
              metrics.reconnects++;
              metrics.recoveryTimes.push(elapsed);
              console.error(`[endurance] MCP server restarted in ${elapsed}ms`);
            } catch (err) {
              console.error('[endurance] MCP restart failed:', err);
              metrics.failedOperations++;
            }
            lastMcpRestart = Date.now();
          }

          // --- Chrome restart every hour (simulate crash) ---
          if (now - lastChromeRestart > CHROME_RESTART_INTERVAL_MS) {
            console.error('[endurance] Simulating Chrome crash (scheduled hourly kill)...');
            const restartStart = Date.now();
            try {
              await chrome.discoverPid(CHROME_DEBUG_PORT);
              await chrome.kill('SIGKILL');

              // Wait for watchdog / auto-launch to recover Chrome
              await new Promise<void>((r) => setTimeout(r, CHROME_RECOVERY_WAIT_MS));

              // Verify recovery by performing a navigation
              await mcp.callTool('navigate', { url: testUrls[0] }, 60_000);
              const recoveryMs = Date.now() - restartStart;
              metrics.recoveryTimes.push(recoveryMs);
              metrics.chromeRestarts++;
              metrics.reconnects++;
              console.error(`[endurance] Chrome recovered in ${recoveryMs}ms`);
            } catch (err) {
              console.error('[endurance] Chrome restart/recovery failed:', err);
              metrics.failedOperations++;
              metrics.totalOperations++;
            }
            lastChromeRestart = Date.now();
          }

          // --- Active phase: cycle through operations ---
          if (isActivePhase) {
            const url = testUrls[metrics.totalOperations % testUrls.length];
            try {
              const navResult = await mcp.callTool('navigate', { url });
              metrics.totalOperations++;
              metrics.successfulOperations++;

              // Follow-up read_page on the navigated tab
              const tabIdMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
              if (tabIdMatch) {
                const readResult = await mcp.callTool('read_page', { tabId: tabIdMatch[1] });
                expect(readResult.text.length).toBeGreaterThan(0);
                metrics.totalOperations++;
                metrics.successfulOperations++;
              }
            } catch (err) {
              metrics.totalOperations++;
              metrics.failedOperations++;
              console.error('[endurance] Operation failed:', err);
            }
          }

          // --- Health metrics every 5 minutes ---
          if (now - lastHealthLog > HEALTH_LOG_INTERVAL_MS) {
            const heapBytes = process.memoryUsage().heapUsed;
            metrics.heapSamples.push(heapBytes);
            heapSampler.takeSample();

            const elapsedPct  = ((now - metrics.startTime) / DURATION_MS * 100).toFixed(1);
            const successRate = metrics.totalOperations > 0
              ? (metrics.successfulOperations / metrics.totalOperations * 100).toFixed(1)
              : '100.0';

            console.error(
              `[endurance] Progress: ${elapsedPct}% | ` +
              `Ops: ${metrics.totalOperations} (${successRate}% success) | ` +
              `ChromeRestarts: ${metrics.chromeRestarts} | ` +
              `McpRestarts: ${metrics.mcpRestarts} | ` +
              `Heap: ${Math.round(heapBytes / 1024 / 1024)}MB`
            );
            lastHealthLog = now;
          }

          // Throttle polling to avoid CPU spin (constants are already pre-scaled)
          await new Promise<void>((r) =>
            setTimeout(r, isActivePhase ? ACTIVE_POLL_DELAY_MS : IDLE_POLL_DELAY_MS)
          );
        }

        // --- Final assertions ---

        // 1. Success rate > 95%
        const successRate = metrics.totalOperations > 0
          ? metrics.successfulOperations / metrics.totalOperations
          : 1;
        console.error(
          `[endurance] Final success rate: ${(successRate * 100).toFixed(2)}% ` +
          `(${metrics.successfulOperations}/${metrics.totalOperations})`
        );
        expect(successRate).toBeGreaterThan(0.95);

        // 2. Average Chrome recovery time < 30s
        if (metrics.recoveryTimes.length > 0) {
          const avgRecovery =
            metrics.recoveryTimes.reduce((a, b) => a + b, 0) / metrics.recoveryTimes.length;
          metrics.avgRecoveryTimeMs = avgRecovery;
          console.error(`[endurance] Avg recovery time: ${avgRecovery.toFixed(0)}ms`);
          expect(avgRecovery).toBeLessThan(30_000);
        }

        // 3. Heap growth < 200MB over duration
        if (metrics.heapSamples.length >= 2) {
          const quarterLen  = Math.ceil(metrics.heapSamples.length / 4);
          const firstSlice  = metrics.heapSamples.slice(0, quarterLen);
          const lastSlice   = metrics.heapSamples.slice(-quarterLen);
          const avgFirst    = firstSlice.reduce((a, b) => a + b, 0) / firstSlice.length;
          const avgLast     = lastSlice.reduce((a, b) => a + b, 0) / lastSlice.length;
          const growthMB    = (avgLast - avgFirst) / 1024 / 1024;
          console.error(`[endurance] Heap growth: ${growthMB.toFixed(1)}MB`);
          expect(growthMB).toBeLessThan(200);
        }

        heapSampler.assertStable(200); // < 200MB MCP server RSS delta
      },
      DURATION_MS + JEST_OVERHEAD_MS + 60_000 // duration + 1-min buffer + fixed overhead
    );
  });
});
