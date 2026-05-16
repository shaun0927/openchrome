#!/usr/bin/env ts-node
/**
 * Throughput runner for the Speed & Throughput axis (#1258).
 *
 * Drives the static fixture server's 50-page mirror at concurrency 1 / 5 /
 * 10 / 20 against OpenChrome and selected competitor adapters and records both the raw
 * throughput + success-rate PRIMARIES and the effective-throughput
 * SECONDARY composite into the standard result envelope.
 *
 * Modes:
 *
 *   npm run bench:throughput
 *     deterministic OpenChrome stub adapter (no Chrome). Always available —
 *     this is what CI runs by default. Pass `--library crawlee` or
 *     `--library all --include-live-competitors=false` to include the
 *     no-Chrome Crawlee competitor cell locally.
 *
 *   OPENCHROME_BENCH_LIVE=1 npm run bench:throughput
 *     real OpenChrome, Playwright, and Puppeteer adapters against Chrome on
 *     port 9222, plus Crawlee. Surfaces a clear error if Chrome is not
 *     reachable rather than silently falling back to stub.
 *
 *   npm run bench:throughput -- --ci
 *     CI mode = stub, with the minimum iteration count that still
 *     respects the warm-up discard.
 */

import * as fs from "fs";
import * as path from "path";

import { MCPAdapter } from "./benchmark-runner";
import {
  OpenChromeStubAdapter,
  OpenChromeRealAdapter,
  PlaywrightAdapter,
  PuppeteerAdapter,
  CrawleeAdapter,
} from "./adapters";
import { startStaticFixtureServer } from "./fixtures/static-server";
import {
  measureThroughput,
  ThroughputSummary,
  DEFAULT_THROUGHPUT_CONCURRENCIES,
  DEFAULT_THROUGHPUT_WARMUP_DISCARD,
} from "./throughput";
import { captureEnvironment } from "./utils/environment";
import {
  buildResultEnvelope,
  assertValidResultEnvelope,
} from "./utils/result-envelope";

const OUTPUT_PATH = path.join(
  process.cwd(),
  "benchmark",
  "results",
  "speed-throughput.json",
);

export type ThroughputLibrary =
  | "openchrome"
  | "playwright"
  | "puppeteer"
  | "crawlee"
  | "all";

export type ThroughputSessionMode = 'reuse' | 'cold';

export interface ThroughputRunOptions {
  /** When true, use the deterministic stub adapter for OpenChrome unless live is set. */
  ciMode: boolean;
  /** Total passes per concurrency cell, including warm-up. */
  iterations: number;
  /** Warm-up passes to discard. */
  warmupDiscard: number;
  /** Concurrency cells to measure. */
  concurrencies: readonly number[];
  /** When true, force the live (real) adapter regardless of `ciMode`. */
  live: boolean;
  /** Library matrix to run. `all` expands to every supported competitor. */
  library: ThroughputLibrary;
  /** Include Chrome/CDP competitors when `library=all` and live mode is disabled. */
  includeLiveCompetitors: boolean;
  /** Reuse one adapter setup per library, or cold-start setup/teardown for every concurrency cell. */
  sessionMode: ThroughputSessionMode;
}

export interface ThroughputRow {
  library: string;
  mode: string;
  sessionMode: ThroughputSessionMode;
  concurrency: number;
  pagesPerPass: number;
  sampleCount: number;
  warmupDiscarded: number;
  rawPagesPerSecond: number;
  successRate: number;
  effectivePagesPerSecond: number;
  meanWallMs: number;
  p50WallMs: number;
  p95WallMs: number;
}

const THROUGHPUT_LIBRARIES: readonly Exclude<ThroughputLibrary, "all">[] = [
  "openchrome",
  "playwright",
  "puppeteer",
  "crawlee",
];

function parseLibrary(value: string): ThroughputLibrary {
  if (
    value === "all" ||
    (THROUGHPUT_LIBRARIES as readonly string[]).includes(value)
  ) {
    return value as ThroughputLibrary;
  }
  throw new Error(
    `--library must be one of all, ${THROUGHPUT_LIBRARIES.join(", ")}; got: ${value}`,
  );
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseSessionMode(value: string | undefined): ThroughputSessionMode {
  if (value === undefined) return 'reuse';
  if (value === 'reuse' || value === 'cold') return value;
  throw new Error(`--session-mode must be reuse or cold; got: ${value}`);
}

function parseBooleanFlag(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`boolean flag value must be true/false, got: ${value}`);
}

