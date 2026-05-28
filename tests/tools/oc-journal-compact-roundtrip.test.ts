/**
 * Round-trip integration test for #1434 Part 2.
 *
 * Compaction is lossy-but-stable: the summary text may shrink, but the
 * set of open assertions (failed oc_assert calls) and the last
 * successful checkpoint must not change unless the underlying journal
 * does. This test pins that contract by running two consecutive
 * compactions over the same synthetic trajectory and confirming the
 * structural fields converge.
 */
import { MCPServer } from '../../src/mcp-server';
import { registerOcJournalCompactTool } from '../../src/tools/oc-journal-compact';
import type { ToolContext } from '../../src/types/mcp';
import * as journalMod from '../../src/journal/task-journal';
import type { JournalEntry } from '../../src/journal/task-journal';

function getRegisteredTool(server: MCPServer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (server as any).tools as Map<string, { handler: Function }> | undefined;
  if (!reg) throw new Error('MCPServer has no tools map exposed');
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

function entry(overrides: Partial<JournalEntry>): JournalEntry {
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

describe('oc_journal_compact — round-trip stability (#1434 Part 2)', () => {
  let server: MCPServer;
  let spy: jest.SpyInstance | undefined;

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

  function compact(args: Record<string, unknown>, ctx?: Partial<ToolContext>) {
    const tool = getRegisteredTool(server, 'oc_journal_compact');
    const fullCtx: ToolContext = {
      startTime: Date.now(),
      deadlineMs: 60_000,
      ...(ctx ?? {}),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (tool.handler as any)('test-session', args, fullCtx);
  }

  it('open_assertions and last_checkpoint converge across two compaction passes', async () => {
    const trajectory: JournalEntry[] = [];
    for (let i = 0; i < 12; i++) {
      trajectory.push(entry({ ts: i, tool: 'read_page', summary: `read ${i}` }));
    }
    trajectory.push(
      entry({ ts: 12, tool: 'oc_checkpoint', ok: true, milestone: true, summary: 'cp-A' }),
    );
    trajectory.push(entry({ ts: 13, tool: 'oc_assert', ok: false, summary: 'assert-1 failed' }));
    for (let i = 14; i < 24; i++) {
      trajectory.push(entry({ ts: i, tool: 'navigate', summary: `nav ${i}` }));
    }
    trajectory.push(
      entry({ ts: 24, tool: 'oc_checkpoint', ok: true, milestone: true, summary: 'cp-B' }),
    );
    trajectory.push(entry({ ts: 25, tool: 'oc_assert', ok: false, summary: 'assert-2 failed' }));
    for (let i = 26; i < 30; i++) {
      trajectory.push(entry({ ts: i, tool: 'read_page', summary: `read ${i}` }));
    }

    withJournal(trajectory);

    const a = parseResult(await compact({ strategy: 'recent_k', token_budget: 1024 }));
    const b = parseResult(await compact({ strategy: 'recent_k', token_budget: 1024 }));

    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    // Same trajectory → same compaction. Bookkeeping must be stable.
    expect(b.open_assertions).toEqual(a.open_assertions);
    expect(b.last_checkpoint).toEqual(a.last_checkpoint);
    expect(b.facts.length).toBe(a.facts.length);
    // The summary itself must be byte-identical for the same window
    // and the same deterministic strategy.
    expect(b.summary).toBe(a.summary);

    // Domain-specific assertions: the two failed asserts are surfaced.
    expect(a.open_assertions.length).toBe(2);
    // Last checkpoint is the more recent one.
    expect(a.last_checkpoint.summary).toBe('cp-B');
  });

  it('checkpoint_only strategy preserves checkpoints across repeats', async () => {
    const trajectory: JournalEntry[] = [
      entry({ ts: 1, tool: 'navigate', milestone: true, summary: 'go A' }),
      entry({ ts: 2, tool: 'oc_assert', ok: false, summary: 'a-x failed' }),
      entry({
        ts: 3,
        tool: 'oc_checkpoint',
        ok: true,
        milestone: true,
        summary: 'checkpoint A',
      }),
      entry({ ts: 4, tool: 'navigate', milestone: true, summary: 'go B' }),
    ];
    withJournal(trajectory);

    const a = parseResult(await compact({ strategy: 'checkpoint_only' }));
    const b = parseResult(await compact({ strategy: 'checkpoint_only' }));
    expect(a.facts.length).toBe(b.facts.length);
    expect(a.last_checkpoint).toEqual(b.last_checkpoint);
    expect(a.open_assertions.length).toBe(1);
  });

  it('sampling strategy is inconclusive (never server-side) when the host lacks the capability (#1359)', async () => {
    // A context with no clientCapabilities.sampling and no requestClient
    // is the unknown-MCP-client baseline. The tool must refuse to
    // summarise rather than call a model itself.
    withJournal([entry({ ts: 1, tool: 'read_page', summary: 'read 1' })]);

    const res = parseResult(await compact({ strategy: 'sampling' }));

    expect(res.status).toBe('unsupported_by_host');
    expect(typeof res.reason).toBe('string');
    // No summary is fabricated on the deterministic fallback path.
    expect(res.summary).toBeUndefined();
  });
});
