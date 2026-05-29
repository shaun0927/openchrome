/**
 * Online-Mind2Web live-run CLI (#1427 Part 2).
 *
 * Mirrors the WebVoyager runner CLI shape:
 *   - parse `--adapter mock|claude`, `--model`, `--limit`, `--step-budget`
 *   - load the dataset (`fixture` default; `hf` when OPENCHROME_OM2W_FETCH=1)
 *   - mock: deterministic fake client + fake adapter (NO network, NO API key)
 *   - claude: assertAnthropicLiveEnabled, then real Anthropic SDK client +
 *     OpenChromeRealAdapter
 *   - run each task via runOnlineMind2WebTask, aggregate pass-rate, and write
 *     a JSON + Markdown report under ./results.
 *
 * Run via:
 *   npm run bench:om2w:mock   # default, deterministic, CI-safe
 *   npm run bench:om2w        # requires ANTHROPIC_API_KEY + OPENCHROME_BENCH_REAL=1
 *
 * Logging goes to stderr (console.error) — stdout is reserved for MCP JSON-RPC.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { MCPAdapter, MCPToolResult } from '../../benchmark-runner';
import type { AnthropicMessagesClient } from '../../llm-provider/anthropic-loop';
import { assertAnthropicLiveEnabled } from '../../llm-provider/anthropic-loop';
import { loadOnlineMind2Web, type OnlineMind2WebTask } from './loader';
import { runOnlineMind2WebTask, type RunnerDeps, type RunnerResult } from './runner';
import { createLiveOnlineMind2WebDeps, DEFAULT_OM2W_MODEL } from './live-deps';

const RESULTS_DIR = path.join(__dirname, 'results');

type AdapterName = 'mock' | 'claude';

interface CliOptions {
  adapter: AdapterName;
  model: string;
  limit?: number;
  stepBudget?: number;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { adapter: 'mock', model: DEFAULT_OM2W_MODEL };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--adapter') {
      opts.adapter = requireAdapter(argv[++i]);
    } else if (a.startsWith('--adapter=')) {
      opts.adapter = requireAdapter(a.slice('--adapter='.length));
    } else if (a === '--model') {
      opts.model = argv[++i];
    } else if (a.startsWith('--model=')) {
      opts.model = a.slice('--model='.length);
    } else if (a === '--limit') {
      opts.limit = requirePositiveInt(argv[++i], '--limit');
    } else if (a.startsWith('--limit=')) {
      opts.limit = requirePositiveInt(a.slice('--limit='.length), '--limit');
    } else if (a === '--step-budget') {
      opts.stepBudget = requirePositiveInt(argv[++i], '--step-budget');
    } else if (a.startsWith('--step-budget=')) {
      opts.stepBudget = requirePositiveInt(a.slice('--step-budget='.length), '--step-budget');
    }
  }

  const envAdapter = process.env.OPENCHROME_BENCH_ADAPTER;
  if (envAdapter === 'mock' || envAdapter === 'claude') {
    opts.adapter = envAdapter;
  }
  return opts;
}

function requireAdapter(v: string | undefined): AdapterName {
  if (v !== 'mock' && v !== 'claude') {
    throw new Error(`unknown --adapter: ${v}. Choose one of mock, claude`);
  }
  return v;
}

function requirePositiveInt(raw: string | undefined, flag: string): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer; got ${raw}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Deterministic mock client + adapter (NO network, NO API key, NO browser).
// ---------------------------------------------------------------------------

/**
 * A deterministic fake Anthropic client. For the step loop it returns a
 * single navigate tool call on the first message, then a terminal text turn.
 * For the judge call (a `system` mentioning "evaluator") it returns a strict
 * JSON verdict that always passes. State is keyed off the system prompt so
 * step and judge calls are distinguishable without network access.
 */
