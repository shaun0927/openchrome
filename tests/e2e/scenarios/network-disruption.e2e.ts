/**
 * E2E: Network Disruption Recovery
 * Validates: tool calls return errors (not hangs) during disruption,
 * auto-reconnect restores normal operation after recovery.
 *
 * Uses SIGSTOP/SIGCONT on ALL Chrome processes to freeze/unfreeze them,
 * simulating a network block from the MCP server's perspective without
 * killing Chrome. The heartbeat mechanism should detect the frozen
 * connection and fail pending/new calls within a bounded timeout.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { MCPClient } from '../harness/mcp-client';
import { ChromeController } from '../harness/chrome-controller';
import { sleep } from '../harness/time-scale';

const CHROME_PORT = 9222;

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

/**
 * Find ALL Chrome process PIDs related to a debug port.
 * On macOS, Chrome spawns multiple child processes (GPU, renderer, utility)
 * that must all be frozen for a complete simulation.
 */
function findAllChromePids(mainPid: number): number[] {
  try {
    // Find all child processes of the main Chrome PID
    const output = execSync(`pgrep -P ${mainPid} 2>/dev/null || true`).toString().trim();
    const childPids = output.split('\n').filter(Boolean).map(Number).filter(n => n > 0);
    return [mainPid, ...childPids];
  } catch {
    return [mainPid];
  }
}

function signalAllPids(pids: number[], signal: string): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process may already be dead
    }
  }
}

describe('E2E: Network Disruption Recovery', () => {
  let mcp: MCPClient;
  let chrome: ChromeController;
  let frozenPids: number[] = [];

  beforeAll(async () => {
    mcp = new MCPClient({
      timeoutMs: 60_000,
      env: { OPENCHROME_MAX_RECONNECT_ATTEMPTS: '0' }, // infinite reconnect
    });
    await mcp.start();
    chrome = new ChromeController();
  }, 90_000);

  afterAll(async () => {
    // Ensure ALL Chrome processes are unfrozen before cleanup
    if (frozenPids.length > 0) {
      console.error(`[network-disruption] afterAll: sending SIGCONT to ${frozenPids.length} pids`);
      signalAllPids(frozenPids, 'SIGCONT');
      frozenPids = [];
    }
    await mcp.stop();
  }, 30_000);

  test('tool calls return errors during disruption and recover after', async () => {
    const port = getFixturePort();

    // Step 1: Verify normal operation before any disruption
    console.error('[network-disruption] Step 1: Verify normal operation');
    const navResult = await mcp.callTool('navigate', { url: `http://localhost:${port}/site-a` });
    expect(navResult.text).toContain('tabId');
    console.error('[network-disruption] Step 1 OK: Navigation successful');

    // Step 2: Discover Chrome PID and all related child processes
    console.error(`[network-disruption] Step 2: Discover Chrome PIDs on port ${CHROME_PORT}`);
    const chromePid = await chrome.discoverPid(CHROME_PORT);
    expect(chromePid).toBeGreaterThan(0);
    const allPids = findAllChromePids(chromePid);
    console.error(`[network-disruption] Step 2 OK: Chrome main=${chromePid}, all pids=[${allPids.join(', ')}]`);

    // Step 3: Freeze ALL Chrome processes (simulate network disruption)
    console.error('[network-disruption] Step 3: Freezing all Chrome processes via SIGSTOP');
    frozenPids = allPids;
    signalAllPids(allPids, 'SIGSTOP');

    // Step 3b: Poll oc_connection_health until MCP server detects the disruption.
    // This is more reliable than a fixed sleep — confirms heartbeat has actually fired.
    console.error('[network-disruption] Step 3b: Polling connection health until disconnection detected');
    let disrupted = false;
    for (let i = 0; i < 20; i++) { // max 40s (20 × 2s)
      try {
        const health = await mcp.callTool('oc_connection_health', {}, 5_000);
        if (health.text.includes('reconnecting') || health.text.includes('disconnected')) {
          console.error(`[network-disruption] Step 3b OK: Disruption detected after ${(i + 1) * 2}s`);
          disrupted = true;
          break;
        }
      } catch {
        // oc_connection_health itself might error if server is in bad state
        disrupted = true;
        console.error(`[network-disruption] Step 3b OK: Tool call errored (disrupted) after ${(i + 1) * 2}s`);
        break;
      }
      await sleep(2_000);
    }
    expect(disrupted).toBe(true);

    // Step 4: Tool call during disruption must error, NOT hang
    console.error('[network-disruption] Step 4: Tool call during disruption (expect error within 20s)');
    const callStart = Date.now();
    let errorOccurred = false;
    try {
      await mcp.callTool('navigate', { url: `http://localhost:${port}/site-b` }, 25_000);
      // If navigate succeeds, it means the server launched a new Chrome or the call
      // was served from cache. Check if it was an error response.
      console.error('[network-disruption] Step 4: navigate returned (checking for isError)');
    } catch (err) {
      errorOccurred = true;
      const elapsed = Date.now() - callStart;
      console.error(`[network-disruption] Step 4: Error in ${elapsed}ms: ${(err as Error).message}`);
      // Must fail well within 20s — not hang for the full timeout
      expect(elapsed).toBeLessThan(20_000);
    }
    expect(errorOccurred).toBe(true);
    console.error('[network-disruption] Step 4 OK: Disruption correctly produced a bounded error');

    // Step 5: Unfreeze Chrome and wait for auto-reconnect
    console.error('[network-disruption] Step 5: Unfreezing Chrome via SIGCONT');
    signalAllPids(frozenPids, 'SIGCONT');
    frozenPids = [];

    // Poll until reconnected (more reliable than fixed sleep)
    console.error('[network-disruption] Step 5b: Polling for reconnection...');
    let reconnected = false;
    for (let i = 0; i < 20; i++) { // max 40s
      try {
        const health = await mcp.callTool('oc_connection_health', {}, 5_000);
        if (health.text.includes('"connected"') && !health.text.includes('reconnecting')) {
          console.error(`[network-disruption] Step 5b OK: Reconnected after ${(i + 1) * 2}s`);
          reconnected = true;
          break;
        }
      } catch {
        // Still reconnecting
      }
      await sleep(2_000);
    }
    if (!reconnected) {
      console.error('[network-disruption] Step 5b: Reconnect not confirmed via health, proceeding anyway');
    }

    // Step 6: Verify recovery — tool call should succeed after reconnect
    console.error('[network-disruption] Step 6: Verify recovery with navigate');
    let recovered = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const recoveryResult = await mcp.callTool(
          'navigate',
          { url: `http://localhost:${port}/site-a` },
          30_000,
        );
        expect(recoveryResult.text).toContain('tabId');
        recovered = true;
        console.error(`[network-disruption] Step 6 OK: Recovery confirmed on attempt ${attempt}`);
        break;
      } catch (err) {
        console.error(
          `[network-disruption] Step 6: Attempt ${attempt} failed: ${(err as Error).message}`,
        );
        if (attempt < 5) await sleep(5_000);
      }
    }
    expect(recovered).toBe(true);

    // Step 7: Check connection health — reconnectCount should be >= 1
    console.error('[network-disruption] Step 7: Check connection health');
    const healthResult = await mcp.callTool('oc_connection_health', {});
    console.error(`[network-disruption] Step 7: ${healthResult.text}`);
    expect(healthResult.text).toMatch(/reconnectCount.*[1-9]/);
    console.error('[network-disruption] Step 7 OK: reconnectCount >= 1 confirmed');
  }, 300_000); // 5-minute total — accounts for freeze/reconnect waits
});
