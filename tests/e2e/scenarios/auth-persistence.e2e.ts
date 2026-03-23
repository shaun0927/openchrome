/**
 * E2E-4: Auth State Persistence
 * Validates: Cookies and auth state survive MCP server restart via StorageState.
 *
 * Tests OpenChrome's StorageStateManager save/restore cycle:
 * 1. Session 1: Set cookies via CDP → MCP server saves state on clean shutdown
 * 2. Session 2: New MCP server restores cookies from stored state
 *
 * This validates OpenChrome's unique persistence mechanism, not Chrome's
 * built-in cookie storage. No Chrome kill/restart required.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MCPClient } from '../harness/mcp-client';
import { sleep } from '../harness/time-scale';

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

describe('E2E-4: Auth Persistence', () => {
  // Use a fixed storage dir so both MCP sessions share it
  const storageDir = path.join(os.tmpdir(), `oc-e2e4-storage-${Date.now()}`);

  afterAll(() => {
    // Clean up storage dir
    try {
      if (fs.existsSync(storageDir)) {
        fs.rmSync(storageDir, { recursive: true });
      }
    } catch {
      // Best effort cleanup
    }
  });

  test('cookies survive MCP server restart via StorageState', async () => {
    const port = getFixturePort();
    const loginUrl = `http://localhost:${port}/login`;
    const protectedUrl = `http://localhost:${port}/protected`;

    // ── Session 1: Set cookies, then shut down cleanly ──

    const mcp1 = new MCPClient({
      timeoutMs: 60_000,
      env: { OC_STORAGE_DIR: storageDir },
      args: ['--auto-launch'],
    });
    await mcp1.start();

    // Navigate to establish a page context
    const nav1 = await mcp1.callTool('navigate', { url: loginUrl });
    const tabIdMatch1 = nav1.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId1 = tabIdMatch1?.[1] || '';
    expect(tabId1).toBeTruthy();
    await sleep(1000);

    // Set session cookie via CDP
    await mcp1.callTool('cookies', {
      tabId: tabId1,
      action: 'set',
      name: 'session_id',
      value: 'e2e_persist_test_abc123',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 86400,
    });

    // Verify cookie was set in session 1
    const cookies1 = await mcp1.callTool('cookies', { tabId: tabId1, action: 'get' });
    console.error(`[auth-persistence] Session 1 cookies: ${cookies1.text.slice(0, 200)}`);
    expect(cookies1.text).toContain('session_id');

    // Clean shutdown — triggers StorageStateManager.save()
    await mcp1.stop();
    console.error('[auth-persistence] Session 1 stopped (storage state saved)');

    // Verify storage state file was written
    const storageFiles = fs.existsSync(storageDir)
      ? fs.readdirSync(storageDir).filter(f => f.endsWith('.json'))
      : [];
    console.error(`[auth-persistence] Storage files: ${storageFiles.join(', ') || 'none'}`);
    expect(storageFiles.length).toBeGreaterThan(0);

    // Read and verify the storage state content
    const stateFilePath = path.join(storageDir, storageFiles[0]);
    const savedState = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    const hasCookie = savedState.cookies?.some(
      (c: { name: string }) => c.name === 'session_id'
    );
    console.error(`[auth-persistence] Storage state has session_id: ${hasCookie}`);
    expect(hasCookie).toBe(true);

    await sleep(2000);

    // ── Session 2: New MCP server, verify cookies restored ──

    const mcp2 = new MCPClient({
      timeoutMs: 60_000,
      env: { OC_STORAGE_DIR: storageDir },
      args: ['--auto-launch'],
    });
    await mcp2.start();

    // Navigate to the protected page
    const nav2 = await mcp2.callTool('navigate', { url: protectedUrl });
    const tabIdMatch2 = nav2.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId2 = tabIdMatch2?.[1] || '';
    expect(tabId2).toBeTruthy();
    await sleep(1000);

    // Verify cookies were restored from StorageState
    const cookies2 = await mcp2.callTool('cookies', { tabId: tabId2, action: 'get' });
    console.error(`[auth-persistence] Session 2 cookies: ${cookies2.text.slice(0, 200)}`);
    expect(cookies2.text).toContain('session_id');

    // Verify the protected page recognizes the session
    const pageContent = await mcp2.callTool('read_page', { tabId: tabId2 });
    console.error(`[auth-persistence] Protected page: ${pageContent.text.slice(0, 200)}`);

    // Clean shutdown
    await mcp2.stop();
    console.error('[auth-persistence] Session 2 stopped — test complete');
  }, 120_000); // 2 min timeout
});
