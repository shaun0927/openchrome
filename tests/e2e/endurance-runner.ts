/**
 * Endurance Runner — standalone script for the E2E-8 24-hour endurance test.
 *
 * Usage:
 *   ENDURANCE_HOURS=24 npx ts-node tests/e2e/endurance-runner.ts
 *   ENDURANCE_HOURS=1  npx ts-node tests/e2e/endurance-runner.ts   # 1-hour smoke run
 *
 * The script:
 *   1. Builds the MCP server (if dist/ is missing)
 *   2. Starts a fixture HTTP server
 *   3. Runs the endurance loop directly (no Jest overhead)
 *   4. Writes a JSON metrics report to endurance-report-<timestamp>.json
 *   5. Exits 0 (pass) or 1 (fail)
 *
 * Environment variables:
 *   ENDURANCE_HOURS   Duration in hours (default: 1)
 *   TIME_SCALE        CI compression factor (default: 1)
 *   DEBUG             Set to 1 for verbose MCP output
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { MCPClient } from './harness/mcp-client';
import { ChromeController } from './harness/chrome-controller';
import { HeapSampler } from './harness/heap-sampler';
import { scaled } from './harness/time-scale';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DURATION_HOURS = parseInt(process.env.ENDURANCE_HOURS || '1', 10);
const DURATION_MS    = scaled(DURATION_HOURS * 60 * 60 * 1000);

const FIXTURE_PORT       = 18930; // Isolated port for runner
const CHROME_DEBUG_PORT  = 19444; // Isolated port for runner Chrome

const ACTIVE_PHASE_MS            = scaled(10 * 60 * 1000);
const IDLE_PHASE_MS              = scaled(20 * 60 * 1000);
const CHROME_RESTART_INTERVAL_MS = scaled(60 * 60 * 1000);
const MCP_RESTART_INTERVAL_MS    = scaled(4 * 60 * 60 * 1000);
const HEALTH_LOG_INTERVAL_MS     = scaled(5 * 60 * 1000);
const ACTIVE_POLL_DELAY_MS       = scaled(5_000);
const IDLE_POLL_DELAY_MS         = scaled(30_000);
const CHROME_RECOVERY_WAIT_MS    = 15_000;

// ---------------------------------------------------------------------------
// Fixture HTTP server (mirrors E2E setup.ts pages)
// ---------------------------------------------------------------------------

function buildFixturePages(): Record<string, string> {
  return {
    '/': `<!DOCTYPE html><html><head><title>E2E Endurance</title></head>
<body><h1>OpenChrome Endurance Runner</h1></body></html>`,
    '/site-a': `<!DOCTYPE html><html><head><title>Site A</title></head>
<body><h1>Welcome to Site A</h1></body></html>`,
    '/site-b': `<!DOCTYPE html><html><head><title>Site B</title></head>
<body><h1>Search Portal</h1></body></html>`,
    '/site-c': `<!DOCTYPE html><html><head><title>Site C</title></head>
<body><h1>Data Dashboard</h1></body></html>`,
  };
}

function startFixtureServer(): Promise<http.Server> {
  const pages = buildFixturePages();
  const server = http.createServer((req, res) => {
    const url = req.url?.split('?')[0] || '/';
    const html = pages[url];
    if (html) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(FIXTURE_PORT, () => {
      console.error(`[runner] Fixture server on http://localhost:${FIXTURE_PORT}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface EnduranceReport {
  durationHours: number;
  durationMs: number;
  startTime: string;
  endTime: string;
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  successRatePct: number;
  chromeRestarts: number;
  mcpRestarts: number;
  reconnects: number;
  recoveryTimes: number[];
  avgRecoveryTimeMs: number;
  maxRecoveryTimeMs: number;
  heapSamplesMB: number[];
  heapGrowthMB: number;
  passed: boolean;
  failureReasons: string[];
}

// ---------------------------------------------------------------------------
// Main endurance loop
// ---------------------------------------------------------------------------

async function runEndurance(mcp: MCPClient, chrome: ChromeController, heapSampler: HeapSampler): Promise<EnduranceReport> {
  const testUrls = [
    `http://localhost:${FIXTURE_PORT}/site-a`,
    `http://localhost:${FIXTURE_PORT}/site-b`,
    `http://localhost:${FIXTURE_PORT}/site-c`,
  ];

  const startTime = Date.now();
  const endTime   = startTime + DURATION_MS;

  let totalOperations      = 0;
  let successfulOperations = 0;
  let failedOperations     = 0;
  let chromeRestarts       = 0;
  let mcpRestarts          = 0;
  let reconnects           = 0;
  const recoveryTimes: number[] = [];
  const heapSamplesMB: number[] = [];

  let lastChromeRestart = startTime;
  let lastMcpRestart    = startTime;
  let lastHealthLog     = startTime;
  let isActivePhase     = true;
  let phaseStartTime    = startTime;

  heapSampler.takeBaseline();

  // Initial connectivity check
  await mcp.callTool('navigate', { url: testUrls[0] });
  totalOperations++;
  successfulOperations++;
  console.error('[runner] Initial navigation OK — endurance loop starting');
  console.error(`[runner] Duration: ${DURATION_HOURS}h (${DURATION_MS}ms scaled)`);

  while (Date.now() < endTime) {
    const now = Date.now();

    // Phase transition
    const phaseElapsed = now - phaseStartTime;
    if (isActivePhase && phaseElapsed > ACTIVE_PHASE_MS) {
      isActivePhase  = false;
      phaseStartTime = now;
      console.error('[runner] -> IDLE phase');
    } else if (!isActivePhase && phaseElapsed > IDLE_PHASE_MS) {
      isActivePhase  = true;
      phaseStartTime = now;
      console.error('[runner] -> ACTIVE phase');
    }

    // MCP server restart every 4 hours
    if (now - lastMcpRestart > MCP_RESTART_INTERVAL_MS) {
      console.error('[runner] Restarting MCP server (scheduled 4-hour cycle)...');
      const restartStart = Date.now();
      try {
        await mcp.restart();
        const elapsed = Date.now() - restartStart;
        mcpRestarts++;
        reconnects++;
        recoveryTimes.push(elapsed);
        console.error(`[runner] MCP server restarted in ${elapsed}ms`);
      } catch (err) {
        console.error('[runner] MCP restart failed:', err);
        failedOperations++;
      }
      lastMcpRestart = Date.now();
    }

    // Chrome crash simulation every hour
    if (now - lastChromeRestart > CHROME_RESTART_INTERVAL_MS) {
      console.error('[runner] Simulating Chrome crash (scheduled hourly kill)...');
      const restartStart = Date.now();
      try {
        await chrome.discoverPid(CHROME_DEBUG_PORT);
        await chrome.kill('SIGKILL');

        // Wait for watchdog / auto-launch
        await new Promise<void>((r) => setTimeout(r, CHROME_RECOVERY_WAIT_MS));

        // Verify recovery
        await mcp.callTool('navigate', { url: testUrls[0] }, 60_000);
        const recoveryMs = Date.now() - restartStart;
        recoveryTimes.push(recoveryMs);
        chromeRestarts++;
        reconnects++;
        console.error(`[runner] Chrome recovered in ${recoveryMs}ms`);
      } catch (err) {
        console.error('[runner] Chrome restart/recovery failed:', err);
        failedOperations++;
        totalOperations++;
      }
      lastChromeRestart = Date.now();
    }

    // Active phase operations
    if (isActivePhase) {
      const url = testUrls[totalOperations % testUrls.length];
      try {
        const navResult = await mcp.callTool('navigate', { url });
        totalOperations++;
        successfulOperations++;

        const tabIdMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
        if (tabIdMatch) {
          const readResult = await mcp.callTool('read_page', { tabId: tabIdMatch[1] });
          if (!readResult.text || readResult.text.length === 0) {
            throw new Error('read_page returned empty content');
          }
          totalOperations++;
          successfulOperations++;
        }
      } catch (err) {
        totalOperations++;
        failedOperations++;
        console.error('[runner] Operation failed:', err);
      }
    }

    // Health logging every 5 minutes
    if (now - lastHealthLog > HEALTH_LOG_INTERVAL_MS) {
      const heapBytes  = process.memoryUsage().heapUsed;
      const heapMB     = heapBytes / 1024 / 1024;
      heapSamplesMB.push(heapMB);
      heapSampler.takeSample();

      const elapsedPct  = ((now - startTime) / DURATION_MS * 100).toFixed(1);
      const successRate = totalOperations > 0
        ? (successfulOperations / totalOperations * 100).toFixed(1)
        : '100.0';

      console.error(
        `[runner] Progress: ${elapsedPct}% | ` +
        `Ops: ${totalOperations} (${successRate}% success) | ` +
        `ChromeRestarts: ${chromeRestarts} | McpRestarts: ${mcpRestarts} | ` +
        `Heap: ${heapMB.toFixed(1)}MB`
      );
      lastHealthLog = now;
    }

    // Throttle polling
    await new Promise<void>((r) =>
      setTimeout(r, isActivePhase ? ACTIVE_POLL_DELAY_MS : IDLE_POLL_DELAY_MS)
    );
  }

  // ---------------------------------------------------------------------------
  // Build report
  // ---------------------------------------------------------------------------

  const actualEndTime = Date.now();
  const successRatePct = totalOperations > 0
    ? (successfulOperations / totalOperations) * 100
    : 100;

  const avgRecoveryTimeMs = recoveryTimes.length > 0
    ? recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length
    : 0;

  const maxRecoveryTimeMs = recoveryTimes.length > 0
    ? Math.max(...recoveryTimes)
    : 0;

  let heapGrowthMB = 0;
  if (heapSamplesMB.length >= 2) {
    const quarterLen = Math.ceil(heapSamplesMB.length / 4);
    const avgFirst   = heapSamplesMB.slice(0, quarterLen).reduce((a, b) => a + b, 0) / quarterLen;
    const avgLast    = heapSamplesMB.slice(-quarterLen).reduce((a, b) => a + b, 0) / quarterLen;
    heapGrowthMB     = avgLast - avgFirst;
  }

  const failureReasons: string[] = [];
  if (successRatePct <= 95) {
    failureReasons.push(`Success rate ${successRatePct.toFixed(2)}% <= 95%`);
  }
  if (avgRecoveryTimeMs >= 30_000) {
    failureReasons.push(`Avg recovery ${avgRecoveryTimeMs.toFixed(0)}ms >= 30000ms`);
  }
  if (heapGrowthMB >= 200) {
    failureReasons.push(`Heap growth ${heapGrowthMB.toFixed(1)}MB >= 200MB`);
  }

  return {
    durationHours: DURATION_HOURS,
    durationMs: DURATION_MS,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(actualEndTime).toISOString(),
    totalOperations,
    successfulOperations,
    failedOperations,
    successRatePct,
    chromeRestarts,
    mcpRestarts,
    reconnects,
    recoveryTimes,
    avgRecoveryTimeMs,
    maxRecoveryTimeMs,
    heapSamplesMB,
    heapGrowthMB,
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.error(`[runner] E2E-8 Endurance Runner — ${DURATION_HOURS}h run`);

  // Ensure MCP server is built
  const serverPath = path.join(process.cwd(), 'dist', 'index.js');
  if (!fs.existsSync(serverPath)) {
    console.error('[runner] dist/index.js not found — building...');
    execSync('npm run build', { stdio: 'inherit' });
  }

  // Start fixture server
  const fixtureServer = await startFixtureServer();

  // Start MCP client
  const mcp = new MCPClient({
    timeoutMs: 60_000,
    args: ['--port', String(CHROME_DEBUG_PORT)],
  });
  await mcp.start();
  console.error('[runner] MCP server started');

  const chrome      = new ChromeController();
  const heapSampler = new HeapSampler({ pid: mcp.pid });

  let report: EnduranceReport | null = null;

  try {
    report = await runEndurance(mcp, chrome, heapSampler);
  } catch (err) {
    console.error('[runner] Fatal error during endurance loop:', err);
    // Build minimal failure report
    report = {
      durationHours: DURATION_HOURS,
      durationMs: DURATION_MS,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      totalOperations: 0,
      successfulOperations: 0,
      failedOperations: 1,
      successRatePct: 0,
      chromeRestarts: 0,
      mcpRestarts: 0,
      reconnects: 0,
      recoveryTimes: [],
      avgRecoveryTimeMs: 0,
      maxRecoveryTimeMs: 0,
      heapSamplesMB: [],
      heapGrowthMB: 0,
      passed: false,
      failureReasons: [`Fatal: ${(err as Error).message}`],
    };
  } finally {
    await mcp.stop().catch(() => { /* ignore */ });
    await new Promise<void>((r) => fixtureServer.close(() => r()));
    console.error('[runner] Cleanup complete');
  }

  // Write JSON report
  const reportFile = path.join(
    process.cwd(),
    `endurance-report-${Date.now()}.json`
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.error(`[runner] Report written to: ${reportFile}`);

  // Print summary
  console.error('[runner] ========== ENDURANCE REPORT ==========');
  console.error(`[runner] Duration:      ${report.durationHours}h`);
  console.error(`[runner] Operations:    ${report.successfulOperations}/${report.totalOperations} (${report.successRatePct.toFixed(2)}% success)`);
  console.error(`[runner] ChromeRestarts:${report.chromeRestarts}`);
  console.error(`[runner] McpRestarts:   ${report.mcpRestarts}`);
  console.error(`[runner] Avg recovery:  ${report.avgRecoveryTimeMs.toFixed(0)}ms`);
  console.error(`[runner] Max recovery:  ${report.maxRecoveryTimeMs.toFixed(0)}ms`);
  console.error(`[runner] Heap growth:   ${report.heapGrowthMB.toFixed(1)}MB`);
  console.error(`[runner] Result:        ${report.passed ? 'PASS' : 'FAIL'}`);
  if (report.failureReasons.length > 0) {
    report.failureReasons.forEach((r) => console.error(`[runner]   FAIL: ${r}`));
  }
  console.error('[runner] ==========================================');

  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[runner] Unhandled error:', err);
  process.exit(1);
});
