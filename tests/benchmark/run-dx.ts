#!/usr/bin/env ts-node
/**
 * Developer Experience runner for axis #1261.
 *
 * Reads each DX script under `tests/benchmark/dx-scripts/<library>/<task>.ts`
 * and reports LOC per (library × task) cell plus rule-based schema-completeness
 * and induced-error actionability scores where fixtures are available.
 *
 *   npm run bench:dx
 */

import * as fs from 'fs';
import * as path from 'path';

import { countLoc, scoreErrorActionability, scoreToolSchema, ToolSchemaInput } from './dx-rubrics';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'dx.json');
const SCRIPTS_DIR = path.join(__dirname, 'dx-scripts');

export interface DxRow {
  library: string;
  task: string;
  scriptPath: string;
  loc: number;
  blankLines: number;
  commentLines: number;
  totalLines: number;
  /** Schema completeness 0..1; null when the library has no MCP/tool schema fixture. */
  schemaCompleteness: number | null;
  /** Error actionability 0..3; null when no induced-error fixture is available. */
  errorActionability: number | null;
  /** True when the library ships its tools as an MCP server (gates schema/error rubrics). */
  isMcp: boolean;
}

const MCP_LIBRARIES = new Set(['openchrome', 'playwright-mcp', 'puppeteer-mcp', 'browsermcp']);

const TOOL_SCHEMA_FIXTURES: Record<string, ToolSchemaInput[]> = {
  openchrome: [
    { name: 'tabs_create', description: 'Open a new browser tab at the given URL', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute URL to open', examples: ['https://example.com'] } }, required: ['url'] } },
    { name: 'read_page', description: 'Return a compact page snapshot for the active or selected tab', inputSchema: { type: 'object', properties: { tabId: { type: 'string', description: 'Tab identifier returned by tabs_create' } }, required: ['tabId'] } },
    { name: 'tabs_close', description: 'Close an existing browser tab', inputSchema: { type: 'object', properties: { tabId: { type: 'string', description: 'Tab identifier to close' } }, required: ['tabId'] } },
  ],
  'playwright-mcp': [
    { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' } }, required: ['url'] } },
    { name: 'browser_snapshot', description: 'Capture an accessibility snapshot', inputSchema: { type: 'object', properties: {}, required: [] } },
  ],
};

const INDUCED_ERROR_FIXTURES: Record<string, string[]> = {
  openchrome: [
    'selector not found on page http://127.0.0.1/form for selector #missing-submit; try read_page or use a stable role selector instead',
    'navigation timeout at url http://127.0.0.1/slow; increase timeout or wait for network idle',
  ],
  playwright: [
    'Timeout 30000ms exceeded while waiting for selector #missing-submit on page; consider increasing timeout or checking the locator',
  ],
  puppeteer: [
    'No element found for selector #missing-submit on page; use waitForSelector before clicking',
  ],
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function schemaCompletenessFor(library: string): number | null {
  const tools = TOOL_SCHEMA_FIXTURES[library];
  if (!tools || tools.length === 0) return null;
  return mean(tools.map((tool) => scoreToolSchema(tool).score));
}

function errorActionabilityFor(library: string): number | null {
  const messages = INDUCED_ERROR_FIXTURES[library];
  if (!messages || messages.length === 0) return null;
  return mean(messages.map((message) => scoreErrorActionability(message).score));
}

function listLibraries(): string[] {
  if (!fs.existsSync(SCRIPTS_DIR)) return [];
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((d) => fs.statSync(path.join(SCRIPTS_DIR, d)).isDirectory());
}

function listTasks(library: string): string[] {
  const dir = path.join(SCRIPTS_DIR, library);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''));
}

export function runDxBenchmark(): DxRow[] {
  const rows: DxRow[] = [];
  for (const library of listLibraries().sort()) {
    for (const task of listTasks(library).sort()) {
      const scriptPath = path.join(SCRIPTS_DIR, library, `${task}.ts`);
      const source = fs.readFileSync(scriptPath, 'utf8');
      const loc = countLoc(source);
      rows.push({
        library,
        task,
        scriptPath: path.relative(process.cwd(), scriptPath),
        loc: loc.loc,
        blankLines: loc.blankLines,
        commentLines: loc.commentLines,
        totalLines: loc.totalLines,
        schemaCompleteness: schemaCompletenessFor(library),
        errorActionability: errorActionabilityFor(library),
        isMcp: MCP_LIBRARIES.has(library),
      });
    }
  }
  return rows;
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatReport(rows: DxRow[]): string {
  const lines = ['Developer Experience (#1261) — LOC per (library × task)'];
  lines.push('library         task                    LOC   kind');
  for (const r of rows) {
    lines.push(
      [
        r.library.padEnd(14),
        r.task.padEnd(22),
        String(r.loc).padStart(5),
        r.isMcp ? 'MCP' : 'framework',
      ].join(' '),
    );
  }
  return lines.join('\n');
}

export function main(): void {
  const rows = runDxBenchmark();
  if (rows.length === 0) {
    console.error('No DX scripts found under tests/benchmark/dx-scripts/');
    process.exit(1);
  }
  const libraries = Array.from(new Set(rows.map((r) => r.library)));
  const envelope = buildResultEnvelope({
    axis: 'developer-experience',
    environment: captureEnvironment(),
    competitors: libraries.map((lib) => ({
      name: lib,
      version: lib === 'openchrome' ? readRepoVersion() : 'idiomatic-script-only',
    })),
    results: rows,
  });
  assertValidResultEnvelope(envelope);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(envelope, null, 2) + '\n');

  console.error(formatReport(rows));
  console.error(`\nSaved: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.error('\nNote: schema-completeness and error-actionability are measured from committed rule-based fixtures when available; null means the fixture is not yet available for that library.');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('DX benchmark failed:', err);
    process.exit(1);
  }
}
