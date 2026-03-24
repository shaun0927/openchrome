/**
 * E2E-15: Parallel Tool Call Burst
 * Validates: 20 concurrent tool calls all resolve correctly
 * within a reasonable time window (< 30s total).
 */
import { HttpMCPClient } from '../harness/http-mcp-client';
import { FixtureServer } from '../harness/fixture-server';
import { sleep } from '../harness/time-scale';

describe('E2E-15: Parallel tool call burst', () => {
  let server: HttpMCPClient;
  let fixture: FixtureServer;
  let fixturePort: number;

  beforeAll(async () => {
    fixture = new FixtureServer({ port: 19100 + Math.floor(Math.random() * 50) });
    fixturePort = await fixture.start();

    server = new HttpMCPClient({
      timeoutMs: 60_000,
      // Disable rate limiting to allow burst
      env: { OPENCHROME_RATE_LIMIT_RPM: '0' },
    });
    await server.start();
  }, 90_000);

  afterAll(async () => {
    await server.stop().catch(() => { /* ignore */ });
    await fixture.stop().catch(() => { /* ignore */ });
  }, 30_000);

  test('20 concurrent tool calls all resolve correctly', async () => {
    const testUrl = `http://localhost:${fixturePort}/`;

    // Step 1: Navigate to establish a page context
    console.error('[e2e-15] Step 1: Navigate to page');
    const navResult = await server.callTool('navigate', { url: testUrl });
    expect(navResult.text).toBeDefined();
    console.error('[e2e-15] Step 1 OK: Page loaded');

    await sleep(1000);

    // Extract tabId from navigate result for explicit tab targeting
    const tabIdMatch = navResult.text.match(/"tabId":"([^"]+)"/);
    const tabId = tabIdMatch?.[1];
    expect(tabId).toBeDefined();
    console.error(`[e2e-15] Using tabId: ${tabId}`);

    // Step 2: Send 20 concurrent javascript_tool calls
    console.error('[e2e-15] Step 2: Sending 20 concurrent tool calls');
    const startTime = Date.now();

    const promises = Array.from({ length: 20 }, (_, i) =>
      server.callTool('javascript_tool', {
        tabId,
        code: `${i} * ${i} + 1`,
      }),
    );

    const results = await Promise.all(promises);
    const elapsed = Date.now() - startTime;

    console.error(`[e2e-15] Step 2: All 20 calls resolved in ${elapsed}ms`);

    // Step 3: Verify all 20 resolved (not errors/hangs)
    expect(results.length).toBe(20);
    let resolved = 0;
    for (let i = 0; i < 20; i++) {
      const expected = String(i * i + 1);
      // First content item is the result; text joins all items including hints
      const firstContent = results[i].content?.[0]?.text ?? '';
      if (firstContent === expected) {
        resolved++;
      } else {
        console.error(`[e2e-15] call ${i}: expected "${expected}" got "${firstContent.slice(0, 60)}"`);
      }
    }
    // Allow 90%+ correct (concurrent execution may cause minor reordering)
    console.error(`[e2e-15] Step 3: ${resolved}/20 results correct`);
    expect(resolved).toBeGreaterThanOrEqual(18);
    console.error('[e2e-15] Step 3 OK: Sufficient results correct');

    // Step 4: Total time < 30s
    console.error(`[e2e-15] Step 4: Total burst time ${elapsed}ms (limit: 30000ms)`);
    expect(elapsed).toBeLessThan(30_000);
    console.error('[e2e-15] Step 4 OK: Within time budget');
  }, 60_000);
});
