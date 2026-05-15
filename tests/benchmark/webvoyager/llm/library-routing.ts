/**
 * Library matrix routing + dry-run cost projection for the Agent Task Success
 * axis (#1257).
 *
 * The WebVoyager runner today drives OpenChrome through a Claude tool-calling
 * loop. Issue #1257 expands that to a three-library matrix — OpenChrome,
 * playwright-mcp, browser-use (native agent loop via the Python bridge from
 * #1280). Each library runs against the same task corpus + same LLM model,
 * so the only variable is the tool surface (or, for browser-use, the native
 * agent's planning loop). This module is the small uniform abstraction over
 * the three.
 *
 * The real per-library loops swap in next session. Today the module ships
 * the routing identity and the cost projection so PR-12 can land
 * infrastructure-only — no API calls, no surprise budget hits.
 */

import { WEBVOYAGER_BUDGET } from './budget';

/**
 * The three libraries Issue #1257 requires for the headline native-mode
 * comparison. A passive-tool mode (Claude + each library's tool surface) is
 * a separate axis that lands in PR-13.
 */
export type WebVoyagerLibrary = 'openchrome' | 'playwright-mcp' | 'browser-use';

export const WEBVOYAGER_LIBRARIES: readonly WebVoyagerLibrary[] = [
  'openchrome',
  'playwright-mcp',
  'browser-use',
];

export interface LibraryRouting {
  library: WebVoyagerLibrary;
  /**
   * Per-library identity label used in the result envelope's `competitors`
   * pin block. Wider than the library name so the report can distinguish
   * "openchrome (native MCP)" from a future "openchrome (passive tool)".
   */
  competitorPin: string;
  /**
   * True when the library's native-mode loop is wired to a real driver. Today
   * only `openchrome` is wired (re-uses the existing Claude tool-call loop);
   * playwright-mcp and browser-use ship as scaffolds with a clear "not yet
   * wired" surface that the runner displays as a skip annotation.
   */
  nativeLoopWired: boolean;
  /** One-line note for the report. */
  note: string;
}

/** Today's wiring status — updated as each library's loop lands. */
export const LIBRARY_ROUTING: Record<WebVoyagerLibrary, LibraryRouting> = {
  openchrome: {
    library: 'openchrome',
    competitorPin: 'OpenChrome (native MCP)',
    nativeLoopWired: true,
    note: 'OpenChrome MCP server driven by Claude tool-calling. Existing claude-adapter.ts.',
  },
  'playwright-mcp': {
    library: 'playwright-mcp',
    competitorPin: 'playwright-mcp (native MCP)',
    nativeLoopWired: false,
    note: 'playwright-mcp MCP server driven by the same Claude tool-calling loop. Loop wiring lands next session.',
  },
  'browser-use': {
    library: 'browser-use',
    competitorPin: 'browser-use (native agent loop)',
    nativeLoopWired: false,
    note: 'browser-use Python agent loop with the pinned Claude model via the #1280 bridge. Loop wiring lands next session.',
  },
};

export interface DryRunInputs {
  taskCount: number;
  libraries: readonly WebVoyagerLibrary[];
  /** Repetitions per task per library (issue #1257 minimum N=10). */
  repetitions: number;
  /** Optional override; defaults to the WEBVOYAGER_BUDGET cap. */
  maxUsdPerTask?: number;
}

export interface DryRunProjection {
  taskCount: number;
  librariesRun: number;
  repetitions: number;
  /** Per-task USD cap from the budget (or override). */
  maxUsdPerTask: number;
  /** Worst-case total USD: taskCount × librariesRun × repetitions × cap. */
  worstCaseUsd: number;
  /** Per-library breakdown of "cells that would actually run today". */
  perLibrary: Array<{
    library: WebVoyagerLibrary;
    wired: boolean;
    cellsWouldRun: number;
    note: string;
  }>;
  /** Sum of cells that would actually issue API calls if --dry-run is dropped. */
  cellsWouldRunTotal: number;
}

/**
 * Project the worst-case dollar exposure for a planned real-LLM run. The
 * runner refuses to issue any API call when `--dry-run` is set; this
 * projection is the only output of that mode so the operator can decide
 * whether to lift the gate.
 *
 * `worstCaseUsd` assumes every task hits the per-task USD cap. In practice
 * tasks abort early on contract pass or budget exhaustion, so the realized
 * spend is typically a fraction of this number — but the worst case is the
 * number the operator must be ready to authorize.
 */
export function projectCost(inputs: DryRunInputs): DryRunProjection {
  if (!Number.isInteger(inputs.taskCount) || inputs.taskCount < 0) {
    throw new Error(`taskCount must be a non-negative integer, got ${inputs.taskCount}`);
  }
  if (!Number.isInteger(inputs.repetitions) || inputs.repetitions < 1) {
    throw new Error(`repetitions must be a positive integer, got ${inputs.repetitions}`);
  }
  if (inputs.libraries.length === 0) {
    throw new Error('libraries must be non-empty');
  }
  const cap = inputs.maxUsdPerTask ?? WEBVOYAGER_BUDGET.max_usd_per_task;
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(`maxUsdPerTask must be > 0, got ${cap}`);
  }
  const perLibrary = inputs.libraries.map((library) => {
    const routing = LIBRARY_ROUTING[library];
    return {
      library,
      wired: routing.nativeLoopWired,
      cellsWouldRun: routing.nativeLoopWired ? inputs.taskCount * inputs.repetitions : 0,
      note: routing.note,
    };
  });
  const cellsWouldRunTotal = perLibrary.reduce((s, l) => s + l.cellsWouldRun, 0);
  const worstCaseUsd = inputs.taskCount * inputs.libraries.length * inputs.repetitions * cap;
  return {
    taskCount: inputs.taskCount,
    librariesRun: inputs.libraries.length,
    repetitions: inputs.repetitions,
    maxUsdPerTask: cap,
    worstCaseUsd,
    perLibrary,
    cellsWouldRunTotal,
  };
}

/** Format a dry-run projection as a human-readable ASCII block. */
export function formatProjection(p: DryRunProjection): string {
  const lines = [
    'WebVoyager dry-run cost projection (#1257)',
    `  tasks                  : ${p.taskCount}`,
    `  libraries              : ${p.librariesRun} (${p.perLibrary.map((l) => l.library).join(', ')})`,
    `  reps per (task,lib)    : ${p.repetitions}`,
    `  max USD per task cap   : $${p.maxUsdPerTask.toFixed(2)}`,
    `  worst-case total USD   : $${p.worstCaseUsd.toFixed(2)}`,
    `  cells that would run   : ${p.cellsWouldRunTotal} (rest are scaffolded, no API call)`,
    '',
    'Per-library:',
  ];
  for (const l of p.perLibrary) {
    lines.push(`  ${l.library.padEnd(15)} wired=${String(l.wired).padEnd(5)} would-run=${l.cellsWouldRun}  ${l.note}`);
  }
  lines.push('');
  lines.push('No API calls are made in --dry-run mode. To proceed, drop --dry-run and set OPENCHROME_BENCH_REAL=1.');
  return lines.join('\n');
}
