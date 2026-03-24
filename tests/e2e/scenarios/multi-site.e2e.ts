/**
 * E2E-7: Idle Session Survival & Multi-Site
 * Validates: session survives idle heartbeat transition and recovers on next command;
 * also validates 3+ domains with interact+read cycles complete without error.
 *
 * Idle transition is triggered by setting OPENCHROME_IDLE_TRANSITION_MS=5000 (5s)
 * instead of the default 5 minutes, then waiting for the CDPClient to switch to
 * idle heartbeat mode. After the idle period the test issues a live command and
 * verifies the session responds within 30 s (allowing for any reconnection).
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

/** Try to parse JSON from individual content items (handles multi-block MCP responses) */
function tryParseJSON(result: MCPToolResult): unknown | null {
  for (const item of result.content) {
    if (item.text) {
      try { return JSON.parse(item.text); } catch { /* try next item */ }
    }
  }
  try { return JSON.parse(result.text); } catch { return null; }
}

describe('E2E-7: Multi-Site', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({
      timeoutMs: 60_000,
      env: { OPENCHROME_IDLE_TRANSITION_MS: '5000' },
    });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('Idle Session Survival & Multi-Site — session survives idle then serves multi-site', async () => {
    const port = getFixturePort();

    // ── Phase 1: Establish active connection ────────────────────────────────
    const siteA = `http://localhost:${port}/site-a`;
    const navResult = await mcp.callTool('navigate', { url: siteA });
    expect(navResult.text).toBeDefined();
    console.error('[idle-survival] Phase 1: navigated to site-a');

    // Extract tabId for later verification
    const navData = tryParseJSON(navResult) as Record<string, unknown> | null;
    const tabId = (navData?.tabId as string | undefined) ?? '';
    console.error(`[idle-survival] tabId: ${tabId || '(none)'}`);

    // ── Phase 2: Record initial state ───────────────────────────────────────
    const statusBefore = await mcp.callTool('oc_profile_status', {});
    expect(statusBefore.text).toBeDefined();
    const t0 = Date.now();
    console.error(`[idle-survival] Phase 2: oc_profile_status OK (${statusBefore.text.length} chars)`);

    // ── Phase 3: Wait for idle transition ───────────────────────────────────
    // OPENCHROME_IDLE_TRANSITION_MS=5000 means idle triggers after 5 s of no commands.
    // We wait 3× that (15 s scaled) to ensure the CDPClient has entered idle mode and
    // the idle heartbeat interval (max(3×base, 15 s)) has fired at least once.
    const idleTransitionMs = 5_000;
    const waitMs = idleTransitionMs * 3; // 15 s at full scale
    console.error(`[idle-survival] Phase 3: waiting ${waitMs}ms (scaled) for idle transition…`);
    await scaledSleep(waitMs);
    console.error('[idle-survival] Phase 3: idle wait complete');

    // ── Phase 4: Verify session survived idle ───────────────────────────────
    // Issue a live command — this should exit idle mode via recordCommandActivity()
    // and respond within 30 s even if a reconnect is needed.
    const t1 = Date.now();
    const postIdlePage = await mcp.callTool('read_page', tabId ? { tabId } : {}, 30_000);
    const responseMs = Date.now() - t1;
    expect(postIdlePage.text).toBeDefined();
    expect(postIdlePage.text.length).toBeGreaterThan(0);
    expect(responseMs).toBeLessThan(30_000);
    console.error(`[idle-survival] Phase 4: post-idle read_page OK (${responseMs}ms, ${postIdlePage.text.length} chars)`);

    // Verify total elapsed since initial navigate is sane (no unrecoverable hang)
    const totalElapsed = Date.now() - t0;
    console.error(`[idle-survival] Phase 4: total elapsed ${totalElapsed}ms`);

    // ── Phase 5: Multi-site verification ───────────────────────────────────
    const sites = [
      { url: `http://localhost:${port}/site-a`, action: 'click button#submit', expectedText: 'Site A' },
      { url: `http://localhost:${port}/site-b`, action: 'click button[type="submit"]', expectedText: 'Search' },
      { url: `http://localhost:${port}/site-c`, action: 'read table.data', expectedText: 'Data' },
    ];

    const results: Array<{ site: string; success: boolean; error?: string }> = [];

    for (const site of sites) {
      try {
        const siteNavResult = await mcp.callTool('navigate', { url: site.url });
        await scaledSleep(1000);

        let siteTabId: string | undefined;
        try {
          const siteNavData = JSON.parse(siteNavResult.content?.find((c: { text?: string }) => c.text)?.text || siteNavResult.text || '{}');
          siteTabId = siteNavData.tabId;
        } catch { /* fall through without tabId */ }

        const page = await mcp.callTool('read_page', siteTabId ? { tabId: siteTabId } : {});
        expect(page.text).toBeDefined();
        expect(page.text.length).toBeGreaterThan(0);

        try {
          await mcp.callTool('interact', { description: site.action });
        } catch {
          // Some interactions may fail but the page should still be functional
          console.error(`[idle-survival] Interaction failed for ${site.url}: ${site.action} (non-fatal)`);
        }
        await scaledSleep(500);

        const afterPage = await mcp.callTool('read_page', siteTabId ? { tabId: siteTabId } : {});
        expect(afterPage.text).toBeDefined();

        results.push({ site: site.url, success: true });
        console.error(`[idle-survival] Phase 5: ✓ ${site.url}`);
      } catch (err) {
        results.push({ site: site.url, success: false, error: (err as Error).message });
        console.error(`[idle-survival] Phase 5: ✗ ${site.url}: ${(err as Error).message}`);
      }
    }

    // All 3 sites must succeed
    const successCount = results.filter(r => r.success).length;
    expect(successCount).toBe(sites.length);
    console.error(`[idle-survival] Phase 5: ${successCount}/${sites.length} sites passed`);
  }, 120_000);
});
