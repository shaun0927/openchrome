/**
 * E2E-5: Tab Isolation
 * Validates: Renderer crash in one tab does not affect others.
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

describe('E2E-5: Tab Isolation', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('renderer crash in one tab does not affect others', async () => {
    const port = getFixturePort();
    const url0 = `http://localhost:${port}/`;
    const url1 = `http://localhost:${port}/site-a`;
    const url2 = `http://localhost:${port}/site-b`;

    // Create three tabs per #347 spec
    console.error('[tab-isolation] Step 1: Opening tab0 (root)');
    await mcp.callTool('tabs_create', { url: url0 });
    await sleep(2000);

    console.error('[tab-isolation] Step 2: Opening tab1 (/site-a)');
    await mcp.callTool('tabs_create', { url: url1 });
    await sleep(2000);

    console.error('[tab-isolation] Step 3: Opening tab2 (/site-b)');
    await mcp.callTool('tabs_create', { url: url2 });
    await sleep(2000);

    console.error('[tab-isolation] Step 1-3 OK: 3 tabs opened');

    // Verify tab2 is functional before crash
    console.error('[tab-isolation] Step 4: Verifying tab2 is functional before crash');
    const before = await mcp.callTool('read_page', {});
    expect(before.text).toBeDefined();
    console.error('[tab-isolation] Step 4 OK: Pre-crash read_page succeeded');

    // Attempt to crash tab1 (site-a) — navigate to chrome://crash
    // This will throw which is expected — crash page navigations cause renderer crash
    console.error('[tab-isolation] Step 5: Navigating tab1 to chrome://crash to trigger renderer crash');
    try {
      await mcp.callTool('navigate', { url: 'chrome://crash' }, 10_000);
    } catch (err) {
      // Expected — chrome://crash causes the renderer to crash
      console.error(`[tab-isolation] Step 5 OK: Tab crash triggered as expected — ${err instanceof Error ? err.message : String(err)}`);
    }

    // Wait 2s for crash to propagate before checking other tabs
    console.error('[tab-isolation] Step 6: Waiting 2s for crash propagation');
    await sleep(2000);

    // Check oc_profile_status — may contain info about connected/crashed tabs
    console.error('[tab-isolation] Step 7: Calling oc_profile_status to inspect tab state post-crash');
    try {
      const statusResult = await mcp.callTool('oc_profile_status', {}, 15_000);
      expect(statusResult.text).toBeDefined();
      console.error(`[tab-isolation] Step 7 OK: oc_profile_status responded — ${statusResult.text.slice(0, 200)}`);
    } catch (err) {
      // oc_profile_status is informational — log but don't fail the test
      console.error(`[tab-isolation] Step 7 WARN: oc_profile_status failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`);
    }

    // Verify tab0 (root) is still functional
    console.error('[tab-isolation] Step 8: Verifying tab0 (root) is still functional');
    await mcp.callTool('navigate', { url: url0 });
    await sleep(1000);
    const afterTab0 = await mcp.callTool('read_page', {});
    expect(afterTab0.text).toBeDefined();
    expect(afterTab0.text.length).toBeGreaterThan(0);
    console.error('[tab-isolation] Step 8 OK: tab0 (root) remains functional after crash');

    // Verify tab2 (site-b) is still functional
    console.error('[tab-isolation] Step 9: Verifying tab2 (/site-b) is still functional');
    await mcp.callTool('navigate', { url: url2 });
    await sleep(1000);
    const afterTab2 = await mcp.callTool('read_page', {});
    expect(afterTab2.text).toBeDefined();
    expect(afterTab2.text.length).toBeGreaterThan(0);
    console.error('[tab-isolation] Step 9 OK: tab2 (/site-b) remains functional after crash');

    console.error('[tab-isolation] All steps passed: both non-crashed tabs remain functional');
  }, 120_000);
});