export function createMockAnthropicClient(): AnthropicMessagesClient {
  const stepCallCounts = new Map<string, number>();
  return {
    create: async (input: Record<string, unknown>) => {
      const system = typeof input.system === 'string' ? input.system : '';
      const isJudge = system.includes('evaluator');
      if (isJudge) {
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [
            {
              type: 'text',
              text: JSON.stringify({ passed: true, reason: 'mock judge: deterministic pass' }),
            },
          ],
        };
      }

      // Step loop: emit one tool call, then finish on the follow-up turn.
      const key = JSON.stringify(input.messages ?? []);
      const seen = stepCallCounts.get(key) ?? 0;
      stepCallCounts.set(key, seen + 1);
      const hasToolResult = Array.isArray(input.messages)
        && (input.messages as Array<{ content?: unknown }>).some(
          (m) => Array.isArray(m.content)
            && (m.content as Array<{ type?: string }>).some((c) => c.type === 'tool_result'),
        );
      if (hasToolResult) {
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 5 },
          content: [{ type: 'text', text: 'OM2W_COMPLETE: navigated to target page.' }],
        };
      }
      return {
        stop_reason: 'tool_use',
        usage: { input_tokens: 8, output_tokens: 8 },
        content: [
          { type: 'text', text: 'Navigating to the target site.' },
          {
            type: 'tool_use',
            id: `mock-tool-${seen}`,
            name: 'navigate',
            input: { url: 'https://example.com' },
          },
        ],
      };
    },
  };
}

