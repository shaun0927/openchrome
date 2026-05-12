/**
 * WebVoyager contract-eval benchmark runner.
 *
 * Orchestrates: load task specs → invoke adapter (mock or claude) → evaluate
 * contracts via `src/contracts/evaluate.ts` → write JSON + Markdown report
 * → exit non-zero on any failure (or replay drift) so CI gates correctly.
 *
 * Run via:
 *   npm run bench:webvoyager:mock   # default, deterministic
 *   npm run bench:webvoyager:real   # requires ANTHROPIC_API_KEY + OPENCHROME_BENCH_REAL=1
 */

import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

import { evaluate } from '../../../src/contracts/evaluate';
import type { Assertion } from '../../../src/contracts/types';
import type { EvalContext } from '../../../src/contracts/eval-context';

import { runMockTask } from './llm/mock-adapter';
import { renderMarkdown } from './report';
import { WEBVOYAGER_BUDGET } from './llm/budget';
import type {
  Baseline,
  BenchReport,
  TaskRunReport,
  WebVoyagerTask,
} from './types';

const TASKS_DIR = path.join(__dirname, 'tasks');
const REPORTS_DIR = path.join(__dirname, 'reports');
const BASELINE_PATH = path.join(__dirname, 'baseline.json');

type AdapterName = 'mock' | 'claude';

interface CliOptions {
  adapter: AdapterName;
  taskFilter?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { adapter: 'mock' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--adapter') {
      const v = argv[++i];
      if (v !== 'mock' && v !== 'claude') {
        throw new Error(`unknown adapter: ${v}`);
      }
      opts.adapter = v;
    } else if (a === '--task') {
      opts.taskFilter = argv[++i];
    } else if (a.startsWith('--adapter=')) {
      const v = a.slice('--adapter='.length);
      if (v !== 'mock' && v !== 'claude') {
        throw new Error(`unknown adapter: ${v}`);
      }
      opts.adapter = v;
    } else if (a.startsWith('--task=')) {
      opts.taskFilter = a.slice('--task='.length);
    }
  }
  // env override (e.g. OPENCHROME_BENCH_ADAPTER=claude)
  const envAdapter = process.env.OPENCHROME_BENCH_ADAPTER;
  if (envAdapter === 'mock' || envAdapter === 'claude') {
    opts.adapter = envAdapter;
  }
  return opts;
}

async function loadTasks(): Promise<WebVoyagerTask[]> {
  const entries = await fs.readdir(TASKS_DIR);
  const taskFiles = entries
    .filter((e) => e.endsWith('.ts') && !e.startsWith('_') && e !== 'README.md')
    .sort();
  const tasks: WebVoyagerTask[] = [];
  for (const f of taskFiles) {
    const mod = await import(path.join(TASKS_DIR, f));
    const t = (mod.default ?? mod.task) as WebVoyagerTask | undefined;
    if (!t || typeof t.name !== 'string') {
      console.error(`[webvoyager] skipping ${f}: no default export of WebVoyagerTask shape`);
      continue;
    }
    tasks.push(t);
  }
  return tasks;
}

async function loadBaseline(): Promise<Baseline> {
  const raw = await fs.readFile(BASELINE_PATH, 'utf8');
  return JSON.parse(raw) as Baseline;
}

/**
 * Read the current git SHA via `git rev-parse --short HEAD` and validate
 * the output. The SHA is interpolated into report file paths
 * (`reports/<sha>.json`), so a malicious worktree state or hostile env
 * could in principle produce a string that escapes the reports directory.
 * We pin the result to the canonical short/long SHA shape and fall back
 * to the literal `'unknown'` otherwise.
 *
 * Exported for unit-testing of both the happy and validation-failure paths.
 */
