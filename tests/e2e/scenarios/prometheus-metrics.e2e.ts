/**
 * E2E-17: Prometheus Metrics Accuracy
 * Validates: Prometheus /metrics endpoint returns correct counters/gauges
 * in valid text exposition format after a series of tool calls.
 */
import { HttpMCPClient } from '../harness/http-mcp-client';
import { FixtureServer } from '../harness/fixture-server';
import { sleep } from '../harness/time-scale';

describe('E2E-17: Prometheus metrics accuracy', () => {
  let server: HttpMCPClient;
  let fixture: FixtureServer;
  let fixturePort: number;

  beforeAll(async () => {
    fixture = new FixtureServer({ port: 19200 + Math.floor(Math.random() * 50) });
    fixturePort = await fixture.start();

    server = new HttpMCPClient({
      timeoutMs: 60_000,
      env: { OPENCHROME_RATE_LIMIT_RPM: '0' }, // Disable rate limiting for metrics test
    });
    await server.start();
  }, 90_000);

  afterAll(async () => {
    await server.stop().catch(() => { /* ignore */ });
    await fixture.stop().catch(() => { /* ignore */ });
  }, 30_000);

  test('metrics reflect tool call counts and system gauges', async () => {
    const testUrl = `http://localhost:${fixturePort}/`;

    // Step 1: Make 5 navigate calls
    console.error('[e2e-17] Step 1: Making 5 navigate calls');
    for (let i = 0; i < 5; i++) {
      const url = i === 0 ? testUrl : `http://localhost:${fixturePort}/site-${String.fromCharCode(97 + (i % 3))}`;
      await server.callTool('navigate', { url });
    }
    console.error('[e2e-17] Step 1 OK: 5 navigate calls completed');

    // Step 2: Make 5 javascript_tool calls
    console.error('[e2e-17] Step 2: Making 5 javascript_tool calls');
    for (let i = 0; i < 5; i++) {
      await server.callTool('javascript_tool', { code: `"metric-test-${i}"` });
    }
    console.error('[e2e-17] Step 2 OK: 5 javascript_tool calls completed');

    await sleep(1000);

    // Step 3: Fetch /metrics
    console.error('[e2e-17] Step 3: Fetching /metrics');
    const metricsText = await server.getMetrics();
    expect(metricsText).toBeDefined();
    expect(metricsText.length).toBeGreaterThan(0);
    console.error(`[e2e-17] Step 3 OK: Metrics text length=${metricsText.length}`);

    const lines = metricsText.split('\n');

    // Step 4: Verify openchrome_tool_calls_total exists and has correct count
    console.error('[e2e-17] Step 4: Checking openchrome_tool_calls_total');
    const toolCallLines = lines.filter((l) => l.startsWith('openchrome_tool_calls_total'));
    expect(toolCallLines.length).toBeGreaterThan(0);

    // Sum all tool call counter values
    let totalCalls = 0;
    for (const line of toolCallLines) {
      const match = line.match(/\s(\d+(\.\d+)?)$/);
      if (match) totalCalls += parseFloat(match[1]);
    }
    // We made at least 10 tool calls (5 navigate + 5 javascript_tool), plus the initial navigate
    // and any internal calls. Should be >= 10.
    console.error(`[e2e-17] Step 4: Total tool calls in metrics: ${totalCalls}`);
    expect(totalCalls).toBeGreaterThanOrEqual(10);
    console.error('[e2e-17] Step 4 OK: openchrome_tool_calls_total correct');

    // Step 5: Verify openchrome_heap_bytes > 0
    console.error('[e2e-17] Step 5: Checking openchrome_heap_bytes');
    const heapLine = lines.find((l) => l.startsWith('openchrome_heap_bytes') && !l.startsWith('#'));
    expect(heapLine).toBeDefined();
    const heapMatch = heapLine?.match(/\s(\d+(\.\d+)?)$/);
    expect(heapMatch).toBeTruthy();
    const heapValue = parseFloat(heapMatch![1]);
    expect(heapValue).toBeGreaterThan(0);
    console.error(`[e2e-17] Step 5 OK: heap_bytes=${heapValue}`);

    // Step 6: Verify openchrome_active_sessions gauge exists
    console.error('[e2e-17] Step 6: Checking openchrome_active_sessions');
    const sessionLines = lines.filter((l) =>
      l.includes('openchrome_active_sessions') && !l.startsWith('#'),
    );
    expect(sessionLines.length).toBeGreaterThan(0);
    console.error('[e2e-17] Step 6 OK: openchrome_active_sessions gauge found');

    // Step 7: Verify openchrome_tabs_health gauge exists
    console.error('[e2e-17] Step 7: Checking openchrome_tabs_health');
    const tabsLines = lines.filter((l) =>
      l.includes('openchrome_tabs_health') && !l.startsWith('#'),
    );
    expect(tabsLines.length).toBeGreaterThan(0);
    console.error('[e2e-17] Step 7 OK: openchrome_tabs_health gauge found');

    // Step 8: Verify Prometheus text format validity
    console.error('[e2e-17] Step 8: Validating Prometheus text format');
    const typeLines = lines.filter((l) => l.startsWith('# TYPE'));
    const helpLines = lines.filter((l) => l.startsWith('# HELP'));
    expect(typeLines.length).toBeGreaterThan(0);
    expect(helpLines.length).toBeGreaterThan(0);

    // Every TYPE line should match format: # TYPE <name> <type>
    for (const tl of typeLines) {
      expect(tl).toMatch(/^# TYPE \S+ (counter|gauge|histogram|summary|untyped)$/);
    }

    // Every HELP line should match format: # HELP <name> <description>
    for (const hl of helpLines) {
      expect(hl).toMatch(/^# HELP \S+ .+$/);
    }

    // Metric lines should match: <name>[{labels}] <value>
    const metricLines = lines.filter((l) => l.trim() && !l.startsWith('#'));
    for (const ml of metricLines) {
      // Allow metric_name{labels} value or metric_name value
      expect(ml).toMatch(/^\S+(\{[^}]*\})?\s+-?\d+(\.\d+)?([eE][+-]?\d+)?$/);
    }

    console.error(`[e2e-17] Step 8 OK: ${typeLines.length} TYPE, ${helpLines.length} HELP, ${metricLines.length} metric lines — all valid`);
  }, 120_000);
});
