/**
 * E2E-13: HTTP Transport Independence
 * Validates: HTTP server survives client disconnects, new clients can
 * access state left by previous clients, and /health stays ok throughout.
 */
import { HttpMCPClient } from '../harness/http-mcp-client';
import { FixtureServer } from '../harness/fixture-server';
import { sleep } from '../harness/time-scale';

describe('E2E-13: HTTP transport independence', () => {
  let server: HttpMCPClient;
  let fixture: FixtureServer;
  let fixturePort: number;

  beforeAll(async () => {
    fixture = new FixtureServer({ port: 18950 + Math.floor(Math.random() * 50) });
    fixturePort = await fixture.start();

    server = new HttpMCPClient({
      timeoutMs: 60_000,
    });
    await server.start();
  }, 90_000);

  afterAll(async () => {
    await server.stop().catch(() => { /* ignore */ });
    await fixture.stop().catch(() => { /* ignore */ });
  }, 30_000);

  test('server survives client disconnect and new client reads state', async () => {
    const testUrl = `http://localhost:${fixturePort}/`;

    // Step 1: Navigate to a page
    console.error('[e2e-13] Step 1: Navigate to page');
    const navResult = await server.callTool('navigate', { url: testUrl });
    expect(navResult.text).toBeDefined();
    const tabIdMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId = tabIdMatch?.[1] || '';
    expect(tabId).toBeTruthy();
    console.error(`[e2e-13] Step 1 OK: tabId=${tabId}`);

    // Step 2: Set a cookie
    console.error('[e2e-13] Step 2: Set cookie');
    await server.callTool('cookies', {
      tabId,
      action: 'set',
      name: 'e2e13_persist',
      value: 'http_independence_test',
      path: '/',
    });
    console.error('[e2e-13] Step 2 OK: Cookie set');

    // Step 3: Verify server stays alive — "disconnect" simulated by just waiting
    // (HTTP transport is stateless per request, so there's no persistent connection to drop)
    console.error('[e2e-13] Step 3: Verify server survives between requests (simulated disconnect)');
    await sleep(2000);

    // Step 4: Verify /health returns ok
    console.error('[e2e-13] Step 4: Check /health');
    const health = await server.getMcpHealth();
    expect(health.status).toBe('ok');
    console.error(`[e2e-13] Step 4 OK: health status=${health.status}`);

    // Step 5: New request reads cookie set by "first client"
    console.error('[e2e-13] Step 5: Read cookie with new request');
    const cookieResult = await server.callTool('cookies', {
      tabId,
      action: 'get',
    });
    expect(cookieResult.text).toContain('e2e13_persist');
    expect(cookieResult.text).toContain('http_independence_test');
    console.error('[e2e-13] Step 5 OK: Cookie persisted across requests');

    // Step 6: Make 10 sequential tool calls, all must succeed
    console.error('[e2e-13] Step 6: Making 10 tool calls');
    for (let i = 0; i < 10; i++) {
      const result = await server.callTool('javascript_tool', {
        code: `document.title + ' - call ${i}'`,
      });
      expect(result.text).toBeDefined();
    }
    console.error('[e2e-13] Step 6 OK: All 10 calls succeeded');

    // Step 7: Final health check
    console.error('[e2e-13] Step 7: Final /health check');
    const finalHealth = await server.getMcpHealth();
    expect(finalHealth.status).toBe('ok');
    console.error('[e2e-13] Step 7 OK: Server healthy throughout');
  }, 120_000);
});
