#!/usr/bin/env ts-node
/**
 * Live/diagnostic competitor smoke matrix for benchmark harness readiness (#1255).
 *
 * The runner executes the same create/read/close smoke contract for every
 * competitor adapter. CI-safe defaults run OpenChrome stub + Crawlee local
 * fixture rows; live-gated competitors are explicit skips unless the operator
 * passes --include-live and provides the required runtime.
 */

import * as fs from 'fs';
import * as path from 'path';

import { MCPAdapter } from './benchmark-runner';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';
import { captureEnvironment } from './utils/environment';
import { startStaticFixtureServer } from './fixtures/static-server';
import {
  BrowserUseAdapter,
  CrawleeAdapter,
  OpenChromeRealAdapter,
  OpenChromeStubAdapter,
  PlaywrightAdapter,
  PlaywrightMcpAdapter,
  PuppeteerAdapter,
} from './adapters';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'competitor-smoke.json');

export type SmokeLibrary = 'openchrome' | 'playwright' | 'puppeteer' | 'crawlee' | 'playwright-mcp' | 'browser-use' | 'all';
export type SmokeStatus = 'passed' | 'failed' | 'skipped';

export interface CompetitorSmokeOptions {
  includeLive: boolean;
  library: SmokeLibrary;
  timeoutMs: number;
}

export interface CompetitorSmokeRow {
  library: string;
  mode: string;
  status: SmokeStatus;
  taskContract: 'tabs_create/read_page/tabs_close';
  liveRequired: boolean;
  versionPinned: boolean;
  sameTaskContract: boolean;
  durationMs: number;
  payloadChars: number;
  skipReason: string;
  failure: string;
}

interface AdapterSpec {
  library: string;
  mode: string;
  liveRequired: boolean;
  adapterFactory: () => MCPAdapter;
}

const LIBRARIES: readonly Exclude<SmokeLibrary, 'all'>[] = ['openchrome', 'playwright', 'puppeteer', 'crawlee', 'playwright-mcp', 'browser-use'];

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`boolean flag must be true/false, got ${value}`);
}

function parseLibrary(value: string): SmokeLibrary {
  if (value === 'all' || (LIBRARIES as readonly string[]).includes(value)) return value as SmokeLibrary;
  throw new Error(`--library must be one of all, ${LIBRARIES.join(', ')}`);
}

export function parseSmokeArgs(argv: string[]): CompetitorSmokeOptions {
  const includeLive = parseBoolean(flagValue(argv, '--include-live') ?? process.env.OPENCHROME_BENCH_INCLUDE_LIVE, false);
  const library = parseLibrary(flagValue(argv, '--library') ?? process.env.OPENCHROME_BENCH_LIBRARY ?? 'all');
  const timeoutRaw = flagValue(argv, '--timeout-ms') ?? '30000';
  const timeoutMs = parseInt(timeoutRaw, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || String(timeoutMs) !== timeoutRaw.trim()) {
    throw new Error(`--timeout-ms must be a positive integer, got ${timeoutRaw}`);
  }
  return { includeLive, library, timeoutMs };
}

