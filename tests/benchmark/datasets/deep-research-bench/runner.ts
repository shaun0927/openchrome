/**
 * DeepResearch Bench — browser-side runner (harness only).
 *
 * The upstream repo runs an LLM end-to-end and scores its report with RACE
 * + FACT. openchrome is a browser MCP server and does not run models; this
 * runner measures only whether the **browser** can surface the pages a
 * strong agent would need — coverage of `expected_sources`, step count,
 * and per-step token / latency accounting.
 *
 * The runner accepts an already-wired `BrowserSession` shim (see the
 * interface below). Concrete openchrome integration lives in
 * `openchrome-real-adapter.ts` in the online-mind2web adapter; this file
 * keeps the same shape so the two can share downstream wiring.
 */

import type { DeepResearchTask } from './loader';

/**
 * The minimal browser surface the runner uses. Any concrete adapter that
 * exposes navigate + observe + click can drive this runner.
 */
export interface BrowserSession {
  /** Navigate the primary tab to `url`. Returns the final URL after redirects. */
  navigate(url: string): Promise<string>;
  /** Return the URLs currently visible as anchor targets on the active page. */
  visibleLinks(): Promise<string[]>;
  /** Click a link by its href (or the first anchor with a matching text). */
  followLink(hrefOrText: string): Promise<void>;
  /** Read the URL of the active tab. */
  currentUrl(): Promise<string>;
  /** Approximate cost of the last observation (kept small; adapter-defined). */
  observationTokens(): number;
}

export interface DeepResearchRunOptions {
  /** Hard cap on tool steps per task. Defaults to `task.reference_steps * 2`. */
  stepBudget?: number;
  /** Hard cap on aggregate observation tokens per task. */
  tokenBudget?: number;
  /**
   * Per-step wall-clock cap in ms. When exceeded the step is marked
   * `timeout` and the runner moves on.
   */
  stepDeadlineMs?: number;
  /**
   * Called after every step so callers can stream progress into their own
   * dashboards. MUST NOT throw.
   */
  onStep?: (step: DeepResearchStep) => void;
}

export interface DeepResearchStep {
  index: number;
  action: 'navigate' | 'follow' | 'observe';
  target?: string;
  resolvedUrl?: string;
  tokens: number;
  elapsedMs: number;
  ok: boolean;
  reason?: string;
}

export interface DeepResearchRunResult {
  taskId: string;
  domain: string;
  language: 'en' | 'zh';
  /** Fraction of `expected_sources` the runner visited. */
  sourceCoverage: number;
  /** URLs from `expected_sources` visited during the run. */
  visited: string[];
  /** URLs from `expected_sources` NOT visited. */
  missed: string[];
  /** True when every expected source was reached inside the budget. */
  complete: boolean;
  steps: DeepResearchStep[];
  totalTokens: number;
  totalElapsedMs: number;
  stopReason: 'complete' | 'step_budget' | 'token_budget' | 'error';
}

/**
 * Run one DeepResearch task against a browser session. Coverage-oriented:
 * for each expected source, navigate directly, record whether the page
 * loaded, and count it as covered when `resolvedUrl` matches at the
 * registrable-domain level.
 *
 * A future variant can drive the browser via natural-language reasoning;
 * this baseline keeps the harness deterministic so CI can run it without
 * a model.
 */
