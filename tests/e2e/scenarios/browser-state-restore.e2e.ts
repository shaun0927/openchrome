/**
 * E2E-3: Browser State Snapshot & Restore
 * Validates: After Chrome is killed, cookies set before the kill are restored
 * from the BrowserStateManager snapshot when a new Chrome instance starts.
 *
 * Tests the real-world snapshot/restore path:
 *   navigate → set cookie → wait for snapshot interval → kill Chrome
 *   → MCP restart → auto-launch new Chrome → verify cookie restored from snapshot.
 *
 * Uses an isolated port (19223) to avoid interference with other e2e tests.
 *
 * Gap #2 / Issue #416: Browser state snapshot & cookie restore after reconnection.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient } from '../harness/mcp-client';
import { ChromeController } from '../harness/chrome-controller';
import { sleep } from '../harness/time-scale';

const CHROME_PORT = 19223;

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

describe('E2E-3: Browser State Snapshot & Restore', () => {
  let mcp: MCPClient;
  let chrome: ChromeController;

  beforeAll(async () => {
    mcp = new MCPClient({
      timeoutMs: 60_000,
      args: ['--port', String(CHROME_PORT)],
    });
    await mcp.start();
    chrome = new ChromeController();
  }, 90_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test(
    'cookies are restored from snapshot after Chrome kill + MCP restart',
    async () => {
      const port = getFixturePort();
      const testUrl = `http://localhost:${port}/`;

      // Step 1: Navigate to establish connection and get a tabId
      console.error('[browser-state-restore] Step 1: Navigating to establish initial connection');
      const navResult = await mcp.callTool('navigate', { url: testUrl });
      expect(navResult.text).toBeDefined();
      const tabIdMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
      const tabId = tabIdMatch?.[1] || '';
      console.error(`[browser-state-restore] Step 1 OK: Initial page loaded, tabId=${tabId}`);

      // Step 2: Set a unique cookie whose value includes a timestamp.
      // The timestamp proves that the cookie was restored from the snapshot and
      // not freshly created after reconnection.
      const cookieValue = `restored_${Date.now()}`;
      console.error(`[browser-state-restore] Step 2: Setting cookie e2e_state_restore=${cookieValue}`);
      await mcp.callTool('cookies', {
        tabId,
        action: 'set',
        name: 'e2e_state_restore',
        value: cookieValue,
        path: '/',
      }, 30_000);
      console.error('[browser-state-restore] Step 2 OK: Cookie set');

      // Step 3: Verify the cookie is present before the kill (sanity check)
      console.error('[browser-state-restore] Step 3: Verifying cookie is present before kill');
      const beforeKillResult = await mcp.callTool('cookies', {
        tabId,
        action: 'get',
      }, 30_000);
      expect(beforeKillResult.text).toContain('e2e_state_restore');
      expect(beforeKillResult.text).toContain(cookieValue);
      console.error('[browser-state-restore] Step 3 OK: Cookie confirmed present before kill');

      // Step 4: Wait for the BrowserStateManager snapshot interval (default 60s).
      // We wait 65s to ensure at least one snapshot cycle has fired and persisted
      // the cookies to disk.
      console.error('[browser-state-restore] Step 4: Waiting 65s for BrowserStateManager snapshot interval...');
      await sleep(65_000);
      console.error('[browser-state-restore] Step 4 OK: Snapshot interval elapsed');

      // Step 5: Discover Chrome PID and kill it with SIGKILL (simulating a crash)
      console.error(`[browser-state-restore] Step 5: Discovering Chrome PID on port ${CHROME_PORT}`);
      await chrome.discoverPid(CHROME_PORT);
      const oldPid = chrome.getPid();
      expect(oldPid).toBeGreaterThan(0);
      console.error(`[browser-state-restore] Step 5: Chrome PID=${oldPid}, sending SIGKILL`);
      await chrome.kill('SIGKILL');

      // Step 6: Verify Chrome is dead before proceeding
      await sleep(2000);
      const isRunning = await chrome.isRunning();
      expect(isRunning).toBe(false);
      console.error('[browser-state-restore] Step 6 OK: Chrome confirmed dead');

      // Step 7: Restart MCP server — auto-launch will start a new Chrome instance
      console.error('[browser-state-restore] Step 7: Restarting MCP server (auto-launch will start new Chrome)');
      const restartStart = Date.now();
      await mcp.restart();
      const restartMs = Date.now() - restartStart;
      console.error(`[browser-state-restore] Step 7 OK: MCP server restarted in ${restartMs}ms`);

      // Step 8: Navigate to the same page — this triggers reconnection + auto-launch
      // of new Chrome. The BrowserStateManager should restore cookies from the snapshot.
      console.error('[browser-state-restore] Step 8: Navigating to trigger auto-launch + cookie restore');
      const afterResult = await mcp.callTool('navigate', { url: testUrl }, 60_000);
      expect(afterResult.text).toBeDefined();
      const tabIdMatch2 = afterResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
      const newTabId = tabIdMatch2?.[1] || '';
      console.error(`[browser-state-restore] Step 8 OK: Post-restart navigation succeeded, tabId=${newTabId}`);

      // Step 9: Verify that the cookie 'e2e_state_restore' is present and has the
      // exact timestamp value that was set before the kill. This confirms:
      //   - The snapshot captured the cookie after it was set
      //   - The new Chrome instance had cookies restored from the snapshot
      //   - The cookie was NOT re-created fresh (value matches the pre-kill timestamp)
      console.error('[browser-state-restore] Step 9: Verifying cookie restored from snapshot');
      const afterRestoreResult = await mcp.callTool('cookies', {
        tabId: newTabId,
        action: 'get',
      }, 30_000);
      expect(afterRestoreResult.text).toContain('e2e_state_restore');
      expect(afterRestoreResult.text).toContain(cookieValue);
      console.error(
        `[browser-state-restore] Step 9 OK: Cookie e2e_state_restore=${cookieValue} ` +
        'confirmed restored from snapshot — snapshot/restore flow validated'
      );
    },
    300_000, // 5-minute timeout: 65s snapshot wait + kill + restart + verify
  );
});
