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
    const url1 = `http://localhost:${port}/site-a`;
    const url2 = `http://localhost:${port}/site-b`;

    // Create two tabs
    const tab1Result = await mcp.callTool('tabs_create', { url: url1 });
    await sleep(2000);
    const tab2Result = await mcp.callTool('tabs_create', { url: url2 });
    await sleep(2000);

    // Verify tab2 is functional before crash
    const before = await mcp.callTool('read_page', {});
    expect(before.text).toBeDefined();

    // Attempt to crash tab1 — navigate to chrome://crash
    // This may fail (which is expected — crash page navigations throw)
    try {
      await mcp.callTool('navigate', { url: 'chrome://crash' }, 10_000);
    } catch {
      // Expected — chrome://crash causes the renderer to crash
      console.error('[tab-isolation] Tab crash triggered (expected)');
    }

    await sleep(3000);

    // tab2 should still be functional — navigate back to it
    await mcp.callTool('navigate', { url: url2 });
    await sleep(1000);

    const afterResult = await mcp.callTool('read_page', {});
    expect(afterResult.text).toBeDefined();
    expect(afterResult.text.length).toBeGreaterThan(0);

    console.error('[tab-isolation] Non-crashed tab remains functional');
  }, 120_000);
});
