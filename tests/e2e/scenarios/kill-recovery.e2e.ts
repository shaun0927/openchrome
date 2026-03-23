/**
 * E2E-2: Chrome Kill -9 Recovery
 * Validates: After Chrome is killed, MCP server restart with auto-launch
 * recovers full functionality by launching a new Chrome instance.
 *
 * Tests the real recovery path: Chrome death → MCP restart → auto-launch → reconnect.
 * Uses an isolated port (19222) to avoid interference from other Chrome instances.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient } from '../harness/mcp-client';
import { ChromeController } from '../harness/chrome-controller';
import { sleep } from '../harness/time-scale';

const CHROME_PORT = 19222;

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

describe('E2E-2: Kill Recovery', () => {
  let mcp: MCPClient;
  let chrome: ChromeController;

  beforeAll(async () => {
    mcp = new MCPClient({
      timeoutMs: 60_000,
      args: ['--auto-launch', '--port', String(CHROME_PORT)],
    });
    await mcp.start();
    chrome = new ChromeController();
  }, 90_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('Chrome recovers after kill -9 via MCP restart + auto-launch', async () => {
    const port = getFixturePort();
    const testUrl = `http://localhost:${port}/`;

    // Step 1: Navigate to establish connection
    console.error('[kill-recovery] Step 1: Navigating to establish initial connection');
    const navResult = await mcp.callTool('navigate', { url: testUrl });
    expect(navResult.text).toBeDefined();
    const tabIdMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId1 = tabIdMatch?.[1] || '';
    console.error(`[kill-recovery] Step 1 OK: Initial page loaded, tabId=${tabId1}`);

    // Step 2: Verify page content before kill
    const beforeResult = await mcp.callTool('read_page', { tabId: tabId1 });
    expect(beforeResult.text).toContain('E2E Test');
    console.error('[kill-recovery] Step 2 OK: Page content verified');

    // Step 3: Discover Chrome PID and kill it
    console.error(`[kill-recovery] Step 3: Discovering Chrome PID on port ${CHROME_PORT}`);
    await chrome.discoverPid(CHROME_PORT);
    const oldPid = chrome.getPid();
    expect(oldPid).toBeGreaterThan(0);
    console.error(`[kill-recovery] Step 3 OK: Chrome PID=${oldPid}, sending SIGKILL`);
    await chrome.kill('SIGKILL');

    // Step 4: Verify Chrome is dead
    await sleep(2000);
    const isRunning = await chrome.isRunning();
    expect(isRunning).toBe(false);
    console.error('[kill-recovery] Step 4 OK: Chrome confirmed dead');

    // Step 5: Restart MCP server — auto-launch will start new Chrome
    console.error('[kill-recovery] Step 5: Restarting MCP server (auto-launch will start new Chrome)');
    const restartStart = Date.now();
    await mcp.restart();
    const restartMs = Date.now() - restartStart;
    console.error(`[kill-recovery] Step 5 OK: MCP server restarted in ${restartMs}ms`);

    // Step 6: Navigate — triggers auto-launch of new Chrome
    console.error('[kill-recovery] Step 6: Navigating to trigger Chrome auto-launch + verify recovery');
    const afterResult = await mcp.callTool('navigate', { url: testUrl }, 60_000);
    const totalRecoveryMs = Date.now() - restartStart;
    expect(afterResult.text).toBeDefined();
    console.error(`[kill-recovery] Step 6 OK: Post-recovery navigation succeeded (total recovery: ${totalRecoveryMs}ms)`);

    // Step 7: Verify new Chrome PID differs from old
    await sleep(1000);
    const newPid = await chrome.discoverPid(CHROME_PORT);
    expect(newPid).not.toBe(oldPid);
    console.error(`[kill-recovery] Step 7 OK: New Chrome PID=${newPid} (was ${oldPid})`);

    // Step 8: Assert total recovery time < 30s per #347 spec
    console.error(`[kill-recovery] Step 8: Asserting total recovery < 30s (actual: ${totalRecoveryMs}ms)`);
    expect(totalRecoveryMs).toBeLessThan(30_000);
    console.error('[kill-recovery] Step 8 OK: Recovery time within 30s spec');

    // Step 9: Verify full functionality — cookie set/get
    console.error('[kill-recovery] Step 9: Verifying cookie functionality post-recovery');
    const tabIdMatch2 = afterResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId2 = tabIdMatch2?.[1] || '';

    await mcp.callTool('cookies', {
      tabId: tabId2,
      action: 'set',
      name: 'e2e_recovery_check',
      value: 'recovered',
      path: '/',
    }, 30_000);

    const getCookieResult = await mcp.callTool('cookies', {
      tabId: tabId2,
      action: 'get',
    }, 30_000);
    expect(getCookieResult.text).toContain('e2e_recovery_check');
    console.error('[kill-recovery] Step 9 OK: Cookie set/get works post-recovery');
  }, 180_000);
});
