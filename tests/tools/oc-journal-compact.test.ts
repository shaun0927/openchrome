/**
 * Tests for oc_journal_compact (#1434 Part 1).
 */
import { MCPServer } from '../../src/mcp-server';
import { registerOcJournalCompactTool } from '../../src/tools/oc-journal-compact';
import type { ToolContext } from '../../src/types/mcp';
import * as journalMod from '../../src/journal/task-journal';
import type { JournalEntry } from '../../src/journal/task-journal';

function getRegisteredTool(server: MCPServer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (server as any).tools as Map<string, { handler: Function }> | undefined;
  if (!reg) throw new Error('MCPServer has no `tools` map exposed for test introspection');
  const entry = reg.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry;
}

function parseResult(res: { content: Array<{ type: string; text?: string }> }) {
  const block = res.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected text result block');
  }
  return JSON.parse(block.text);
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: 1_700_000_000_000,
    tool: 'read_page',
    sessionId: 'sess-1',
    args: {},
    durationMs: 12,
    ok: true,
    summary: 'read page ok',
    ...overrides,
  };
}

describe('oc_journal_compact MCP tool (#1434)', () => {
  let server: MCPServer;
  let spy: jest.SpyInstance;

  beforeAll(() => {
    server = new MCPServer();
    registerOcJournalCompactTool(server);
  });

  afterEach(() => {
    if (spy) spy.mockRestore();
  });

  function withJournal(entries: JournalEntry[]) {
    spy = jest.spyOn(journalMod, 'getTaskJournal').mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getRecent: (_n?: number) => entries,
    } as unknown as journalMod.TaskJournal);
  }

  function call(args: Record<string, unknown>, ctx?: Partial<ToolContext>) {
    const tool = getRegisteredTool(server, 'oc_journal_compact');
    const fullCtx: ToolContext = {
      startTime: Date.now(),
      deadlineMs: 60_000,
      ...(ctx ?? {}),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (tool.handler as any)('test-session', args, fullCtx);
  }

  it('recent_k strategy returns a deterministic concatenation of summaries', async () => {
    withJournal([
      entry({ ts: 1, tool: 'navigate', summary: 'to /a' }),
      entry({ ts: 2, tool: 'read_page', summary: 'read /a' }),
      entry({ ts: 3, tool: 'navigate', summary: 'to /b' }),
    ]);
    const res = await call({ strategy: 'recent_k', token_budget: 1024 });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('ok');
    expect(parsed.strategy_used).toBe('recent_k');
    expect(parsed.summary).toMatch(/navigate.*to \/a/);
    expect(parsed.summary).toMatch(/navigate.*to \/b/);
    expect(parsed.facts).toHaveLength(3);
    expect(parsed.tokens_estimated).toBeGreaterThan(0);
  });

  it('recent_k truncation drops the head when budget is tight', async () => {
    const big = Array.from({ length: 30 }, (_, i) =>
      entry({ ts: i, summary: 'x'.repeat(80) + ` index=${i}` }),
    );
    withJournal(big);
    const res = await call({ strategy: 'recent_k', token_budget: 50 });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('ok');
    expect(parsed.summary.length).toBeLessThanOrEqual(50 * 4);
    // Most recent entry survives.
    expect(parsed.summary).toMatch(/index=29/);
  });

  it('checkpoint_only returns only milestone entries', async () => {
    withJournal([
      entry({ tool: 'read_page' }),
      entry({ tool: 'navigate', milestone: true, summary: 'milestone nav' }),
      entry({ tool: 'oc_checkpoint', milestone: true, ok: true, summary: 'checkpoint' }),
      entry({ tool: 'read_page' }),
    ]);
    const res = await call({ strategy: 'checkpoint_only' });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('ok');
    expect(parsed.strategy_used).toBe('checkpoint_only');
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts.every((f: { milestone?: boolean }) => f.milestone === true)).toBe(true);
    expect(parsed.last_checkpoint?.tool).toBe('oc_checkpoint');
  });

  it('surfaces failed oc_assert calls as open assertions', async () => {
    withJournal([
      entry({ tool: 'oc_assert', ok: false, summary: 'a1 failed' }),
      entry({ tool: 'oc_assert', ok: true, summary: 'a2 passed' }),
      entry({ tool: 'oc_assert', ok: false, summary: 'a3 failed' }),
    ]);
    const res = await call({});
    const parsed = parseResult(res);
    expect(parsed.status).toBe('ok');
    expect(parsed.open_assertions).toHaveLength(2);
    expect(parsed.open_assertions.map((a: { summary: string }) => a.summary)).toEqual([
      'a1 failed',
      'a3 failed',
    ]);
  });

  it('sampling strategy without client capability returns unsupported_by_host', async () => {
    withJournal([entry()]);
    const res = await call({ strategy: 'sampling' });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('unsupported_by_host');
  });

  it('sampling strategy forwards to the host LLM when capability is present', async () => {
    withJournal([entry({ summary: 'nav' })]);
    const calls: Array<{ method: string }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRequestClient = async (method: string): Promise<any> => {
      calls.push({ method });
      return { content: { type: 'text', text: 'compact summary from host' } };
    };
    const res = await call(
      { strategy: 'sampling' },
      { clientCapabilities: { sampling: {} }, requestClient: fakeRequestClient },
    );
    const parsed = parseResult(res);
    expect(parsed.status).toBe('ok');
    expect(parsed.strategy_used).toBe('sampling');
    expect(parsed.summary).toBe('compact summary from host');
    expect(calls).toEqual([{ method: 'sampling/createMessage' }]);
  });

  it('rejects an unknown strategy with a structured error', async () => {
    withJournal([entry()]);
    const res = await call({ strategy: 'invalid' });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('error');
    expect(parsed.reason).toMatch(/unknown strategy/);
  });

  it('respects the session_id filter', async () => {
    withJournal([
      entry({ sessionId: 'sess-A', summary: 'A1' }),
      entry({ sessionId: 'sess-B', summary: 'B1' }),
      entry({ sessionId: 'sess-A', summary: 'A2' }),
    ]);
    const res = await call({ session_id: 'sess-A' });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('ok');
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts.every((f: { summary: string }) => /^A/.test(f.summary))).toBe(true);
  });
});
