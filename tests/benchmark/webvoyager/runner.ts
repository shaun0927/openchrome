/**
 * WebVoyager contract-eval benchmark runner.
 *
 * Orchestrates: load task specs → invoke adapter (mock or claude) → evaluate
 * contracts via `src/contracts/evaluate.ts` → write JSON + Markdown report
 * → exit non-zero on any failure (or replay drift) so CI gates correctly.
 *
 * Run via:
 *   npm run bench:webvoyager:mock   # default, deterministic
 *   npm run bench:webvoyager:real   # requires provider API key + OPENCHROME_BENCH_REAL=1
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
import { applyBenchmarkLiveSecretInputs, redactLiveSecretArgs } from '../utils/live-secret-input';
import { buildProviderRunMetadata, preflightProviderRun, providerForAdapter } from './llm/provider';
import {
  WEBVOYAGER_LIBRARIES,
  WebVoyagerLibrary,
  LIBRARY_ROUTING,
  projectCost,
  formatProjection,
} from './llm/library-routing';
import {
  EXECUTION_MODES,
  ExecutionMode,
} from './llm/execution-mode';
import type {
  Baseline,
  BenchReport,
  TaskRunReport,
  WebVoyagerTask,
} from './types';

const TASKS_DIR = path.join(__dirname, 'tasks');
const REPORTS_DIR = path.join(__dirname, 'reports');
const BASELINE_PATH = path.join(__dirname, 'baseline.json');

type AdapterName = 'mock' | 'claude' | 'openai';

interface CliOptions {
  adapter: AdapterName;
  taskFilter?: string;
  /**
   * Library matrix selection (#1257). Today only openchrome's native loop is
   * wired; selecting playwright-mcp or browser-use surfaces a clear skip
   * notice when --dry-run is omitted. The flag exists today so PR-12 can
   * land the routing + dry-run gate without touching the adapter dispatch.
   */
  library: WebVoyagerLibrary;
  /**
   * Execution mode (#1257). `native` is the headline comparison; `passive`
   * wraps every library as a passive tool surface — surfaces drift between
   * the two but for browser-use is a SECONDARY data point (it strips the
   * library's planning loop).
   */
  mode: ExecutionMode;
  /**
   * --dry-run: print the cost projection and exit 0 WITHOUT making any LLM
   * API call. The runner refuses to run real tasks in this mode regardless
   * of OPENCHROME_BENCH_REAL.
   */
  dryRun: boolean;
  /** Repetitions per task; issue #1257 mandates N >= 10 for native-mode runs. */
  repetitions: number;
  /** Print live provider/runtime readiness and exit before any API call. */
  preflight: boolean;
  model?: string;
  temperature: number;
}

function isLibrary(v: string): v is WebVoyagerLibrary {
  return (WEBVOYAGER_LIBRARIES as readonly string[]).includes(v);
}