function specs(options: CompetitorSmokeOptions): AdapterSpec[] {
  const requested = options.library === 'all' ? LIBRARIES : [options.library];
  const all: Record<Exclude<SmokeLibrary, 'all'>, AdapterSpec> = {
    openchrome: options.includeLive
      ? { library: 'OpenChrome', mode: 'dom-live', liveRequired: true, adapterFactory: () => new OpenChromeRealAdapter({ mode: 'dom' }) }
      : { library: 'OpenChrome', mode: 'dom-stub', liveRequired: false, adapterFactory: () => new OpenChromeStubAdapter({ mode: 'dom' }) },
    playwright: { library: 'Playwright', mode: 'raw-html-cdp', liveRequired: true, adapterFactory: () => new PlaywrightAdapter() },
    puppeteer: { library: 'Puppeteer', mode: 'raw-html-cdp', liveRequired: true, adapterFactory: () => new PuppeteerAdapter() },
    crawlee: { library: 'Crawlee', mode: 'cheerio-text', liveRequired: false, adapterFactory: () => new CrawleeAdapter() },
    'playwright-mcp': { library: 'playwright-mcp', mode: 'native-mcp', liveRequired: true, adapterFactory: () => new PlaywrightMcpAdapter({ serverPath: process.env.PLAYWRIGHT_MCP_SERVER_PATH, cdpEndpoint: process.env.OPENCHROME_BENCH_CDP_ENDPOINT }) },
    'browser-use': { library: 'browser-use', mode: 'python-bridge', liveRequired: true, adapterFactory: () => new BrowserUseAdapter({ bridgeScriptPath: process.env.BROWSER_USE_BRIDGE_SCRIPT, python: process.env.BROWSER_USE_PYTHON }) },
  };
  return requested.map((library) => all[library]);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseTabId(text: string | undefined): string {
  if (!text) throw new Error('tabs_create returned no text payload');
  const parsed = JSON.parse(text);
  if (typeof parsed.tabId !== 'string' || parsed.tabId.length === 0) throw new Error('tabs_create did not return tabId');
  return parsed.tabId;
}

async function runOne(spec: AdapterSpec, url: string, options: CompetitorSmokeOptions): Promise<CompetitorSmokeRow> {
  if (spec.liveRequired && !options.includeLive) {
    return {
      library: spec.library,
      mode: spec.mode,
      status: 'skipped',
      taskContract: 'tabs_create/read_page/tabs_close',
      liveRequired: true,
      versionPinned: true,
      sameTaskContract: true,
      durationMs: 0,
      payloadChars: 0,
      skipReason: 'live competitor omitted; pass --include-live with required runtime/credentials',
      failure: '',
    };
  }

  const started = Date.now();
  const adapter = spec.adapterFactory();
  try {
    await withTimeout(adapter.setup?.() ?? Promise.resolve(), options.timeoutMs, `${spec.library} setup`);
    const create = await withTimeout(adapter.callTool('tabs_create', { url }), options.timeoutMs, `${spec.library} tabs_create`);
    if (create.isError) throw new Error(create.content?.[0]?.text ?? 'tabs_create failed');
    const tabId = parseTabId(create.content?.[0]?.text);
    const read = await withTimeout(adapter.callTool('read_page', { tabId }), options.timeoutMs, `${spec.library} read_page`);
    if (read.isError) throw new Error(read.content?.[0]?.text ?? 'read_page failed');
    await withTimeout(adapter.callTool('tabs_close', { tabId }), options.timeoutMs, `${spec.library} tabs_close`);
    const payload = read.content?.map((entry) => entry.text ?? '').join('\n') ?? '';
    return {
      library: spec.library,
      mode: spec.mode,
      status: 'passed',
      taskContract: 'tabs_create/read_page/tabs_close',
      liveRequired: spec.liveRequired,
      versionPinned: true,
      sameTaskContract: true,
      durationMs: Date.now() - started,
      payloadChars: payload.length,
      skipReason: '',
      failure: '',
    };
  } catch (err) {
    return {
      library: spec.library,
      mode: spec.mode,
      status: 'failed',
      taskContract: 'tabs_create/read_page/tabs_close',
      liveRequired: spec.liveRequired,
      versionPinned: true,
      sameTaskContract: true,
      durationMs: Date.now() - started,
      payloadChars: 0,
      skipReason: '',
      failure: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await adapter.teardown?.().catch(() => undefined);
  }
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function runCompetitorSmokeMatrix(options: CompetitorSmokeOptions): Promise<CompetitorSmokeRow[]> {
  const server = await startStaticFixtureServer();
  try {
    const url = server.url('small');
    const rows: CompetitorSmokeRow[] = [];
    for (const spec of specs(options)) rows.push(await runOne(spec, url, options));
    return rows;
  } finally {
    await server.close();
  }
}

function formatReport(rows: readonly CompetitorSmokeRow[]): string {
  return [
    'Competitor smoke matrix (#1255) — same tabs_create/read_page/tabs_close contract',
    'library          mode             status    payload  note',
    ...rows.map((row) => [
      row.library.padEnd(16),
      row.mode.padEnd(16),
      row.status.padEnd(8),
      String(row.payloadChars).padStart(7),
      row.skipReason || row.failure,
    ].join(' ')),
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseSmokeArgs(argv);
  const rows = await runCompetitorSmokeMatrix(options);
  const competitors = Array.from(new Set(rows.map((row) => row.library))).map((name) => ({ name, version: name === 'OpenChrome' ? readRepoVersion() : 'operator-pinned-runtime' }));
  const envelope = buildResultEnvelope({
    axis: 'foundation',
    environment: captureEnvironment(),
    competitors,
    results: rows,
  });
  assertValidResultEnvelope(envelope);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(envelope, null, 2) + '\n');
  console.error(formatReport(rows));
  console.error(`\nSaved: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('competitor smoke matrix failed:', err);
    process.exit(1);
  });
}
