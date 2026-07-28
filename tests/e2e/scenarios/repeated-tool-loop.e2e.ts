/**
 * E2E: repeated identical tool-call loop hints.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPClient, MCPToolResult } from '../harness/mcp-client';

const CHROME_PORT = 20_000 + (process.pid % 500);
const USER_DATA_DIR = path.join(os.tmpdir(), `openchrome-repeated-loop-${process.pid}`);

function getFixturePort(): number {
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return state.port;
}

function extractTabId(result: MCPToolResult): string {
  for (const item of result.content) {
    if (!item.text) continue;
    try {
      const parsed = JSON.parse(item.text) as { tabId?: string };
      if (parsed.tabId) return parsed.tabId;
    } catch {
      // Some environments prepend browser fallback warnings before the JSON;
      // fall through to the regex extraction below.
    }
  }
  const match = result.text.match(/"tabId"\s*:\s*"([^"]+)"/);
  return match?.[1] || '';
}

describe('E2E: repeated identical tool-call loop hints', () => {
  let mcp: MCPClient;

  beforeAll(async () => {
    mcp = new MCPClient({
      timeoutMs: 60_000,
      args: ['--port', String(CHROME_PORT), '--user-data-dir', USER_DATA_DIR],
    });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  }, 30_000);

  test('warns, escalates, resets, and stays session-scoped', async () => {
    const port = getFixturePort();
    const url = `http://localhost:${port}/site-a`;

    const nav = await mcp.callTool('navigate', { sessionId: 'loop-a', url });
    const tabId = extractTabId(nav);
    expect(tabId).toBeTruthy();

    // navigate is exempt from the broader same-tool-success rule, so identical
    // effective args exercise the exact repeated-call detector end to end.
    const args = { sessionId: 'loop-a', tabId, url };
    await mcp.callTool('navigate', args);
    await mcp.callTool('navigate', args);
    const third = await mcp.callTool('navigate', args);
    expect(third.text).toContain('Repeated identical tool call detected');
    expect(third.raw._hintMeta).toMatchObject({ severity: 'warning', rule: 'repeated-identical-tool-call' });

    await mcp.callTool('navigate', args);
    const fifth = await mcp.callTool('navigate', args);
    expect(fifth.text).toContain('Repeated identical tool call detected');
    expect(fifth.raw._hintMeta).toMatchObject({ severity: 'critical', rule: 'repeated-identical-tool-call' });

    await mcp.callTool('navigate', { sessionId: 'loop-a', tabId, url: `http://localhost:${port}/site-b` });
    const afterReset = await mcp.callTool('navigate', args);
    expect((afterReset.raw._hintMeta as { rule?: string } | undefined)?.rule).not.toBe('repeated-identical-tool-call');

    const navB = await mcp.callTool('navigate', { sessionId: 'loop-b', url });
    const tabIdB = extractTabId(navB);
    const otherSession = await mcp.callTool('navigate', { sessionId: 'loop-b', tabId: tabIdB, url });
    expect((otherSession.raw._hintMeta as { rule?: string } | undefined)?.rule).not.toBe('repeated-identical-tool-call');
  }, 120_000);
});
