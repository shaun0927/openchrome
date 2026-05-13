/**
 * E2E: oc_journal handoff_summary for long-running session recovery (#1027)
 *
 * Validates that a real OpenChrome MCP server can produce a compact handoff
 * summary from persisted journal/checkpoint artifacts, and that the summary is
 * still available after an MCP process restart with the same HOME.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPClient, MCPToolResult } from '../harness/mcp-client';

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

function parseJsonText(result: MCPToolResult): Record<string, unknown> {
  return parseFirstJsonObject(result.text);
}

function parseFirstJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`No JSON object in text: ${text}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
    }
  }
  throw new Error(`Unterminated JSON object in text: ${text}`);
}

describe('E2E: journal handoff summary (#1027)', () => {
  let mcp: MCPClient;
  let homeDir: string;

  beforeAll(async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-handoff-e2e-'));
    mcp = new MCPClient({ timeoutMs: 60_000, env: { HOME: homeDir } });
    await mcp.start();
  }, 90_000);

  afterAll(async () => {
    await mcp.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }, 30_000);

  test('summary includes checkpoint state, milestones, grouped failures, and survives restart', async () => {
    const port = getFixturePort();
    const sessionId = 'handoff-e2e-session';
    const testUrl = `http://localhost:${port}/site-a`;

    const nav = await mcp.callTool('navigate', { sessionId, url: testUrl });
    expect(nav.text).toContain('tabId');
    const navData = parseFirstJsonObject(nav.text);
    const tabId = navData.tabId as string;

    await mcp.callTool('read_page', { sessionId, tabId });

    const checkpoint = await mcp.callTool('oc_checkpoint', {
      action: 'save',
      taskDescription: 'Handoff E2E task',
      completedSteps: ['navigate fixture', 'read fixture page'],
      pendingSteps: ['recover missing selector'],
      extractedData: { fixture: 'site-a' },
    });
    expect(checkpoint.text).toContain('saved');

    await mcp.callTool('javascript_tool', {
      sessionId,
      tabId,
      code: 'throw new Error(\"handoff failure\")',
      apiKey: 'should-be-redacted',
    });

    const handoffResult = await mcp.callTool('oc_journal', {
      action: 'handoff_summary',
      sessionId,
      checkpointId: 'current',
    });
    const handoff = parseJsonText(handoffResult);

    expect(handoff.schemaVersion).toBe(1);
    expect((handoff.currentState as Record<string, unknown>).sessionId).toBe(sessionId);
    expect((handoff.currentState as Record<string, unknown>).currentUrl).toContain('/site-a');
    expect((handoff.completedMilestones as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((handoff.pendingSteps as unknown[])).toContain('recover missing selector');
    expect(JSON.stringify(handoff.recentFailures)).toContain('javascript_tool');
    expect(JSON.stringify(handoff.recentFailures)).toContain('[REDACTED]');
    expect(JSON.stringify(handoff.recentFailures)).not.toContain('should-be-redacted');
    expect((handoff.recommendedRecoveryOptions as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(handoff.limits)).toContain('journal entries scanned');

    await mcp.restart();

    const resumedResult = await mcp.callTool('oc_journal', {
      action: 'handoff_summary',
      sessionId,
      checkpointId: 'current',
    });
    const resumed = parseJsonText(resumedResult);

    expect((resumed.currentState as Record<string, unknown>).currentUrl).toContain('/site-a');
    expect((resumed.pendingSteps as unknown[])).toContain('recover missing selector');
    expect(JSON.stringify(resumed.recentFailures)).toContain('javascript_tool');
  }, 120_000);
});
