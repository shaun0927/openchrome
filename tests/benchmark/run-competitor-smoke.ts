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
import { spawnSync } from 'child_process';

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
export type SmokeSkipCategory = 'none' | 'not_requested' | 'dependency_missing' | 'runtime_missing' | 'not_wired';
export type SmokeVersionSource = 'package-json' | 'node-resolution' | 'python-importlib' | 'benchmark-registry' | 'unknown';

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
  version: string;
  versionSource: SmokeVersionSource;
  versionPinned: boolean;
  dependencyAvailable: boolean;
  skipCategory: SmokeSkipCategory;
  sameTaskContract: boolean;
  durationMs: number;
  payloadChars: number;
  skipReason: string;
  failure: string;
}

export interface AdapterSpec {
  library: string;
  mode: string;
  liveRequired: boolean;
  packageName?: string;
  adapterFactory: () => MCPAdapter;
}

interface VersionInfo {
  version: string;
  source: SmokeVersionSource;
  dependencyAvailable: boolean;
}

const LIBRARIES: readonly Exclude<SmokeLibrary, 'all'>[] = ['openchrome', 'playwright', 'puppeteer', 'crawlee', 'playwright-mcp', 'browser-use'];

const REGISTRY_PINNED_VERSIONS: Readonly<Record<string, string>> = {
  OpenChrome: readRepoVersion(),
  Playwright: '1.60.0',
  Puppeteer: '23.10.3',
  Crawlee: '3.16.0',
  'playwright-mcp': '0.0.75',
  'browser-use': '0.12.6',
};

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
  // Every CDP-based adapter in the 6-way smoke attaches to the *operator's*
  // Chrome via OPENCHROME_BENCH_CDP_ENDPOINT instead of each library
  // launching/looking up its own default. Co-locating them on one Chrome
  // (a) keeps the matrix comparable — same browser, same profile, same page —
  // and (b) avoids the failure mode where two adapters race to launch their
  // own Chromium against an identical default user-data-dir.
  const cdpEndpoint = process.env.OPENCHROME_BENCH_CDP_ENDPOINT;
  const all: Record<Exclude<SmokeLibrary, 'all'>, AdapterSpec> = {
    openchrome: options.includeLive
      ? { library: 'OpenChrome', mode: 'dom-live', liveRequired: true, adapterFactory: () => new OpenChromeRealAdapter({ mode: 'dom', cdpEndpoint }) }
      : { library: 'OpenChrome', mode: 'dom-stub', liveRequired: false, adapterFactory: () => new OpenChromeStubAdapter({ mode: 'dom' }) },
    playwright: { library: 'Playwright', mode: 'raw-html-cdp', liveRequired: true, packageName: 'playwright', adapterFactory: () => new PlaywrightAdapter({ cdpEndpoint }) },
    puppeteer: { library: 'Puppeteer', mode: 'raw-html-cdp', liveRequired: true, packageName: 'puppeteer-core', adapterFactory: () => new PuppeteerAdapter({ browserURL: cdpEndpoint }) },
    crawlee: { library: 'Crawlee', mode: 'cheerio-text', liveRequired: false, packageName: 'crawlee', adapterFactory: () => new CrawleeAdapter() },
    'playwright-mcp': { library: 'playwright-mcp', mode: 'native-mcp', liveRequired: true, packageName: '@playwright/mcp', adapterFactory: () => new PlaywrightMcpAdapter({ serverPath: process.env.PLAYWRIGHT_MCP_SERVER_PATH, cdpEndpoint }) },
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


function packageVersion(packageName: string): VersionInfo {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [process.cwd()] });
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return { version: pkg.version.trim(), source: 'node-resolution', dependencyAvailable: true };
    }
  } catch {
    // Fall through to registry pin / unavailable status.
  }
  return {
    version: REGISTRY_PINNED_VERSIONS[packageNameToLibrary(packageName)] ?? 'unknown',
    source: 'benchmark-registry',
    dependencyAvailable: false,
  };
}

function packageNameToLibrary(packageName: string): string {
  if (packageName === 'playwright') return 'Playwright';
  if (packageName === 'puppeteer-core') return 'Puppeteer';
  if (packageName === 'crawlee') return 'Crawlee';
  if (packageName === '@playwright/mcp') return 'playwright-mcp';
  return packageName;
}

