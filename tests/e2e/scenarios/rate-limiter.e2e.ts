/**
 * E2E-16: Rate Limiter Under Flood
 * Validates: Rate limiter correctly rejects excess requests without
 * hanging or crashing the server. Server recovers after flood.
 */
import { HttpMCPClient } from '../harness/http-mcp-client';
import { FixtureServer } from '../harness/fixture-server';
import { sleep } from '../harness/time-scale';

describe('E2E-16: Rate limiter under flood', () => {
  let server: HttpMCPClient;
  let fixture: FixtureServer;
  let fixturePort: number;

  beforeAll(async () => {
    fixture = new FixtureServer({ port: 19150 + Math.floor(Math.random() * 50) });
    fixturePort = await fixture.start();

    server = new HttpMCPClient({
      timeoutMs: 60_000,
      env: {
        OPENCHROME_RATE_LIMIT_RPM: '10',
        OPENCHROME_EVENT_LOOP_FATAL_MS: '0', // Disable watchdog during flood
      },
    });
    await server.start();
  }, 90_000);

  afterAll(async () => {
    await server.stop().catch(() => { /* ignore */ });
    await fixture.stop().catch(() => { /* ignore */ });
  }, 30_000);

  test('rate limiter rejects excess requests without crashing', async () => {
    const testUrl = `http://localhost:${fixturePort}/`;

    // Step 1: Navigate to establish page context
    console.error('[e2e-16] Step 1: Navigate to page');
    const navResult = await server.callTool('navigate', { url: testUrl });
    expect(navResult.raw?.isError).not.toBe(true);
    const tabIdMatch = navResult.text.match(/"tabId"\s*:\s*"([A-F0-9]{32})"/);
    const tabId = tabIdMatch?.[1] ?? '';
    expect(tabId).toBeTruthy();
    console.error('[e2e-16] Step 1 OK: Page loaded');

    await sleep(500);

    // Step 2: Send 20 sequential requests rapidly
    console.error('[e2e-16] Step 2: Sending 20 rapid sequential requests');
    let successes = 0;
    let rateLimited = 0;
    let errors = 0;

    for (let i = 0; i < 20; i++) {
      try {
        const result = await server.callTool('javascript_tool', {
          tabId,
          code: `"flood-${i}"`,
        });
        // Check if the result indicates rate limiting (isError with rate limit message)
        if (result.raw?.isError && result.text.includes('Rate limit exceeded')) {
          rateLimited++;
        } else {
          successes++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Rate limit') || msg.includes('rate limit')) {
          rateLimited++;
        } else {
          errors++;
          console.error(`[e2e-16] Step 2: Request ${i} unexpected error: ${msg}`);
        }
      }
    }

    console.error(`[e2e-16] Step 2: successes=${successes}, rateLimited=${rateLimited}, errors=${errors}`);

    // Step 3: Expect some succeed, some rejected
    expect(successes).toBeGreaterThan(0);
    expect(rateLimited).toBeGreaterThan(0);
    expect(errors).toBe(0);
    console.error('[e2e-16] Step 3 OK: Mix of successes and rate-limited responses');

    // Step 4: No hangs, no crashes — test reached this point
    console.error('[e2e-16] Step 4 OK: No hangs or crashes during flood');

    // Step 5: Wait for one real token refill (10 RPM = one every 6s), then
    // verify a non-browser diagnostic succeeds without depending on Chrome.
    console.error('[e2e-16] Step 5: Waiting for rate limit recovery, then testing diagnostic call');
    await new Promise((resolve) => setTimeout(resolve, 6500));
    const recoveryResult = await server.callTool('oc_profile_status', {});
    expect(recoveryResult.raw?.isError).not.toBe(true);
    expect(recoveryResult.text).not.toContain('Rate limit exceeded');
    console.error('[e2e-16] Step 5 OK: Rate limiter accepted a post-refill diagnostic');

    // Step 6: Verify server health via HTTP
    console.error('[e2e-16] Step 6: Health check');
    try {
      const health = await server.getMcpHealth();
      expect(health.status).toBeDefined();
      console.error(`[e2e-16] Step 6 OK: Server health=${health.status}`);
    } catch {
      // Health endpoint might not be available (port conflict), check server process is alive
      const pid = server.getPid();
      console.error(`[e2e-16] Step 6: Health endpoint unavailable, server PID=${pid}`);
      expect(pid).not.toBeNull();
    }
  }, 120_000);
});