/** A deterministic fake MCP adapter that succeeds on every tool call. */
export function createMockAdapter(): MCPAdapter {
  return {
    name: 'mock-om2w',
    mode: 'dom',
    kind: 'mcp',
    async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
      return {
        content: [{ type: 'text', text: `mock ${toolName} ok ${JSON.stringify(args)}` }],
        isError: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Report shapes.
// ---------------------------------------------------------------------------

interface TaskReport {
  task_id: string;
  passed: boolean;
  steps_used: number;
  reason: string;
  judge_id?: string;
}

interface Om2wReport {
  adapter: AdapterName;
  model: string;
  source: 'fixture' | 'hf';
  total_tasks: number;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
  step_budget: number | null;
  timestamp: string;
  tasks: TaskReport[];
}

function toTaskReport(r: RunnerResult): TaskReport {
  return {
    task_id: r.task_id,
    passed: r.passed,
    steps_used: r.steps_used,
    reason: r.reason,
    ...(r.judge_id ? { judge_id: r.judge_id } : {}),
  };
}

function renderMarkdown(report: Om2wReport): string {
  const lines: string[] = [];
  lines.push('# Online-Mind2Web live-run report');
  lines.push('');
  lines.push(`- adapter: \`${report.adapter}\``);
  lines.push(`- model: \`${report.model}\``);
  lines.push(`- source: \`${report.source}\``);
  lines.push(`- step_budget: \`${report.step_budget ?? 'default'}\``);
  lines.push(`- timestamp: ${report.timestamp}`);
  lines.push('');
  lines.push(`**pass-rate: ${report.pass_count}/${report.total_tasks} (${(report.pass_rate * 100).toFixed(1)}%)**`);
  lines.push('');
  lines.push('| task_id | passed | steps | reason |');
  lines.push('| --- | --- | --- | --- |');
  for (const t of report.tasks) {
    const reason = t.reason.replace(/\|/g, '\\|').slice(0, 120);
    lines.push(`| ${t.task_id} | ${t.passed ? 'yes' : 'no'} | ${t.steps_used} | ${reason} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the runner deps plus the underlying adapter. The adapter is returned
 * alongside the deps so the caller can drive its setup()/teardown() lifecycle
 * once around the whole run — the live OpenChromeRealAdapter only spawns its
 * MCP subprocess in setup() and would otherwise throw on the first tool call.
 */
function buildDeps(opts: CliOptions): { deps: RunnerDeps; adapter: MCPAdapter } {
  if (opts.adapter === 'mock') {
    const adapter = createMockAdapter();
    const deps = createLiveOnlineMind2WebDeps({
      client: createMockAnthropicClient(),
      adapter,
      model: opts.model,
      maxTurnsPerStep: 4,
      now: () => 0,
    });
    return { deps, adapter };
  }

  // Live Claude path — gated, requires API key + OPENCHROME_BENCH_REAL=1.
  assertAnthropicLiveEnabled();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default ?? sdk;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const client: AnthropicMessagesClient = {
    create: (input) => anthropic.messages.create(input),
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OpenChromeRealAdapter } = require('../../adapters');
  const adapter: MCPAdapter = new OpenChromeRealAdapter({
    mode: 'dom',
    cdpEndpoint: process.env.OPENCHROME_BENCH_CDP_ENDPOINT,
  });
  const deps = createLiveOnlineMind2WebDeps({ client, adapter, model: opts.model });
  return { deps, adapter };
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const opts = parseArgs(argv);
  const source: 'fixture' | 'hf' = process.env.OPENCHROME_OM2W_FETCH === '1' ? 'hf' : 'fixture';

  let tasks: OnlineMind2WebTask[];
  try {
    tasks = await loadOnlineMind2Web({ source });
  } catch (err) {
    console.error(`[om2w] failed to load dataset (source=${source}): ${(err as Error).message}`);
    return 1;
  }
  if (typeof opts.limit === 'number') {
    tasks = tasks.slice(0, opts.limit);
  }
  if (tasks.length === 0) {
    console.error('[om2w] no tasks selected');
    return 1;
  }

  console.error(`[om2w] adapter=${opts.adapter} model=${opts.model} source=${source} tasks=${tasks.length}`);

  let deps: RunnerDeps;
  let adapter: MCPAdapter;
  try {
    ({ deps, adapter } = buildDeps(opts));
  } catch (err) {
    console.error(`[om2w] failed to build deps: ${(err as Error).message}`);
    return 1;
  }

  // The adapter owns a real MCP subprocess on the live path; set it up once
  // before the run and tear it down afterwards even if a task throws. The mock
  // adapter has no setup/teardown, so this is a no-op there.
  try {
    await adapter.setup?.();
  } catch (err) {
    console.error(`[om2w] adapter setup failed: ${(err as Error).message}`);
    return 1;
  }

  const runnerOptions = typeof opts.stepBudget === 'number' ? { step_budget: opts.stepBudget } : {};
  const taskReports: TaskReport[] = [];
  try {
    for (const task of tasks) {
      try {
        const result = await runOnlineMind2WebTask(task, deps, runnerOptions);
        taskReports.push(toTaskReport(result));
        console.error(
          `[om2w] ${result.task_id}: ${result.passed ? 'passed' : 'failed'} ` +
            `(${result.steps_used} steps) — ${result.reason}`,
        );
      } catch (err) {
        taskReports.push({
          task_id: task.task_id,
          passed: false,
          steps_used: 0,
          reason: `runner error: ${(err as Error).message}`,
        });
        console.error(`[om2w] ${task.task_id}: error — ${(err as Error).message}`);
      }
    }
  } finally {
    try {
      await adapter.teardown?.();
    } catch (err) {
      console.error(`[om2w] adapter teardown failed: ${(err as Error).message}`);
    }
  }

  const passCount = taskReports.filter((t) => t.passed).length;
  const failCount = taskReports.length - passCount;
  const report: Om2wReport = {
    adapter: opts.adapter,
    model: opts.model,
    source,
    total_tasks: taskReports.length,
    pass_count: passCount,
    fail_count: failCount,
    pass_rate: taskReports.length > 0 ? passCount / taskReports.length : 0,
    step_budget: opts.stepBudget ?? null,
    timestamp: new Date().toISOString(),
    tasks: taskReports,
  };

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, `${opts.adapter}-latest.json`);
  const mdPath = path.join(RESULTS_DIR, `${opts.adapter}-latest.md`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await fs.writeFile(mdPath, renderMarkdown(report), 'utf8');

  console.error(
    `[om2w] OK: ${passCount} passed / ${failCount} failed / ${taskReports.length} total ` +
      `(pass-rate=${(report.pass_rate * 100).toFixed(1)}%) -> ${jsonPath}`,
  );
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('[om2w] fatal:', err);
      process.exit(2);
    },
  );
}
