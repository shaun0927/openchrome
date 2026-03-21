/**
 * Journal Query Tool — query recorded MCP tool call history.
 * Part of #356: Task Journal.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getTaskJournal } from '../journal/task-journal';

const definition: MCPToolDefinition = {
  name: 'oc_journal',
  description:
    'Query the tool call journal. Actions: ' +
    '"summary" (milestone-based overview for context restoration), ' +
    '"recent" (last N entries with full detail).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['summary', 'recent'],
        description: 'Query type',
      },
      count: {
        type: 'number',
        description: '(recent) Number of entries to return. Default: 20, max: 100',
      },
      tool: {
        type: 'string',
        description: 'Filter by tool name',
      },
      since: {
        type: 'string',
        description: 'ISO timestamp or relative ("1h", "30m")',
      },
    },
    required: ['action'],
  },
};

export function parseSince(since?: string): number | undefined {
  if (!since) return undefined;

  // Relative time
  const relMatch = since.match(/^(\d+)(m|h|d)$/);
  if (relMatch) {
    const value = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const multipliers: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
    return Date.now() - (value * (multipliers[unit] || 60000));
  }

  // ISO timestamp
  const ts = new Date(since).getTime();
  return isNaN(ts) ? undefined : ts;
}

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const action = args.action as string;
  const journal = getTaskJournal();
  const since = parseSince(args.since as string | undefined);

  if (action === 'summary') {
    const summary = journal.getSummary({ since });

    const lines: string[] = [];
    const periodStart = new Date(summary.period.start).toLocaleTimeString();
    const periodEnd = new Date(summary.period.end).toLocaleTimeString();
    const durationMin = Math.round((summary.period.end - summary.period.start) / 60000);

    lines.push(`\u2550\u2550\u2550 SESSION JOURNAL SUMMARY \u2550\u2550\u2550`);
    lines.push(`Period: ${periodStart} \u2192 ${periodEnd} (${durationMin}m)`);
    lines.push(`Total calls: ${summary.total} (${summary.succeeded} success, ${summary.failed} failed)`);

    if (summary.milestones.length > 0) {
      lines.push('');
      lines.push('Milestones:');
      for (const m of summary.milestones) {
        const time = new Date(m.ts).toLocaleTimeString();
        lines.push(`  ${time} ${m.summary}`);
      }
    }

    if (Object.keys(summary.toolCounts).length > 0) {
      lines.push('');
      const sorted = Object.entries(summary.toolCounts).sort((a, b) => b[1] - a[1]);
      lines.push(`Tools: ${sorted.map(([t, c]) => `${t}(${c})`).join(', ')}`);
    }

    if (summary.total > 0) {
      const failRate = ((summary.failed / summary.total) * 100).toFixed(1);
      lines.push(`Failure rate: ${failRate}%`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (action === 'recent') {
    const count = Math.min(Math.max((args.count as number) || 20, 1), 100);
    let entries = journal.getRecent(count);

    // Apply filters
    if (args.tool) {
      entries = entries.filter(e => e.tool === args.tool);
    }
    if (since) {
      entries = entries.filter(e => e.ts >= since);
    }

    if (entries.length === 0) {
      return { content: [{ type: 'text', text: 'No journal entries found.' }] };
    }

    const lines = entries.map(e => {
      const time = new Date(e.ts).toLocaleTimeString();
      const dur = `${e.durationMs}ms`;
      const milestone = e.milestone ? ' \u2605' : '';
      return `${time} [${dur}] ${e.summary}${milestone}`;
    });

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  return { content: [{ type: 'text', text: `Unknown action: ${action}. Use "summary" or "recent".` }] };
};

export function registerJournalTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
