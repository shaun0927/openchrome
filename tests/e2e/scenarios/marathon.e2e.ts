/**
 * E2E-1: Marathon — continuous operation for extended duration.
 * Validates: success rate ≥ 0.99, heap delta < 50MB
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

describe('E2E-1: Marathon', () => {
  let mcp: MCPClient;
  let heapSampler: HeapSampler;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
    heapSampler = new HeapSampler({ pid: mcp.pid });
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('continuous operation maintains ≥99% success rate and stable memory', async () => {
    const port = getFixturePort();
    heapSampler.takeBaseline();

    const sites = [
      `http://localhost:${port}/site-a`,
      `http://localhost:${port}/site-b`,
      `http://localhost:${port}/site-c`,
    ];

    let successes = 0;
    let failures = 0;
    const endTime = Date.now() + scaled(60 * 60 * 1000); // 60 min (or ~10 min CI)
    let cycle = 0;

    while (Date.now() < endTime) {
      for (const site of sites) {
        try {
          const navResult = await mcp.callTool('navigate', { url: site });
          const tidMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
          const tid = tidMatch?.[1] || '';
          const result = await mcp.callTool('read_page', { tabId: tid });
          expect(result.text).toBeDefined();
          expect(result.text.length).toBeGreaterThan(0);
          successes++;
        } catch {
          failures++;
        }
      }

      cycle++;
      if (cycle % 5 === 0) {
        heapSampler.takeSample();
        const trend = heapSampler.getTrend();
        console.error(`[marathon] Cycle ${cycle}: ${successes}/${successes + failures} success, heap trend: ${trend.avgGrowthPerSampleMB.toFixed(2)}MB/sample`);
      }

      await scaledSleep(30_000); // 30s between cycles
    }

    // Verify success rate
    const rate = successes / (successes + failures);
    console.error(`[marathon] Final: ${successes} successes, ${failures} failures, rate: ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeGreaterThanOrEqual(0.99);

    // Verify memory stability
    heapSampler.assertStable(50); // < 50MB delta
  }, scaled(3_660_000) + JEST_OVERHEAD_MS); // scaled timeout + fixed overhead buffer
});
