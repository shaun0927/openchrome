/**
 * E2E-4: Auth State Persistence
 * Validates: Cookies survive Chrome restart.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient } from '../harness/mcp-client';
import { ChromeController } from '../harness/chrome-controller';
import { sleep } from '../harness/time-scale';

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

describe('E2E-4: Auth Persistence', () => {
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

  test('cookies survive Chrome restart', async () => {
    const port = getFixturePort();
    const loginUrl = `http://localhost:${port}/login`;
    const protectedUrl = `http://localhost:${port}/protected`;

    // Step 1: Navigate to login page and get tabId
    const navResult = await mcp.callTool('navigate', { url: loginUrl });
    const tabIdMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId = tabIdMatch?.[1] || '';
    await sleep(1000);

    // Step 2: Fill form and submit (sets cookies via client-side JS)
    try {
      await mcp.callTool('fill_form', {
        tabId,
        fields: { username: 'test', password: 'test' },
      });
    } catch {
      // fill_form may not exist, use interact instead
      await mcp.callTool('interact', { tabId, action: 'click', query: 'Login' });
    }
    await sleep(2000);

    // Step 3: Verify cookie was set
    const cookiesBefore = await mcp.callTool('cookies', { tabId, action: 'get' });
    console.error(`[auth-persistence] Cookies before restart: ${cookiesBefore.text.slice(0, 200)}`);
    expect(cookiesBefore.text).toContain('session_id');

    // Step 4: Discover Chrome PID and kill it
    await chrome.discoverPid();
    const oldPid = chrome.getPid();
    await chrome.kill('SIGKILL');

    // Step 5: Wait for Chrome to relaunch
    const newPid = await chrome.waitForRelaunch(30_000);
    expect(newPid).not.toBe(oldPid);
    console.error(`[auth-persistence] Chrome restarted (${oldPid} → ${newPid})`);

    // Give time for reconnection
    await sleep(5000);

    // Step 6: Navigate to protected page and verify cookies restored
    const navAfter = await mcp.callTool('navigate', { url: protectedUrl }, 60_000);
    const tabIdMatch2 = navAfter.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId2 = tabIdMatch2?.[1] || tabId;

    const cookiesAfter = await mcp.callTool('cookies', { tabId: tabId2, action: 'get' });
    console.error(`[auth-persistence] Cookies after restart: ${cookiesAfter.text.slice(0, 200)}`);
    expect(cookiesAfter.text).toContain('session_id');
  }, 120_000); // 2 min timeout
});
