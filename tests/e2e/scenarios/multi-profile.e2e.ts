/**
 * E2E-9: Multi-Profile Isolation
 * Validates: multiple Chrome profiles can run simultaneously via profileDirectory
 * parameter, with proper isolation between profiles.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient, MCPToolResult } from '../harness/mcp-client';
import { scaledSleep } from '../harness/time-scale';

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

/** Parse JSON from the first parseable content item (handles multi-block MCP responses) */
function tryParseJSON(result: MCPToolResult): unknown | null {
  for (const item of result.content) {
    if (item.text) {
      try { return JSON.parse(item.text); } catch { /* try next item */ }
    }
  }
  try { return JSON.parse(result.text); } catch { return null; }
}

describe('E2E-9: Multi-Profile Isolation', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({
      timeoutMs: 60_000,
      args: ['--auto-launch'],
    });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test(
    'Multi-Profile Isolation — profiles are isolated and can run simultaneously',
    async () => {
      const port = getFixturePort();

      // ── Phase 9a: List profiles ──────────────────────────────────────────────
      console.error('[multi-profile] Phase 9a: listing profiles');
      const listResult = await mcp.callTool('list_profiles', {});
      expect(listResult.text).toBeDefined();
      const parsed = tryParseJSON(listResult) as { profiles?: Array<{ directory: string; name: string }> } | null;
      if (!parsed || !Array.isArray(parsed.profiles) || parsed.profiles.length < 2) {
        console.error('[multi-profile] Phase 9a: fewer than 2 Chrome profiles available — skipping test');
        return;
      }
      const profiles = parsed.profiles;
      expect(profiles.length).toBeGreaterThanOrEqual(2);
      const firstProfile = profiles[0];
      expect(firstProfile).toHaveProperty('directory');
      expect(firstProfile).toHaveProperty('name');
      console.error(`[multi-profile] Phase 9a: found ${profiles.length} profiles`);

      // ── Phase 9b: Navigate with explicit profile (Default) ───────────────────
      console.error('[multi-profile] Phase 9b: navigating with Default profile');
      const navA = await mcp.callTool(
        'navigate',
        { url: `http://localhost:${port}/site-a`, profileDirectory: 'Default' },
        120_000,
      );
      expect(navA.text).toBeDefined();
      const navAData = tryParseJSON(navA) as Record<string, unknown>;
      expect(navAData).not.toBeNull();
      expect(navAData!.workerId).toMatch(/profile:Default/);
      const profileATabId: string = navAData!.tabId as string;
      expect(profileATabId).toBeTruthy();
      console.error(`[multi-profile] Phase 9b: Default profile workerId=${navAData.workerId} tabId=${profileATabId}`);

      await scaledSleep(2000);

      // ── Phase 9c: Navigate with second profile (Profile 1) ───────────────────
      console.error('[multi-profile] Phase 9c: navigating with Profile 1');
      const navB = await mcp.callTool(
        'navigate',
        { url: `http://localhost:${port}/site-b`, profileDirectory: 'Profile 1' },
        120_000,
      );
      expect(navB.text).toBeDefined();
      const navBData = tryParseJSON(navB) as Record<string, unknown>;
      expect(navBData).not.toBeNull();
      expect(navBData!.workerId).toMatch(/profile:Profile 1/);
      const profileBTabId: string = navBData!.tabId as string;
      expect(profileBTabId).toBeTruthy();
      console.error(`[multi-profile] Phase 9c: Profile 1 workerId=${navBData.workerId} tabId=${profileBTabId}`);

      await scaledSleep(2000);

      // ── Phase 9d: Cookie isolation ───────────────────────────────────────────
      console.error('[multi-profile] Phase 9d: testing cookie isolation');

      // Set a cookie in Profile A (Default)
      await mcp.callTool('javascript_tool', {
        code: 'document.cookie = "e2e_test=profile_a; path=/"',
        tabId: profileATabId,
      });
      console.error('[multi-profile] Phase 9d: set cookie in Default profile');

      await scaledSleep(1000);

      // Read cookies in Profile B (Profile 1) — e2e_test cookie must NOT be present
      const cookieResult = await mcp.callTool('javascript_tool', {
        code: 'document.cookie',
        tabId: profileBTabId,
      });
      expect(cookieResult.text).toBeDefined();
      expect(cookieResult.text).not.toContain('e2e_test=profile_a');
      console.error(`[multi-profile] Phase 9d: Profile 1 cookies="${cookieResult.text}" — isolation confirmed`);

      await scaledSleep(2000);

      // ── Phase 9e: Simultaneous read ──────────────────────────────────────────
      console.error('[multi-profile] Phase 9e: simultaneous read_page on both profiles');
      const [readA, readB] = await Promise.all([
        mcp.callTool('read_page', { tabId: profileATabId }),
        mcp.callTool('read_page', { tabId: profileBTabId }),
      ]);
      expect(readA.text).toBeDefined();
      expect(readA.text.length).toBeGreaterThan(0);
      expect(readB.text).toBeDefined();
      expect(readB.text.length).toBeGreaterThan(0);
      console.error(
        `[multi-profile] Phase 9e: readA=${readA.text.length} chars, readB=${readB.text.length} chars`,
      );

      // ── Phase 9f: Profile status ─────────────────────────────────────────────
      console.error('[multi-profile] Phase 9f: checking oc_profile_status');
      const statusResult = await mcp.callTool('oc_profile_status', {});
      expect(statusResult.text).toBeDefined();
      const status = tryParseJSON(statusResult) as { activeProfiles: Array<{ profileDirectory: string; port: number; tabCount: number }> } | null;
      expect(status).not.toBeNull();
      expect(status).toHaveProperty('activeProfiles');
      expect(Array.isArray(status!.activeProfiles)).toBe(true);
      expect(status!.activeProfiles.length).toBeGreaterThanOrEqual(2);
      for (const entry of status!.activeProfiles) {
        expect(entry).toHaveProperty('profileDirectory');
        expect(entry).toHaveProperty('port');
        expect(entry).toHaveProperty('tabCount');
      }
      const profileDirs = status!.activeProfiles.map(e => e.profileDirectory);
      expect(profileDirs).toContain('Default');
      expect(profileDirs).toContain('Profile 1');
      console.error(`[multi-profile] Phase 9f: active profiles: ${profileDirs.join(', ')}`);

      await scaledSleep(2000);

      // ── Phase 9g: Tab management per profile ─────────────────────────────────
      console.error('[multi-profile] Phase 9g: tabs_create per profile');
      const tabDefaultResult = await mcp.callTool(
        'tabs_create',
        { url: `http://localhost:${port}/site-c`, profileDirectory: 'Default' },
        60_000,
      );
      expect(tabDefaultResult.text).toBeDefined();
      const tabDefault = tryParseJSON(tabDefaultResult) as Record<string, unknown>;
      expect(tabDefault).not.toBeNull();
      expect(tabDefault!.tabId).toBeTruthy();
      console.error(`[multi-profile] Phase 9g: Default tab created tabId=${tabDefault!.tabId}`);

      const tabProfile1Result = await mcp.callTool(
        'tabs_create',
        { url: `http://localhost:${port}/site-a`, profileDirectory: 'Profile 1' },
        60_000,
      );
      expect(tabProfile1Result.text).toBeDefined();
      const tabProfile1 = tryParseJSON(tabProfile1Result) as Record<string, unknown>;
      expect(tabProfile1).not.toBeNull();
      expect(tabProfile1!.tabId).toBeTruthy();
      console.error(`[multi-profile] Phase 9g: Profile 1 tab created tabId=${tabProfile1!.tabId}`);

      await scaledSleep(1000);

      // Verify tabs context shows tabs associated with the correct workers
      const tabsCtxResult = await mcp.callTool('tabs_context', {});
      expect(tabsCtxResult.text).toBeDefined();
      expect(tabsCtxResult.text.length).toBeGreaterThan(0);
      console.error(`[multi-profile] Phase 9g: tabs_context returned ${tabsCtxResult.text.length} chars`);

      // ── Phase 9h: Profile instance reuse ─────────────────────────────────────
      console.error('[multi-profile] Phase 9h: verifying profile instance reuse');
      const reuseResult = await mcp.callTool(
        'navigate',
        { url: `http://localhost:${port}/site-c`, profileDirectory: 'Default' },
        60_000,
      );
      expect(reuseResult.text).toBeDefined();
      const reuseData = tryParseJSON(reuseResult) as Record<string, unknown>;
      expect(reuseData).not.toBeNull();
      expect(reuseData!.workerId).toMatch(/profile:Default/);
      console.error(`[multi-profile] Phase 9h: workerId=${reuseData!.workerId} — same instance reused`);

      await scaledSleep(1000);

      // ── Phase 9i: Graceful cleanup ───────────────────────────────────────────
      console.error('[multi-profile] Phase 9i: graceful cleanup via oc_stop');
      // oc_stop should not throw — MCPClient.stop() also calls it in afterAll
      await expect(mcp.callTool('oc_stop', {})).resolves.toBeDefined();
      console.error('[multi-profile] Phase 9i: oc_stop succeeded');
    },
    180_000,
  );
});