function isMode(v: string): v is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(v);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    adapter: 'mock',
    library: 'openchrome',
    mode: 'native',
    dryRun: false,
    repetitions: 1,
    preflight: false,
    temperature: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--adapter') {
      const v = argv[++i];
      if (v !== 'mock' && v !== 'claude' && v !== 'openai') {
        throw new Error(`unknown adapter: ${v}`);
      }
      opts.adapter = v;
    } else if (a === '--task') {
      opts.taskFilter = argv[++i];
    } else if (a === '--library') {
      const v = argv[++i];
      if (!isLibrary(v)) {
        throw new Error(`unknown --library: ${v}. Choose one of ${WEBVOYAGER_LIBRARIES.join(', ')}`);
      }
      opts.library = v;
    } else if (a === '--repetitions' || a === '--reps') {
      const n = parseInt(argv[++i], 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--repetitions must be a positive integer; got ${argv[i]}`);
      }
      opts.repetitions = n;
    } else if (a.startsWith('--repetitions=') || a.startsWith('--reps=')) {
      const raw = a.includes('--repetitions=') ? a.slice('--repetitions='.length) : a.slice('--reps='.length);
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--repetitions must be a positive integer; got ${raw}`);
      }
      opts.repetitions = n;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--preflight') {
      opts.preflight = true;
    } else if (a === '--model') {
      opts.model = argv[++i];
    } else if (a === '--temperature') {
      opts.temperature = Number(argv[++i]);
    } else if (a === '--mode') {
      const v = argv[++i];
      if (!isMode(v)) {
        throw new Error(`unknown --mode: ${v}. Choose one of ${EXECUTION_MODES.join(', ')}`);
      }
      opts.mode = v;
    } else if (a.startsWith('--mode=')) {
      const v = a.slice('--mode='.length);
      if (!isMode(v)) {
        throw new Error(`unknown --mode: ${v}. Choose one of ${EXECUTION_MODES.join(', ')}`);
      }
      opts.mode = v;
    } else if (a.startsWith('--adapter=')) {
      const v = a.slice('--adapter='.length);
      if (v !== 'mock' && v !== 'claude' && v !== 'openai') {
        throw new Error(`unknown adapter: ${v}`);
      }
      opts.adapter = v;
    } else if (a.startsWith('--task=')) {
      opts.taskFilter = a.slice('--task='.length);
    } else if (a.startsWith('--model=')) {
      opts.model = a.slice('--model='.length);
    } else if (a.startsWith('--temperature=')) {
      opts.temperature = Number(a.slice('--temperature='.length));
    } else if (a.startsWith('--library=')) {
      const v = a.slice('--library='.length);
      if (!isLibrary(v)) {
        throw new Error(`unknown --library: ${v}. Choose one of ${WEBVOYAGER_LIBRARIES.join(', ')}`);
      }
      opts.library = v;
    }
  }
  // env override (e.g. OPENCHROME_BENCH_ADAPTER=claude)
  const envAdapter = process.env.OPENCHROME_BENCH_ADAPTER;
  if (envAdapter === 'mock' || envAdapter === 'claude' || envAdapter === 'openai') {
    opts.adapter = envAdapter;
  }
  if (!Number.isFinite(opts.temperature) || opts.temperature < 0) throw new Error('--temperature must be a non-negative number');
  return opts;
}