export async function runDeepResearchTask(
  task: DeepResearchTask,
  session: BrowserSession,
  options: DeepResearchRunOptions = {},
): Promise<DeepResearchRunResult> {
  const stepBudget = options.stepBudget ?? Math.max(2, task.reference_steps * 2);
  const tokenBudget = options.tokenBudget ?? 100_000;
  const stepDeadline = options.stepDeadlineMs ?? 30_000;

  const steps: DeepResearchStep[] = [];
  const visited = new Set<string>();
  let totalTokens = 0;
  const startedAt = Date.now();
  let stopReason: DeepResearchRunResult['stopReason'] = 'complete';

  for (const source of task.expected_sources) {
    if (steps.length >= stepBudget) {
      stopReason = 'step_budget';
      break;
    }
    if (totalTokens >= tokenBudget) {
      stopReason = 'token_budget';
      break;
    }

    const stepStart = Date.now();
    const step: DeepResearchStep = {
      index: steps.length,
      action: 'navigate',
      target: source,
      tokens: 0,
      elapsedMs: 0,
      ok: false,
    };
    try {
      const resolved = await withDeadline(session.navigate(source), stepDeadline);
      step.resolvedUrl = resolved;
      step.tokens = session.observationTokens();
      step.ok = true;
      totalTokens += step.tokens;
      if (matchesRegistrableDomain(source, resolved)) visited.add(source);
    } catch (err) {
      step.ok = false;
      step.reason = err instanceof Error ? err.message : String(err);
      if (step.reason === 'timeout') {
        // proceed; a timed-out navigate is a step-budget signal on its own
      }
    }
    step.elapsedMs = Date.now() - stepStart;
    steps.push(step);
    options.onStep?.(step);
  }

  const missed = task.expected_sources.filter((s) => !visited.has(s));

  return {
    taskId: task.task_id,
    domain: task.domain,
    language: task.language,
    sourceCoverage:
      task.expected_sources.length === 0
        ? 1
        : visited.size / task.expected_sources.length,
    visited: Array.from(visited),
    missed,
    complete: missed.length === 0,
    steps,
    totalTokens,
    totalElapsedMs: Date.now() - startedAt,
    stopReason: missed.length === 0 ? 'complete' : stopReason,
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Cheap registrable-domain matcher — matches when the URL hosts share
 * their last two labels (or last three for two-label ccTLDs). Used only
 * for coverage bookkeeping.
 */
export function matchesRegistrableDomain(a: string, b: string): boolean {
  try {
    const hostA = new URL(a).hostname.toLowerCase();
    const hostB = new URL(b).hostname.toLowerCase();
    return registrable(hostA) === registrable(hostB);
  } catch {
    return false;
  }
}

function registrable(host: string): string {
  const parts = host.replace(/^\./, '').split('.');
  const twoLabelCcTld = new Set([
    'co.uk', 'com.br', 'co.kr', 'co.jp', 'com.au',
    'com.mx', 'co.in', 'co.nz', 'co.za', 'com.sg',
    'com.hk', 'com.tw', 'ne.jp', 'or.jp', 'ac.jp',
  ]);
  if (parts.length >= 3 && twoLabelCcTld.has(parts.slice(-2).join('.'))) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * Aggregate results from a batch of DeepResearch tasks into a single
 * report. Shape mirrors the other benchmark adapters' result envelopes so
 * dashboards can reuse the same renderer.
 */
export interface DeepResearchAggregate {
  generatedAt: string;
  total: number;
  complete: number;
  meanCoverage: number;
  byDomain: Record<string, { total: number; complete: number; meanCoverage: number }>;
  results: DeepResearchRunResult[];
}

export function aggregateDeepResearch(results: DeepResearchRunResult[]): DeepResearchAggregate {
  const byDomain: Record<string, { total: number; complete: number; coverageSum: number }> = {};
  let complete = 0;
  let coverageSum = 0;
  for (const r of results) {
    coverageSum += r.sourceCoverage;
    if (r.complete) complete++;
    const bucket = (byDomain[r.domain] ??= { total: 0, complete: 0, coverageSum: 0 });
    bucket.total++;
    if (r.complete) bucket.complete++;
    bucket.coverageSum += r.sourceCoverage;
  }
  const byDomainOut: DeepResearchAggregate['byDomain'] = {};
  for (const [k, v] of Object.entries(byDomain)) {
    byDomainOut[k] = {
      total: v.total,
      complete: v.complete,
      meanCoverage: v.total === 0 ? 0 : v.coverageSum / v.total,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    total: results.length,
    complete,
    meanCoverage: results.length === 0 ? 0 : coverageSum / results.length,
    byDomain: byDomainOut,
    results,
  };
}