export function parseThroughputArgs(argv: string[]): ThroughputRunOptions {
  const ciMode = argv.includes("--ci");
  const liveFlag =
    argv.includes("--live") || process.env.OPENCHROME_BENCH_LIVE === "1";
  let iterations = ciMode
    ? DEFAULT_THROUGHPUT_WARMUP_DISCARD + 1
    : DEFAULT_THROUGHPUT_WARMUP_DISCARD + 3;
  const iterationsFlag = flagValue(argv, "--iterations");
  if (iterationsFlag !== undefined) {
    const raw = iterationsFlag.trim();
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== raw) {
      throw new Error(
        `--iterations must be a positive integer; got: ${iterationsFlag}`,
      );
    }
    iterations = n;
  }
  if (iterations <= DEFAULT_THROUGHPUT_WARMUP_DISCARD) {
    throw new Error(
      `--iterations (${iterations}) must exceed the warm-up discard (${DEFAULT_THROUGHPUT_WARMUP_DISCARD})`,
    );
  }
  let concurrencies: readonly number[] = DEFAULT_THROUGHPUT_CONCURRENCIES;
  const concurrencyFlag = flagValue(argv, "--concurrency");
  if (concurrencyFlag !== undefined) {
    const parsed = concurrencyFlag
      .split(",")
      .map((s) => parseInt(s.trim(), 10));
    if (parsed.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new Error(
        `--concurrency must be a comma-separated list of positive integers`,
      );
    }
    concurrencies = parsed;
  }
  const library = parseLibrary(
    flagValue(argv, "--library") ??
      process.env.OPENCHROME_BENCH_LIBRARY ??
      "openchrome",
  );
  const includeLiveCompetitors = parseBooleanFlag(
    flagValue(argv, "--include-live-competitors") ??
      process.env.OPENCHROME_BENCH_INCLUDE_LIVE_COMPETITORS,
    liveFlag,
  );
  const sessionMode = parseSessionMode(
    flagValue(argv, "--session-mode") ?? process.env.OPENCHROME_BENCH_SESSION_MODE,
  );
  return {
    ciMode,
    iterations,
    warmupDiscard: DEFAULT_THROUGHPUT_WARMUP_DISCARD,
    concurrencies,
    live: liveFlag,
    library,
    includeLiveCompetitors,
    sessionMode,
  };
}