export { parseArgs as parseRunnerArgs };

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
  repetition: number,
): Promise<TaskRunReport> {
  const started = Date.now();

  if (task.pending) {
    return {
      name: task.name,
      repetition,
      result: 'pending',
      duration_ms: 0,
      tool_calls: 0,
      response_bytes: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      usd: null,
    };
  }

  try {
    if (adapter === 'mock') {
      const run = await withTimeout(runMockTask(task.name), task.timeout_ms, task.name);
      if (run.drift) {
        return {
          name: task.name,
          repetition,
          result: 'replay_drift',
          duration_ms: Date.now() - started,
          tool_calls: run.tool_calls,
          response_bytes: run.response_bytes,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          usd: null,
          error: run.drift,
        };
      }
      const check = await evaluateContract(task.contract.postconditions, run.context);
      return {
        name: task.name,
        repetition,
        result: check.passed ? 'passed' : 'failed',
        duration_ms: Date.now() - started,
        tool_calls: run.tool_calls,
        response_bytes: run.response_bytes,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        usd: null,
        failed_postcondition: check.passed ? undefined : check.failedDescription,
      };
    }

    const run = adapter === 'claude'
      ? await withTimeout((await import('./llm/claude-adapter')).runClaudeTask(task, WEBVOYAGER_BUDGET), task.timeout_ms, task.name)
      : await withTimeout((await import('./llm/openai-adapter')).runOpenAiTask(task, WEBVOYAGER_BUDGET), task.timeout_ms, task.name);
    const check = await evaluateContract(task.contract.postconditions, run.context);
    return {
      name: task.name,
      repetition,
      result: check.passed ? 'passed' : 'failed',
      duration_ms: Date.now() - started,
      tool_calls: run.tool_calls,
      response_bytes: run.response_bytes,
      input_tokens: run.input_tokens ?? null,
      output_tokens: run.output_tokens ?? null,
      total_tokens: run.total_tokens ?? null,
      usd: run.usd_spent,
      budget_abort: run.aborted,
      failed_postcondition: check.passed ? undefined : check.failedDescription,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: task.name,
      repetition,
      result: 'error',
      duration_ms: Date.now() - started,
      tool_calls: 0,
      response_bytes: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      usd: null,
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
  const secretInputs = applyBenchmarkLiveSecretInputs(argv.slice(2));
  if (secretInputs.applied.length > 0) {
    console.error(`[webvoyager] applied benchmark-only API key input: ${secretInputs.applied.map((s) => `${s.provider}:${s.source}->${s.envName}`).join(', ')}`);
    console.error(`[webvoyager] argv: ${redactLiveSecretArgs(argv.slice(2)).join(' ')}`);
  }
  const opts = parseArgs(argv);
  const allTasks = await loadTasks();
  const tasks = opts.taskFilter ? allTasks.filter((t) => t.name === opts.taskFilter) : allTasks;
  if (tasks.length === 0) {
    console.error('[webvoyager] no tasks selected');
    return 1;
  }
  const providerMetadata = opts.adapter === 'mock'
    ? null
    : buildProviderRunMetadata({
      provider: providerForAdapter(opts.adapter),
      model: opts.model,
      temperature: opts.temperature,
      budget: WEBVOYAGER_BUDGET,
    });

  if (opts.preflight) {
    if (!providerMetadata) {
      console.error('[webvoyager] preflight: mock adapter selected; no live provider/API call required.');
      return 0;
    }
    const preflight = preflightProviderRun(providerMetadata);
    console.error(
      `[webvoyager] preflight provider=${preflight.provider} model=${preflight.model} ` +
        `ok=${preflight.ok ? 'yes' : 'no'}` +
        (preflight.missing.length > 0 ? ` missing=${preflight.missing.join(',')}` : ''),
    );
    return preflight.ok ? 0 : 1;
  }

  // Dry-run gate (#1257): print the worst-case cost projection and exit 0
  // WITHOUT making any LLM API call. The gate runs before adapter dispatch
  // so even `--adapter claude` with OPENCHROME_BENCH_REAL=1 is honored as
  // dry-run when --dry-run is set.
  if (opts.dryRun) {
    const projection = projectCost({
      taskCount: tasks.length,
      libraries: [opts.library],
      repetitions: opts.repetitions,
    });
    console.error(formatProjection(projection));
    console.error(
      `\n[webvoyager] library=${opts.library} mode=${opts.mode} ` +
        `wired=${LIBRARY_ROUTING[opts.library].nativeLoopWired} ` +
        `adapter-requested=${opts.adapter} (no run performed; --dry-run is set)`,
    );
    if (opts.mode === 'passive') {
      console.error(
        `[webvoyager] note: --mode passive is the SECONDARY data point per #1257. ` +
          `Headline numbers come from --mode native; for browser-use, passive strips ` +
          `the library's planning loop and is reported separately, never as the headline.`,
      );
    }
    return 0;
  }

  // Live library gate (#1257): the runner today only wires OpenChrome's
  // native loop. Selecting an unwired library without --dry-run is a config
  // error — refuse to silently fall back to OpenChrome and surface the
  // routing's note so the operator knows what needs to land.
  const routing = LIBRARY_ROUTING[opts.library];
  if (!routing.nativeLoopWired) {
    console.error(
      `[webvoyager] GATE FAILED: library "${opts.library}" native loop is not yet wired. ` +
        `Use --dry-run for the cost projection, or run with --library openchrome. ` +
        `Note: ${routing.note}`,
    );
    return 1;
  }

  const baseline = await loadBaseline();

  const taskReports: TaskRunReport[] = [];
  for (const t of tasks) {
    for (let repetition = 1; repetition <= opts.repetitions; repetition++) {
      const r = await runTask(t, opts.adapter, repetition);
      taskReports.push(r);
      console.error(
        `[webvoyager] ${r.name}#${r.repetition}: ${r.result}` +
          (r.failed_postcondition ? ` — ${r.failed_postcondition}` : '') +
          (r.error ? ` — ${r.error}` : ''),
      );
    }
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
    mode: opts.mode,
    library: opts.library,
    repetitions: opts.repetitions,
    provider: providerMetadata?.provider ?? 'none',
    model: providerMetadata?.model ?? 'none',
    temperature: providerMetadata?.temperature ?? 0,
    max_tokens: WEBVOYAGER_BUDGET.max_tokens,
    max_tool_iterations: WEBVOYAGER_BUDGET.max_tool_iterations,
    max_usd_per_task: WEBVOYAGER_BUDGET.max_usd_per_task,
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
  // Pending tasks (no transcript yet) are explicitly excluded from the gate
  // — this prevents 0/10 from looking "green" but lets us bootstrap the
  // suite honestly. The report renderer's "(or are pending and excluded
  // from the gate)" copy assumes this exclusion holds; the previous filter
  // counted pending as failure, contradicting that copy.
  const requiredFailures = taskReports.filter(
    (r) => required.has(r.name) && r.result !== 'passed' && r.result !== 'pending',
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
