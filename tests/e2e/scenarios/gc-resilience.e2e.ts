/**
 * E2E-3: Connection Health & Resilience
 * Validates: CDP connection survives burst load; Layer 1 (CDP) and Layer 4
 * (health monitoring) remain functional under rapid sequential tool calls.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient } from '../harness/mcp-client';
import { sleep } from '../harness/time-scale';

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

describe('E2E-3: GC Resilience', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('Connection health survives burst load and remains functional', async () => {
    const port = getFixturePort();
    const testUrl = `http://localhost:${port}/`;

    // Step 1: Navigate to establish CDP connection
    const navResult = await mcp.callTool('navigate', { url: testUrl });
    expect(navResult.text).toBeDefined();
    console.error('[connection-health] CDP connection established via navigate');

    let currentTabId: string | undefined;
    try {
      const navData = JSON.parse(navResult.content?.find((c: { text?: string }) => c.text)?.text || navResult.text || '{}');
      currentTabId = navData.tabId;
    } catch { /* fall through without tabId */ }

    // Step 2: Verify basic connectivity via multiple tool calls
    const statusBefore = await mcp.callTool('oc_profile_status', {});
    expect(statusBefore.text).toBeDefined();
    console.error('[connection-health] oc_profile_status OK (pre-burst)');

    const pageBefore = await mcp.callTool('read_page', currentTabId ? { tabId: currentTabId } : {});
    expect(pageBefore.text).toBeDefined();
    expect(pageBefore.text.length).toBeGreaterThan(0);
    console.error('[connection-health] read_page OK (pre-burst)');

    // Step 3: Stress the connection — rapid sequential tool calls (10+ in a burst)
    const burstErrors: string[] = [];
    const burstCount = 12;

    for (let i = 0; i < burstCount; i++) {
      try {
        if (i % 4 === 0) {
          // Re-navigate periodically to cycle CDP sessions
          const burstNav = await mcp.callTool('navigate', { url: testUrl });
          try {
            const burstNavData = JSON.parse(burstNav.content?.find((c: { text?: string }) => c.text)?.text || burstNav.text || '{}');
            if (burstNavData.tabId) currentTabId = burstNavData.tabId;
          } catch { /* keep existing tabId */ }
        } else if (i % 4 === 1) {
          await mcp.callTool('read_page', currentTabId ? { tabId: currentTabId } : {});
        } else if (i % 4 === 2) {
          await mcp.callTool('oc_profile_status', {});
        } else {
          await mcp.callTool('read_page', currentTabId ? { tabId: currentTabId } : {});
        }
        console.error(`[connection-health] burst call ${i + 1}/${burstCount} OK`);
      } catch (err) {
        const msg = `burst call ${i + 1}: ${(err as Error).message}`;
        burstErrors.push(msg);
        console.error(`[connection-health] FAIL ${msg}`);
      }
    }

    // Brief pause to let any pending CDP frames drain
    await sleep(500);

    // Step 4: Verify connection survived the burst
    const statusAfter = await mcp.callTool('oc_profile_status', {});
    expect(statusAfter.text).toBeDefined();
    console.error('[connection-health] oc_profile_status OK (post-burst)');

    // Step 5: Verify full read still works after burst
    const pageAfter = await mcp.callTool('read_page', currentTabId ? { tabId: currentTabId } : {});
    expect(pageAfter.text).toBeDefined();
    expect(pageAfter.text.length).toBeGreaterThan(0);
    console.error('[connection-health] read_page OK (post-burst)');

    // Step 6: All burst calls must have succeeded
    expect(burstErrors).toHaveLength(0);

    console.error(`[connection-health] Burst resilience test passed — ${burstCount} calls, 0 errors`);
  }, 120_000);
});
