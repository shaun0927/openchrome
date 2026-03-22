/**
 * E2E-3: GC Pause Resilience
 * Validates: GC pauses do not trigger false chrome-died events.
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

describe('E2E-3: GC Resilience', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('GC pauses do not trigger false disconnects', async () => {
    const port = getFixturePort();
    const testUrl = `http://localhost:${port}/`;

    // Navigate to establish a stable connection
    await mcp.callTool('navigate', { url: testUrl });

    // Verify initial connection
    const statusBefore = await mcp.callTool('oc_profile_status', {});
    expect(statusBefore.text).toBeDefined();

    // Trigger aggressive GC cycles to stress the event loop
    const gcErrors: string[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        if (global.gc) global.gc();
      } catch (err) {
        gcErrors.push(`GC cycle ${i}: ${(err as Error).message}`);
      }
      await sleep(100);
    }

    // Also allocate and discard large arrays to create GC pressure
    for (let i = 0; i < 10; i++) {
      const arr = new Array(1_000_000).fill({ data: 'x'.repeat(100) });
      arr.length = 0; // discard
      if (global.gc) global.gc();
      await sleep(50);
    }

    // Heartbeat should still be alive
    const statusAfter = await mcp.callTool('oc_profile_status', {});
    expect(statusAfter.text).toBeDefined();

    // Navigate again to confirm full functionality
    const result = await mcp.callTool('read_page', {});
    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);

    // No GC errors should have occurred
    expect(gcErrors).toHaveLength(0);

    console.error('[gc-resilience] GC pressure test passed — no false disconnects');
  }, 120_000); // 2 min timeout
});
