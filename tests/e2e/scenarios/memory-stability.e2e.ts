/**
 * E2E-6: Memory Stability
 * Validates external MCP process resident-memory growth after successful work.
 * This does not measure V8 heap or the Chrome process tree.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MCPClient } from '../harness/mcp-client';
import { HeapSampler } from '../harness/heap-sampler';
import { scaled, scaledSleep, JEST_OVERHEAD_MS } from '../harness/time-scale';

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

describe('E2E-6: Memory Stability', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('MCP resident-memory growth remains under 50MB after successful extended operation', async () => {
    const port = getFixturePort();
    const sampler = new HeapSampler({ pid: mcp.pid });
    sampler.takeBaseline();

    const sites = [
      `http://localhost:${port}/site-a`,
      `http://localhost:${port}/site-b`,
      `http://localhost:${port}/site-c`,
      `http://localhost:${port}/`,
    ];

    // 30 minutes of continuous work (5 min at CI scale)
    const endTime = Date.now() + scaled(30 * 60 * 1000);
    let cycle = 0;
    const failures: string[] = [];

    while (Date.now() < endTime) {
      const site = sites[cycle % sites.length];
      try {
        const navRes = await mcp.callTool('navigate', { url: site });
        if (navRes.raw.isError) throw new Error(`navigate failed: ${navRes.text}`);
        let loopTabId: string | undefined;
        try {
          const navResData = JSON.parse(navRes.content?.find((c: { text?: string }) => c.text)?.text || navRes.text || '{}');
          loopTabId = navResData.tabId;
        } catch { /* fall through without tabId */ }
        if (!loopTabId) throw new Error('Navigation did not return a target id');
        const read = await mcp.callTool('read_page', { tabId: loopTabId });
        if (read.raw.isError) throw new Error(`read_page failed: ${read.text}`);
      } catch (err) {
        failures.push(`cycle ${cycle}: ${(err as Error).message}`);
        console.error(`[memory-stability] Cycle ${cycle} error: ${(err as Error).message}`);
      }

      cycle++;
      if (cycle % 10 === 0) {
        sampler.takeSample();
        const delta = sampler.getDelta();
        const heapDeltaMB = delta.heapUsedDelta / (1024 * 1024);
        console.error(`[memory-stability] Cycle ${cycle}: resident delta=${heapDeltaMB.toFixed(1)}MB`);
      }

      await scaledSleep(5000);
    }

    console.error(`[memory-stability] Completed ${cycle} cycles`);
    expect(cycle).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    sampler.assertStable(50); // < 50MB delta
  }, scaled(1_860_000) + JEST_OVERHEAD_MS); // scaled timeout + fixed overhead buffer
});
