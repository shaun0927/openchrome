/**
 * E2E-8: Context Compaction Recovery
 * Validates: Snapshot survives MCP restart.
 * Depends on #355 (session-snapshot/resume tools).
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

describe('E2E-8: Compaction Resume', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('snapshot survives MCP restart', async () => {
    const port = getFixturePort();
    const testUrl = `http://localhost:${port}/`;
    const testUrl2 = `http://localhost:${port}/site-a`;

    // Step 1: Navigate to pages
    await mcp.callTool('navigate', { url: testUrl });
    await sleep(1000);

    // Create a second tab
    await mcp.callTool('tabs_create', { url: testUrl2 });
    await sleep(1000);

    // Step 2: Take snapshot (params are top-level, not nested under memo)
    const snapshotResult = await mcp.callTool('oc_session_snapshot', {
      objective: 'Test compaction recovery',
      currentStep: 'Step 2 of 3',
      nextActions: ['Step 3: Verify data persistence'],
      completedSteps: ['Step 1: Navigate to pages'],
      notes: 'E2E-8 test scenario',
    });
    expect(snapshotResult.text).toBeDefined();
    console.error(`[compaction-resume] Snapshot taken: ${snapshotResult.text.slice(0, 200)}`);

    // Step 3: Kill and restart MCP server (Chrome stays alive)
    await mcp.restart();
    console.error('[compaction-resume] MCP server restarted');

    // Step 4: Resume from snapshot
    const resumeResult = await mcp.callTool('oc_session_resume', {});
    console.error(`[compaction-resume] Resume result: ${resumeResult.text.slice(0, 300)}`);

    // Verify resume contains correct context
    expect(resumeResult.text).toContain('CONTEXT RESTORED');
    expect(resumeResult.text).toContain('Test compaction recovery');
    expect(resumeResult.text).toContain('Step 2 of 3');
  }, 120_000);
});
