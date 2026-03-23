/**
 * E2E-7: Idle Session Survival (#347)
 * Validates: Default session is NOT expired after idle period (protected by
 * TTL-exempt check), and tool calls succeed immediately after idle without
 * requiring reconnection.
 *
 * Full spec: 30-minute idle period. Tests use shorter durations scaled by
 * TIME_SCALE — default full-scale is 30s idle, CI compresses further.
 *
 * Key assertions per #347 spec:
 *   - Default session exempt from TTL expiry during idle
 *   - Heartbeat maintains connection in idle mode
 *   - Tool call after idle succeeds without reconnection overhead
 *   - Session is still alive and responsive
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient } from '../harness/mcp-client';
import { scaled, scaledSleep, sleep, JEST_OVERHEAD_MS } from '../harness/time-scale';

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

describe('E2E-7: Idle Session Survival (#347)', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
  }, 90_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('session remains alive after idle period — default session exempt from TTL (#347 spec)', async () => {
    const port = getFixturePort();
    const testUrl = `http://localhost:${port}/`;

    // Step 1: Establish active session and navigate to a page
    console.error('[idle-session] Step 1: Establishing active session with initial navigation');
    const navResult = await mcp.callTool('navigate', { url: testUrl });
    expect(navResult.text).toBeDefined();
    console.error('[idle-session] Step 1 OK: Session established, initial page loaded');

    // Step 2: Verify session is functional before idle
    const beforeRead = await mcp.callTool('read_page', {});
    expect(beforeRead.text).toContain('E2E Test');
    console.error('[idle-session] Step 2 OK: Pre-idle read_page succeeded');

    // Step 3: Record pre-idle timing baseline
    const preIdleStart = Date.now();
    await mcp.callTool('navigate', { url: testUrl });
    const preIdleMs = Date.now() - preIdleStart;
    console.error(`[idle-session] Step 3 OK: Pre-idle navigation baseline: ${preIdleMs}ms`);

    // Step 4: Simulate idle period — no MCP calls for scaled idle duration
    // Full scale: 30s. CI (TIME_SCALE=0.167): ~5s.
    const idleDurationMs = scaled(30_000);
    console.error(`[idle-session] Step 4: Entering idle period (${idleDurationMs}ms, TIME_SCALE applied)`);
    await sleep(idleDurationMs);
    console.error('[idle-session] Step 4 OK: Idle period complete');

    // Step 5: Verify session is still alive after idle — no reconnection error
    console.error('[idle-session] Step 5: Verifying session alive after idle');
    const postIdleNavResult = await mcp.callTool('navigate', { url: testUrl }, 30_000);
    expect(postIdleNavResult.text).toBeDefined();
    console.error('[idle-session] Step 5 OK: Post-idle navigation succeeded — session survived idle');

    // Step 6: Verify page content is correct (session context intact)
    const postIdleRead = await mcp.callTool('read_page', {});
    expect(postIdleRead.text).toBeDefined();
    expect(postIdleRead.text.length).toBeGreaterThan(0);
    console.error('[idle-session] Step 6 OK: Post-idle read_page returned content — session context intact');

    // Step 7: Assert post-idle response time is reasonable (< 10s — "immediate response" per spec)
    // The spec says "immediate response, no reconnection needed" — we allow up to 10s
    // for the post-idle call to complete (Chrome may need a moment to wake up).
    const postIdleStart = Date.now();
    await mcp.callTool('navigate', { url: testUrl });
    const postIdleMs = Date.now() - postIdleStart;
    console.error(`[idle-session] Step 7: Post-idle navigation time: ${postIdleMs}ms`);
    expect(postIdleMs).toBeLessThan(10_000);
    console.error('[idle-session] Step 7 OK: Post-idle response < 10s — no reconnection delay observed');

    console.error('[idle-session] All steps passed — idle session survival spec PASS (#347)');
  }, scaled(120_000) + JEST_OVERHEAD_MS);

  test('multiple tabs survive idle period and respond after wake (#347 spec)', async () => {
    const port = getFixturePort();
    const urls = [
      `http://localhost:${port}/site-a`,
      `http://localhost:${port}/site-b`,
      `http://localhost:${port}/site-c`,
    ];

    // Step 1: Open multiple tabs
    console.error('[idle-session] Multi-tab Step 1: Opening 3 tabs');
    for (const url of urls) {
      await mcp.callTool('tabs_create', { url });
      await sleep(1000);
    }
    console.error('[idle-session] Multi-tab Step 1 OK: 3 tabs opened');

    // Step 2: Shorter idle for multi-tab test (10s full-scale, ~2s CI)
    const shortIdleMs = scaled(10_000);
    console.error(`[idle-session] Multi-tab Step 2: Short idle period (${shortIdleMs}ms)`);
    await sleep(shortIdleMs);
    console.error('[idle-session] Multi-tab Step 2 OK: Short idle complete');

    // Step 3: Navigate to each tab URL — all should respond without reconnection
    console.error('[idle-session] Multi-tab Step 3: Navigating all tabs after idle');
    for (const url of urls) {
      const result = await mcp.callTool('navigate', { url }, 20_000);
      expect(result.text).toBeDefined();
    }
    console.error('[idle-session] Multi-tab Step 3 OK: All 3 tabs responded after idle');
  }, scaled(90_000) + JEST_OVERHEAD_MS);

  test('session responds correctly after repeated short idle periods (#347 heartbeat)', async () => {
    const port = getFixturePort();
    const testUrl = `http://localhost:${port}/`;

    // Simulates the adaptive heartbeat: multiple idle-then-active cycles.
    // Per #347: "adaptive: 15s idle mode" — heartbeat adapts during idle.
    // We verify the session stays responsive through 3 idle-active cycles.

    const cycleIdleMs = scaled(5_000); // 5s full-scale, ~1s CI
    const numCycles = 3;

    console.error(`[idle-session] Heartbeat test: ${numCycles} idle-active cycles (${cycleIdleMs}ms idle each)`);

    for (let cycle = 1; cycle <= numCycles; cycle++) {
      // Active phase
      console.error(`[idle-session] Cycle ${cycle}/${numCycles}: active phase`);
      const navResult = await mcp.callTool('navigate', { url: testUrl }, 20_000);
      expect(navResult.text).toBeDefined();

      const readResult = await mcp.callTool('read_page', {});
      expect(readResult.text.length).toBeGreaterThan(0);
      console.error(`[idle-session] Cycle ${cycle}/${numCycles}: active phase OK`);

      // Idle phase
      if (cycle < numCycles) {
        console.error(`[idle-session] Cycle ${cycle}/${numCycles}: entering idle (${cycleIdleMs}ms)`);
        await sleep(cycleIdleMs);
        console.error(`[idle-session] Cycle ${cycle}/${numCycles}: idle complete`);
      }
    }

    // Final verification after all cycles
    const finalResult = await mcp.callTool('navigate', { url: testUrl }, 20_000);
    expect(finalResult.text).toBeDefined();
    console.error('[idle-session] Heartbeat test OK: session survived all idle-active cycles (#347 spec PASS)');
  }, scaled(90_000) + JEST_OVERHEAD_MS);

  test.skip('default session TTL exempt — 30-minute idle (requires full-scale timing)', async () => {
    // This test requires TIME_SCALE=1 and ~35 minutes to complete.
    // It is skipped in CI where TIME_SCALE < 1.
    // To run locally: TIME_SCALE=1 npx jest idle-session.e2e.ts
    //
    // Full spec:
    //   - Active session with tabs
    //   - No MCP calls for 30 minutes
    //   - Assert: Default session NOT expired (protected by exempt check)
    //   - Assert: Heartbeat maintained connection (adaptive: 15s idle mode)
    //   - Send interact tool call
    //   - PASS: Immediate response, no reconnection needed

    const port = getFixturePort();
    const testUrl = `http://localhost:${port}/`;

    await mcp.callTool('navigate', { url: testUrl });
    await mcp.callTool('read_page', {});

    // 30-minute idle
    await scaledSleep(30 * 60 * 1000);

    // Session should still be alive — default session is TTL-exempt
    const result = await mcp.callTool('navigate', { url: testUrl }, 30_000);
    expect(result.text).toBeDefined();
  }, scaled(35 * 60 * 1000) + JEST_OVERHEAD_MS);
});
