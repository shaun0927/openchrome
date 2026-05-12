/// <reference types="jest" />

/**
 * Off-switch parity test for oc_performance_insights / oc_performance_analyze (#846).
 *
 * When OPENCHROME_PERF_INSIGHTS=0, the two tools must NOT be
 * registered. This guards the v1.10.4 tools/list parity invariant from
 * the portability-harness contract (P2 — Zero-impact harness extension).
 *
 * The test isolates the registration call by using a stub MCPServer
 * that records only the tool names it was asked to register; we never
 * touch the real Chrome process or the SessionManager event bus.
 */

class StubServer {
  registered: string[] = [];
  registerTool(name: string): void {
    this.registered.push(name);
  }
  // Stubs to satisfy the registerAllTools imports — none of them are
  // actually called in this test because we drive `registerTool` only.
  // The real MCPServer also implements `getToolNames`; we keep that
  // stubbed so the trailing `console.error(...)` line in tools/index.ts
  // doesn't blow up.
  getToolNames(): string[] {
    return this.registered;
  }
}

describe('oc_performance_insights tool registration', () => {
  // The two registration helpers each call `server.registerTool(name, ...)`
  // so we can assert the off-switch behaviour by spying directly on the
  // exported `registerOcPerformanceInsightsTool` / `registerOcPerformanceAnalyzeTool`
  // functions instead of bringing in the full `registerAllTools` pipeline
  // (which pulls in real puppeteer, the chrome pool, and other heavy deps).

  test('registerOcPerformanceInsightsTool registers the tool by name', async () => {
    const { registerOcPerformanceInsightsTool } = await import(
      '../../src/tools/oc-performance-insights'
    );
    const server = new StubServer();
    registerOcPerformanceInsightsTool(server as unknown as Parameters<typeof registerOcPerformanceInsightsTool>[0]);
    expect(server.registered).toEqual(['oc_performance_insights']);
  });

  test('registerOcPerformanceAnalyzeTool registers the tool by name', async () => {
    const { registerOcPerformanceAnalyzeTool } = await import(
      '../../src/tools/oc-performance-analyze'
    );
    const server = new StubServer();
    registerOcPerformanceAnalyzeTool(server as unknown as Parameters<typeof registerOcPerformanceAnalyzeTool>[0]);
    expect(server.registered).toEqual(['oc_performance_analyze']);
  });

  test('off-switch contract: tools/index.ts gates on OPENCHROME_PERF_INSIGHTS !== "0"', async () => {
    // Verify the literal env-check the index file uses. We do this by
    // reading the source rather than booting the full registration
    // pipeline — that pipeline depends on a working Chrome.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(__dirname, '..', '..', 'src', 'tools', 'index.ts');
    const src = fs.readFileSync(indexPath, 'utf8');
    expect(src).toMatch(/OPENCHROME_PERF_INSIGHTS\s*!==\s*'0'/);
    expect(src).toMatch(/registerOcPerformanceInsightsTool\(server\)/);
    expect(src).toMatch(/registerOcPerformanceAnalyzeTool\(server\)/);
    // TODO(#844) marker is preserved at the gate.
    expect(src).toMatch(/TODO\(#844\)/);
  });
});
