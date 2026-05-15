#!/usr/bin/env ts-node
/**
 * Developer Experience runner for axis #1261.
 *
 * Reads each DX script under `tests/benchmark/dx-scripts/<library>/<task>.ts`
 * and reports LOC per (library × task) cell. Schema-completeness +
 * error-actionability rubrics ship as the next-session integration when the
 * MCP servers can be introspected; today the runner emits the LOC matrix +
 * placeholder fields for the other two rubrics so the report renderer's
 * shape is fixed.
 *
 *   npm run bench:dx
 */

import * as fs from 'fs';
import * as path from 'path';

import { countLoc } from './dx-rubrics';
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
  /** Schema completeness 0..1; null today (next-session integration). */
  schemaCompleteness: number | null;
  /** Error actionability 0..3; null today (next-session integration). */
  errorActionability: number | null;
  /** True when the library ships its tools as an MCP server (gates schema/error rubrics). */
  isMcp: boolean;
}

const MCP_LIBRARIES = new Set(['openchrome', 'playwright-mcp', 'puppeteer-mcp', 'browsermcp']);

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
        schemaCompleteness: null,
        errorActionability: null,
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
  console.error(
    '\nNote: schema-completeness + error-actionability rubrics ship as null until\n' +
      'the MCP introspection wiring lands. The LOC matrix above is fully measured.',
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('DX benchmark failed:', err);
    process.exit(1);
  }
}
