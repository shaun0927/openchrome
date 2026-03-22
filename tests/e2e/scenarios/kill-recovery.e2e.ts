/**
 * E2E-2: Chrome Kill -9 Recovery
 * Validates: Chrome recovers within 30 seconds after SIGKILL.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient } from '../harness/mcp-client';
import { ChromeController } from '../harness/chrome-controller';

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

describe('E2E-2: Kill Recovery', () => {
  let mcp: MCPClient;
  let chrome: ChromeController;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
    chrome = new ChromeController();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('Chrome recovers within 30s after kill -9', async () => {
    const port = getFixturePort();
    const testUrl = `http://localhost:${port}/`;

    // Navigate to establish connection and get tabId
    const navResult = await mcp.callTool('navigate', { url: testUrl });
    const tabIdMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId = tabIdMatch?.[1] || '';
    const beforeResult = await mcp.callTool('read_page', { tabId });
    expect(beforeResult.text).toContain('E2E Test');

    // Discover Chrome PID
    await chrome.discoverPid();
    const oldPid = chrome.getPid();
    expect(oldPid).toBeGreaterThan(0);

    // Kill Chrome with SIGKILL
    await chrome.kill('SIGKILL');

    // Wait for recovery (watchdog should relaunch)
    const start = Date.now();
    const newPid = await chrome.waitForRelaunch(30_000);
    const recoveryMs = Date.now() - start;

    console.error(`[kill-recovery] Recovery took ${recoveryMs}ms (old PID: ${oldPid}, new PID: ${newPid})`);

    // Assertions
    expect(newPid).not.toBe(oldPid);
    expect(recoveryMs).toBeLessThan(30_000);

    // Verify functional recovery — may need a brief delay for reconnect
    await new Promise((r) => setTimeout(r, 5000));
    const afterResult = await mcp.callTool('navigate', { url: testUrl }, 60_000);
    expect(afterResult.text).toBeDefined();
  }, 120_000); // 2 min timeout
});