function toRow(
  library: string,
  mode: string,
  sessionMode: ThroughputSessionMode,
  summary: ThroughputSummary,
): ThroughputRow {
  return {
    library,
    mode,
    sessionMode,
    concurrency: summary.concurrency,
    pagesPerPass: summary.pagesPerPass,
    sampleCount: summary.sampleCount,
    warmupDiscarded: summary.warmupDiscarded,
    rawPagesPerSecond: summary.rawPagesPerSecond,
    successRate: summary.successRate,
    effectivePagesPerSecond: summary.effectivePagesPerSecond,
    meanWallMs: summary.meanWallMs,
    p50WallMs: summary.p50WallMs,
    p95WallMs: summary.p95WallMs,
  };
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function packageVersion(pkgName: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(`${pkgName}/package.json`).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function competitorVersion(name: string): string {
  if (name === "OpenChrome") return readRepoVersion();
  if (name === "Playwright") return packageVersion("playwright");
  if (name === "Puppeteer") return packageVersion("puppeteer-core");
  if (name === "Crawlee") return packageVersion("crawlee");
  return "unknown";
}

interface AdapterEntry {
  library: string;
  mode: string;
  adapter: MCPAdapter;
  requiresLiveChrome: boolean;
}

/**
 * Build the adapter matrix requested by the operator. OpenChrome remains stubbed
 * by default so CI has a no-Chrome path. Crawlee is a real competitor that can
 * run without Chrome against the local fixture server. Playwright/Puppeteer and
 * live OpenChrome are included only when live mode or explicit inclusion is set,
 * avoiding silent Chrome fallbacks.
 */
function buildAdapters(options: ThroughputRunOptions): AdapterEntry[] {
  const requested =
    options.library === "all" ? THROUGHPUT_LIBRARIES : [options.library];
  const entries: AdapterEntry[] = [];
  for (const library of requested) {
    if (library === "openchrome") {
      if (options.live && !options.ciMode) {
        entries.push({
          library: "OpenChrome",
          mode: "dom-live",
          adapter: new OpenChromeRealAdapter({ mode: "dom" }),
          requiresLiveChrome: true,
        });
      } else {
        entries.push({
          library: "OpenChrome",
          mode: "dom-stub",
          adapter: new OpenChromeStubAdapter({ mode: "dom" }),
          requiresLiveChrome: false,
        });
      }
    } else if (library === "crawlee") {
      entries.push({
        library: "Crawlee",
        mode: "cheerio-text",
        adapter: new CrawleeAdapter(),
        requiresLiveChrome: false,
      });
    } else if (library === "playwright") {
      entries.push({
        library: "Playwright",
        mode: "raw-html-cdp",
        adapter: new PlaywrightAdapter(),
        requiresLiveChrome: true,
      });
    } else if (library === "puppeteer") {
      entries.push({
        library: "Puppeteer",
        mode: "raw-html-cdp",
        adapter: new PuppeteerAdapter(),
        requiresLiveChrome: true,
      });
    }
  }
  return entries.filter((entry) => {
    if (!entry.requiresLiveChrome) return true;
    if (options.live && !options.ciMode) return true;
    return options.includeLiveCompetitors;
  });
}

export async function runThroughputBenchmark(
  options: ThroughputRunOptions,
): Promise<ThroughputRow[]> {
  const server = await startStaticFixtureServer();
  const urls = server.pageUrls();
  const entries = buildAdapters(options);
  if (entries.length === 0) {
    throw new Error(
      "no throughput adapters selected after applying live-competitor gates",
    );
  }
  const rows: ThroughputRow[] = [];
  try {
    for (const entry of entries) {
      if (options.sessionMode === 'reuse') {
        try {
          if (entry.adapter.setup) await entry.adapter.setup();
          for (const concurrency of options.concurrencies) {
            const summary = await measureThroughput(entry.adapter, {
              urls,
              concurrency,
              iterations: options.iterations,
              warmupDiscard: options.warmupDiscard,
            });
            rows.push(toRow(entry.library, entry.mode, options.sessionMode, summary));
          }
        } finally {
          if (entry.adapter.teardown) await entry.adapter.teardown();
        }
      } else {
        for (const concurrency of options.concurrencies) {
          try {
            if (entry.adapter.setup) await entry.adapter.setup();
            const summary = await measureThroughput(entry.adapter, {
              urls,
              concurrency,
              iterations: options.iterations,
              warmupDiscard: options.warmupDiscard,
            });
            rows.push(toRow(entry.library, entry.mode, options.sessionMode, summary));
          } finally {
            if (entry.adapter.teardown) await entry.adapter.teardown();
          }
        }
      }
    }
  } finally {
    await server.close();
  }
  return rows;
}

function formatReport(rows: ThroughputRow[]): string {
  const lines = [
    "Throughput benchmark (#1258) — raw + success + effective (labeled secondary)",
    "library      mode       session conc   raw pg/s   success   effective   p50(ms)   p95(ms)   samples",
  ];
  for (const r of rows) {
    lines.push(
      [
        r.library.padEnd(12),
        r.mode.padEnd(10),
        r.sessionMode.padEnd(7),
        String(r.concurrency).padStart(4),
        r.rawPagesPerSecond.toFixed(1).padStart(10),
        (r.successRate * 100).toFixed(1).padStart(7) + "%",
        r.effectivePagesPerSecond.toFixed(1).padStart(11),
        r.p50WallMs.toFixed(1).padStart(9),
        r.p95WallMs.toFixed(1).padStart(9),
        String(r.sampleCount).padStart(8),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseThroughputArgs(argv);
  const rows = await runThroughputBenchmark(options);

  const envelope = buildResultEnvelope({
    axis: "speed-throughput",
    environment: captureEnvironment(),
    competitors: Array.from(new Set(rows.map((row) => row.library))).map(
      (name) => ({
        name,
        version: competitorVersion(name),
      }),
    ),
    results: rows,
  });
  assertValidResultEnvelope(envelope);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(envelope, null, 2) + "\n");

  // console.error: stdout carries MCP JSON-RPC in this codebase; never log there.
  console.error(formatReport(rows));
  console.error(`\nSaved: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Throughput benchmark failed:", err);
    process.exit(1);
  });
}