export function gitSha(
  exec: (cmd: string, opts: { encoding: 'utf8' }) => string = execSync as unknown as (
    cmd: string,
    opts: { encoding: 'utf8' },
  ) => string,
): string {
  let raw: string;
  try {
    raw = exec('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
  if (!/^[0-9a-f]{7,40}$/.test(raw)) {
    console.error(
      `[webvoyager] unexpected git rev-parse output ${JSON.stringify(raw)}; ` +
        `falling back to 'unknown'`,
    );
    return 'unknown';
  }
  return raw;
}

async function evaluateContract(
  contract: Assertion,
  ctx: EvalContext,
): Promise<{ passed: boolean; failedDescription?: string }> {
  const result = await evaluate(contract, ctx);
  if (result.passed) return { passed: true };
  return {
    passed: false,
    failedDescription: describeFailure(result.evidence),
  };
}

function describeFailure(evidence: { assertion_kind: string; details: Record<string, unknown> }): string {
  const kind = evidence.assertion_kind;
  const d = evidence.details;
  // Build a compact human-readable failure line; the full JSON lives in
  // the per-run report alongside this string.
  if (kind === 'url') return `url did not match ${JSON.stringify(d.pattern)} (got ${JSON.stringify(d.url)})`;
  if (kind === 'dom_text') return `dom_text[${d.selector}] did not contain ${JSON.stringify(d.contains)}`;
  if (kind === 'dom_count')
    return `dom_count[${d.selector}] failed (count=${d.count}, op=${d.op}, expected=${d.value})`;
  if (kind === 'network') return `network match failed for ${JSON.stringify(d.url_pattern)}`;
  if (kind === 'no_dialog') return `unexpected open dialog`;
  if (kind === 'screenshot_class') return `screenshot_class ${JSON.stringify(d.class_id)} mismatch`;
  if (kind === 'and' || kind === 'or' || kind === 'not') {
    return `logical(${kind}) failed: ${JSON.stringify(d)}`;
  }
  return `${kind} failed: ${JSON.stringify(d)}`;
}

async function runTask(
  task: WebVoyagerTask,
  adapter: AdapterName,
): Promise<TaskRunReport> {
  const started = Date.now();

  if (task.pending) {
    return {
      name: task.name,
      result: 'pending',
      duration_ms: 0,
      tool_calls: 0,
      response_bytes: 0,
    };
  }

  try {
    if (adapter === 'mock') {
      const run = await withTimeout(runMockTask(task.name), task.timeout_ms, task.name);
      if (run.drift) {
        return {
          name: task.name,
          result: 'replay_drift',
          duration_ms: Date.now() - started,
          tool_calls: run.tool_calls,
          response_bytes: run.response_bytes,
          error: run.drift,
        };
      }
      const check = await evaluateContract(task.contract.postconditions, run.context);
      return {
        name: task.name,
        result: check.passed ? 'passed' : 'failed',
        duration_ms: Date.now() - started,
        tool_calls: run.tool_calls,
        response_bytes: run.response_bytes,
        failed_postcondition: check.passed ? undefined : check.failedDescription,
      };
    }

    // claude adapter
    const { runClaudeTask } = await import('./llm/claude-adapter');
    const run = await withTimeout(
      runClaudeTask(task, WEBVOYAGER_BUDGET),
      task.timeout_ms,
      task.name,
    );
    const check = await evaluateContract(task.contract.postconditions, run.context);
    return {
      name: task.name,
      result: check.passed ? 'passed' : 'failed',
      duration_ms: Date.now() - started,
      tool_calls: run.tool_calls,
      response_bytes: run.response_bytes,
      failed_postcondition: check.passed ? undefined : check.failedDescription,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: task.name,
      result: 'error',
      duration_ms: Date.now() - started,
      tool_calls: 0,
      response_bytes: 0,
      error: message,
    };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`task ${label} exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const opts = parseArgs(argv);
  const allTasks = await loadTasks();
  const tasks = opts.taskFilter ? allTasks.filter((t) => t.name === opts.taskFilter) : allTasks;
  if (tasks.length === 0) {
    console.error('[webvoyager] no tasks selected');
    return 1;
  }

  const baseline = await loadBaseline();

  const taskReports: TaskRunReport[] = [];
  for (const t of tasks) {
    const r = await runTask(t, opts.adapter);
    taskReports.push(r);
    console.error(
      `[webvoyager] ${r.name}: ${r.result}` +
        (r.failed_postcondition ? ` — ${r.failed_postcondition}` : '') +
        (r.error ? ` — ${r.error}` : ''),
    );
  }

  const passCount = taskReports.filter((r) => r.result === 'passed').length;
  const failCount = taskReports.filter(
    (r) => r.result === 'failed' || r.result === 'replay_drift' || r.result === 'error',
  ).length;
  const pendingCount = taskReports.filter((r) => r.result === 'pending').length;

  const sha = gitSha();
  const required = new Set(baseline.transcripts_required);
  const requiredCount = required.size;
  const totalCount = taskReports.length;
  // Format the score so readers cannot mistake "3/3 = 100%" for full
  // suite coverage when 7 of 10 tasks are still pending transcript
  // recording. Includes passed / required / total / pending in the same
  // string so the JSON and the runner stdout speak the same language.
  const scoreLine =
    `${passCount} passed / ${requiredCount} required / ${totalCount} total ` +
    `(${pendingCount} pending)`;
  const benchReport: BenchReport = {
    git_sha: sha,
    adapter: opts.adapter,
    total_tasks: totalCount,
    pass_count: passCount,
    fail_count: failCount,
    pending_count: pendingCount,
    contract_eval_score: scoreLine,
    timestamp: new Date().toISOString(),
    tasks: taskReports,
  };

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const jsonPath = path.join(REPORTS_DIR, `${sha}.json`);
  const mdPath = path.join(REPORTS_DIR, `${sha}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(benchReport, null, 2) + '\n', 'utf8');
  await fs.writeFile(mdPath, renderMarkdown(benchReport), 'utf8');
  // Also write a stable "latest" pointer; the sha-named files are the canonical record.
  await fs.writeFile(path.join(REPORTS_DIR, 'latest.json'), JSON.stringify(benchReport, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(REPORTS_DIR, 'latest.md'), renderMarkdown(benchReport), 'utf8');

  // Gate against baseline: every task in `transcripts_required` MUST pass.
  // Pending tasks (no transcript yet) are allowed; this prevents 0/10 from
  // looking "green" but lets us bootstrap the suite honestly.
  const requiredFailures = taskReports.filter(
    (r) => required.has(r.name) && r.result !== 'passed',
  );
  if (requiredFailures.length > 0) {
    console.error(
      `[webvoyager] GATE FAILED: ${requiredFailures.length} required task(s) did not pass: ` +
        requiredFailures.map((r) => `${r.name}=${r.result}`).join(', '),
    );
    return 1;
  }

  // Honesty check: if every task is pending, score is meaningless; refuse to pass.
  if (pendingCount === taskReports.length) {
    console.error('[webvoyager] GATE FAILED: every task is pending; record at least one transcript');
    return 1;
  }

  console.error(
    `[webvoyager] OK: ${passCount} passed, ${failCount} failed, ${pendingCount} pending ` +
      `(score=${benchReport.contract_eval_score})`,
  );
  return 0;
}

// Run when invoked directly (ts-node tests/benchmark/webvoyager/runner.ts).
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('[webvoyager] fatal:', err);
      process.exit(2);
    },
  );
}
