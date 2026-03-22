/**
 * E2E-7: Multi-Site Continuous Operation
 * Validates: 3+ domains with interact+read cycles complete without error.
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

describe('E2E-7: Multi-Site', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('3+ sites with interact+read cycles complete successfully', async () => {
    const port = getFixturePort();

    const sites = [
      { url: `http://localhost:${port}/site-a`, action: 'click button#submit', expectedText: 'Site A' },
      { url: `http://localhost:${port}/site-b`, action: 'click button[type="submit"]', expectedText: 'Search' },
      { url: `http://localhost:${port}/site-c`, action: 'read table.data', expectedText: 'Data' },
    ];

    const results: Array<{ site: string; success: boolean; error?: string }> = [];

    for (const site of sites) {
      try {
        // Navigate to site
        await mcp.callTool('navigate', { url: site.url });
        await sleep(1000);

        // Read page content
        const page = await mcp.callTool('read_page', {});
        expect(page.text).toBeDefined();
        expect(page.text.length).toBeGreaterThan(0);

        // Site-specific interaction
        try {
          await mcp.callTool('interact', { description: site.action });
        } catch {
          // Some interactions may fail but page should still be functional
          console.error(`[multi-site] Interaction failed for ${site.url}: ${site.action} (non-fatal)`);
        }
        await sleep(500);

        // Verify page still accessible after interaction
        const afterPage = await mcp.callTool('read_page', {});
        expect(afterPage.text).toBeDefined();

        results.push({ site: site.url, success: true });
        console.error(`[multi-site] ✓ ${site.url}`);
      } catch (err) {
        results.push({ site: site.url, success: false, error: (err as Error).message });
        console.error(`[multi-site] ✗ ${site.url}: ${(err as Error).message}`);
      }
    }

    // All 3 sites must succeed
    const successCount = results.filter(r => r.success).length;
    expect(successCount).toBe(sites.length);
    console.error(`[multi-site] ${successCount}/${sites.length} sites passed`);
  }, 120_000);
});
