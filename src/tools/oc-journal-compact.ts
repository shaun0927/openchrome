/**
 * oc_journal_compact — compress a window of journal entries into a
 * model-friendly summary (issue #1434, Part 1).
 *
 * Strategies:
 *   - `recent_k` (default, deterministic): concatenate the last K entry
 *     summaries, then truncate to fit `token_budget` using a
 *     deterministic ~4 chars / token heuristic. Always available.
 *   - `checkpoint_only` (deterministic): emit only entries flagged as
 *     milestones (e.g. navigate, fill_form, oc_checkpoint). Always
 *     available.
 *   - `sampling` (host-mediated): build a summarisation prompt over the
 *     window and forward via `sampling/createMessage`. Requires the
 *     client to advertise the `sampling` capability — when absent the
 *     tool returns `{ status: "unsupported_by_host", reason }`. We never
 *     fall back to a server-side LLM (SSOT #1359).
 *
 * Out of scope (Part 2 of #1434):
 *   - Integration test running a real trajectory through compaction and
 *     resuming with the original oc_assert contract.
 *   - Recommended cadence documentation under `docs/skills/`.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolContext, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getTaskJournal, type JournalEntry } from '../journal/task-journal';

type CompactStrategy = 'recent_k' | 'checkpoint_only' | 'sampling';

interface OcJournalCompactInput {
  session_id?: string;
  recent_steps?: number;
  token_budget?: number;
  strategy?: CompactStrategy;
}

interface CompactFact {
  ts: number;
  tool: string;
  ok: boolean;
  summary: string;
  milestone?: boolean;
  failure_class?: string;
}

type OcJournalCompactOutput =
  | {
      status: 'ok';
      summary: string;
      facts: CompactFact[];
      open_assertions: CompactFact[];
      last_checkpoint?: CompactFact;
      tokens_estimated: number;
      strategy_used: CompactStrategy;
    }
  | {
      status: 'unsupported_by_host';
      reason: string;
    }
  | {
      status: 'error';
      reason: string;
    };

const DEFAULT_RECENT_STEPS = 50;
const DEFAULT_TOKEN_BUDGET = 1024;
const CHARS_PER_TOKEN_HEURISTIC = 4;

function estimateTokens(text: string): number {
  // Deterministic char-based heuristic; mirrors `src/mcp/output-observability.ts`.
  return Math.ceil(text.length / CHARS_PER_TOKEN_HEURISTIC);
}

function truncateToBudget(text: string, tokenBudget: number): string {
  const maxChars = Math.max(0, tokenBudget * CHARS_PER_TOKEN_HEURISTIC);
  if (text.length <= maxChars) return text;
  // Drop the head of the buffer so the *latest* events survive.
  return text.slice(text.length - maxChars);
}

function toFact(entry: JournalEntry): CompactFact {
  return {
    ts: entry.ts,
    tool: entry.tool,
    ok: entry.ok,
    summary: entry.summary,
    ...(entry.milestone ? { milestone: true } : {}),
    ...(entry.failureClass ? { failure_class: entry.failureClass } : {}),
  };
}

function joinEntries(entries: JournalEntry[]): string {
  return entries
    .map((e) => `[${new Date(e.ts).toISOString()}] ${e.tool}${e.ok ? '' : ' (FAIL)'} — ${e.summary}`)
    .join('\n');
}

function pickOpenAssertions(entries: JournalEntry[]): CompactFact[] {
  // Heuristic: oc_assert calls that failed or returned an inconclusive
  // verdict are "open" — they have not yet been retired by a later pass.
  // All failed oc_assert entries in the window are surfaced, in order.
  const opens: CompactFact[] = [];
  for (const e of entries) {
    if (e.tool === 'oc_assert' && !e.ok) {
      opens.push(toFact(e));
    }
  }
  return opens;
}

function pickLastCheckpoint(entries: JournalEntry[]): CompactFact | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.tool === 'oc_checkpoint' && e.ok) return toFact(e);
  }
  return undefined;
}

const definition: MCPToolDefinition = {
  name: 'oc_journal_compact',
  description:
    'Compress a sliding window of journal entries into a compact ' +
    'model-friendly summary. Defaults to a deterministic `recent_k` ' +
    'strategy that fits a token budget. `checkpoint_only` returns ' +
    'milestone-flagged entries. `sampling` forwards a summarisation ' +
    'prompt to the host LLM via `sampling/createMessage` — only ' +
    'available when the client advertises the `sampling` capability; ' +
    'returns `{ status: "unsupported_by_host" }` otherwise. ' +
    'OpenChrome never uses its own LLM.',
  annotations: TOOL_ANNOTATIONS.oc_journal_compact,
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description:
          'Optional MCP session id filter. The `recent_steps` window is ' +
          'taken across all sessions first, then filtered by this id — so ' +
          'a busy multi-session journal may yield fewer than `recent_steps` ' +
          'entries for one session; raise `recent_steps` to compensate. ' +
          'When omitted, all recent entries are considered.',
      },
      recent_steps: {
        type: 'number',
        description:
          `How many recent journal entries to consider. Default ${DEFAULT_RECENT_STEPS}.`,
      },
      token_budget: {
        type: 'number',
        description:
          `Approximate token budget for the summary text. Default ${DEFAULT_TOKEN_BUDGET}.`,
      },
      strategy: {
        type: 'string',
        enum: ['recent_k', 'checkpoint_only', 'sampling'],
        description:
          'Compaction strategy. Defaults to `recent_k` (deterministic).',
      },
    },
  },
};

function jsonResult(payload: OcJournalCompactOutput): MCPResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const input = args as OcJournalCompactInput;
  const recentSteps =
    typeof input.recent_steps === 'number' && input.recent_steps > 0
      ? Math.floor(input.recent_steps)
      : DEFAULT_RECENT_STEPS;
  const tokenBudget =
    typeof input.token_budget === 'number' && input.token_budget > 0
      ? Math.floor(input.token_budget)
      : DEFAULT_TOKEN_BUDGET;
  const strategy: CompactStrategy = input.strategy ?? 'recent_k';

  if (!['recent_k', 'checkpoint_only', 'sampling'].includes(strategy)) {
    return jsonResult({ status: 'error', reason: `unknown strategy: ${strategy}` });
  }

  const journal = getTaskJournal();
  let entries = journal.getRecent(recentSteps);
  if (input.session_id) {
    entries = entries.filter((e) => e.sessionId === input.session_id);
  }

  const openAssertions = pickOpenAssertions(entries);
  const lastCheckpoint = pickLastCheckpoint(entries);

  if (strategy === 'checkpoint_only') {
    const milestones = entries.filter((e) => e.milestone === true);
    const summaryText = joinEntries(milestones);
    const tokensEstimated = estimateTokens(summaryText);
    return jsonResult({
      status: 'ok',
      summary: summaryText,
      facts: milestones.map(toFact),
      open_assertions: openAssertions,
      ...(lastCheckpoint ? { last_checkpoint: lastCheckpoint } : {}),
      tokens_estimated: tokensEstimated,
      strategy_used: 'checkpoint_only',
    });
  }

  if (strategy === 'recent_k') {
    const raw = joinEntries(entries);
    const summaryText = truncateToBudget(raw, tokenBudget);
    return jsonResult({
      status: 'ok',
      summary: summaryText,
      facts: entries.map(toFact),
      open_assertions: openAssertions,
      ...(lastCheckpoint ? { last_checkpoint: lastCheckpoint } : {}),
      tokens_estimated: estimateTokens(summaryText),
      strategy_used: 'recent_k',
    });
  }

  // strategy === 'sampling'
  const samplingCap = context?.clientCapabilities?.sampling;
  if (!samplingCap || !context?.requestClient) {
    return jsonResult({
      status: 'unsupported_by_host',
      reason: 'sampling capability not advertised by client',
    });
  }

  const rawWindow = joinEntries(entries);
  const prompt =
    `Summarise the following journal entries faithfully into <= ${tokenBudget} tokens. ` +
    `Preserve failed assertions and the last successful checkpoint. ` +
    `Do not invent facts.\n\n${rawWindow}`;

  type SamplingContentBlock = { type?: string; text?: string };
  type SamplingResponse = {
    content?: SamplingContentBlock | SamplingContentBlock[];
    model?: string;
  };

  try {
    const response = await context.requestClient<SamplingResponse>(
      'sampling/createMessage',
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        ],
        maxTokens: tokenBudget,
      },
      { timeoutMs: 30_000 },
    );
    // MCP `sampling/createMessage` may return `content` as a single block or
    // an array of blocks; handle both and take the first text block.
    const content = response?.content;
    const block = Array.isArray(content)
      ? content.find((c) => typeof c?.text === 'string')
      : content;
    const summaryText = typeof block?.text === 'string' ? block.text : '';
    return jsonResult({
      status: 'ok',
      summary: summaryText,
      facts: entries.map(toFact),
      open_assertions: openAssertions,
      ...(lastCheckpoint ? { last_checkpoint: lastCheckpoint } : {}),
      tokens_estimated: estimateTokens(summaryText),
      strategy_used: 'sampling',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ status: 'error', reason: `sampling request failed: ${message}` });
  }
};

export function registerOcJournalCompactTool(server: MCPServer): void {
  server.registerTool('oc_journal_compact', handler, definition);
}