function browserUseVersion(python = process.env.BROWSER_USE_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')): VersionInfo {
  const result = spawnSync(python, ['-c', "import importlib.metadata; print(importlib.metadata.version('browser-use'))"], {
    encoding: 'utf8',
    timeout: 3000,
  });
  if (result.status === 0 && result.stdout.trim().length > 0) {
    return { version: result.stdout.trim(), source: 'python-importlib', dependencyAvailable: true };
  }
  return {
    version: REGISTRY_PINNED_VERSIONS['browser-use'],
    source: 'benchmark-registry',
    dependencyAvailable: false,
  };
}

function versionInfoFor(spec: AdapterSpec): VersionInfo {
  if (spec.library === 'OpenChrome') {
    return { version: readRepoVersion(), source: 'package-json', dependencyAvailable: true };
  }
  if (spec.library === 'browser-use') return browserUseVersion();
  if (spec.packageName) return packageVersion(spec.packageName);
  return { version: REGISTRY_PINNED_VERSIONS[spec.library] ?? 'unknown', source: 'benchmark-registry', dependencyAvailable: false };
}

function isPinnedVersion(version: string): boolean {
  return version.length > 0 && !/^(unknown|TBD|operator-pinned-runtime)$/i.test(version);
}

function parseTabId(text: string | undefined): string {
  if (!text) throw new Error('tabs_create returned no text payload');
  const parsed = JSON.parse(text);
  if (typeof parsed.tabId !== 'string' || parsed.tabId.length === 0) throw new Error('tabs_create did not return tabId');
  return parsed.tabId;
}

export async function runOne(spec: AdapterSpec, url: string, options: CompetitorSmokeOptions): Promise<CompetitorSmokeRow> {
  const versionInfo = versionInfoFor(spec);
  const base = {
    library: spec.library,
    mode: spec.mode,
    taskContract: 'tabs_create/read_page/tabs_close' as const,
    liveRequired: spec.liveRequired,
    version: versionInfo.version,
    versionSource: versionInfo.source,
    versionPinned: isPinnedVersion(versionInfo.version),
    dependencyAvailable: versionInfo.dependencyAvailable,
    sameTaskContract: true,
  };

  if (spec.liveRequired && !options.includeLive) {
    return {
      ...base,
      status: 'skipped',
      skipCategory: 'not_requested',
      durationMs: 0,
      payloadChars: 0,
      skipReason: 'live competitor omitted; pass --include-live with required runtime/credentials',
      failure: '',
    };
  }

  if (!versionInfo.dependencyAvailable) {
    return {
      ...base,
      status: 'skipped',
      skipCategory: 'dependency_missing',
      durationMs: 0,
      payloadChars: 0,
      skipReason: `${spec.library} dependency is not installed or not resolvable in this benchmark runtime`,
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
    // Sanity gate: an adapter that returns the all-three-calls-succeeded shape
    // but ships an empty payload is not actually evidence that the library can
    // observe a page — it just means none of the three calls *threw*. The
    // smoke's whole purpose is to prove the read step produced something for
    // downstream axes to measure, so a zero-length payload is demoted to a
    // failure (`empty_payload`) rather than recorded as a green row.
    if (payload.length === 0) {
      return {
        ...base,
        status: 'failed',
        skipCategory: 'none',
        durationMs: Date.now() - started,
        payloadChars: 0,
        skipReason: '',
        failure: 'empty_payload: read_page returned no text content',
      };
    }
    return {
      ...base,
      status: 'passed',
      skipCategory: 'none',
      durationMs: Date.now() - started,
      payloadChars: payload.length,
      skipReason: '',
      failure: '',
    };
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      skipCategory: 'none',
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
    'library          mode             status    version          skip-category       payload  note',
    ...rows.map((row) => [
      row.library.padEnd(16),
      row.mode.padEnd(16),
      row.status.padEnd(8),
      row.version.padEnd(16),
      row.skipCategory.padEnd(19),
      String(row.payloadChars).padStart(7),
      row.skipReason || row.failure,
    ].join(' ')),
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseSmokeArgs(argv);
  const rows = await runCompetitorSmokeMatrix(options);
  const competitors = rows.map((row) => ({ name: row.library, version: row.version }));
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
