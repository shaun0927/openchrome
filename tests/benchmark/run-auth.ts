#!/usr/bin/env ts-node
/**
 * Auth & Real-World Usability runner for axis #1260.
 *
 * Measures per-library SETUP COST against the local login-wall fixture
 * (`tests/benchmark/fixtures/auth-app/`, shipped by Sprint 0 PR #1271):
 *
 *   - LOC of each library's minimal idiomatic auth-setup script
 *     (`tests/benchmark/auth-setup-scripts/<library>.auth-setup.ts`).
 *     LOC counting rules committed up front (see loc-counter.ts).
 *   - Wall-clock minutes for the reproducible local login-wall smoke, from
 *     fixture start to "first authenticated task passes". The default table
 *     keeps this as `null`; `--local-smoke` records a measured local value so
 *     the table never shows a fabricated 0.
 *   - profileAttach: boolean — true when the library can inherit a real
 *     Chrome profile's session (OpenChrome via `list_profiles`); false
 *     when it requires explicit storageState / userDataDir wiring.
 *
 * Third-party live-account setup timing remains operator-provided only; this
 * runner records the local fixture smoke separately from any external-account
 * workflow so no credentials or unauthorized accounts are needed.
 *
 *   npm run bench:auth
 */

import * as fs from 'fs';
import * as path from 'path';

import { countLoc } from './auth-setup-scripts/loc-counter';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';
import { startAuthApp } from './fixtures/auth-app/server';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'auth-usability.json');
const SCRIPTS_DIR = path.join(__dirname, 'auth-setup-scripts');

export const AUTH_LIBRARIES = ['openchrome', 'playwright', 'puppeteer', 'browser-use'] as const;
export type AuthLibrary = (typeof AUTH_LIBRARIES)[number];

export interface AuthRow {
  library: AuthLibrary;
  /** Path (repo-relative) of the auth-setup script for this library. */
  scriptPath: string;
  /** LOC by the committed counting rule (imports counted; comments + blank excluded). */
  loc: number;
  blankLines: number;
  commentLines: number;
  totalLines: number;
  /**
   * True when the library can inherit a real Chrome profile's auth without
   * any storage-state / userDataDir plumbing. Today only OpenChrome.
   */
  profileAttach: boolean;
  /**
   * Wall-clock minutes from "Chrome installed + creds in hand" to "first
   * authenticated task passes". Null today — the live driver wiring lands
   * in a follow-up; this field is `null` rather than 0 so the table cannot
   * be mistaken for a fabricated measurement.
   */
  wallClockMinutes: number | null;
  /**
   * Whether the script's auth-success path has been smoke-tested against
   * the live login-wall fixture. Today: false for every library (smoke
   * harness pending the live driver).
   */
  loggedInSmoked: boolean;
  /** Evidence from the reproducible local login-wall fixture. */
  localFixtureSmoke: 'passed' | 'failed' | 'not-run';
  /** One-line note for the report renderer. */
  note: string;
}

const LIBRARY_NOTES: Record<AuthLibrary, { profileAttach: boolean; note: string }> = {
  openchrome: {
    profileAttach: true,
    note: 'list_profiles + profile attach inherits a real Chrome profile\'s session with zero setup code.',
  },
  playwright: {
    profileAttach: false,
    note: 'storageState({path}) is the documented best practice; requires interactive login once, file persists.',
  },
  puppeteer: {
    profileAttach: false,
    note: 'userDataDir persists cookies via a profile dir; explicit cookie-jar API is the lower-level primitive.',
  },
  'browser-use': {
    profileAttach: false,
    note: 'Issues a natural-language agent instruction; planning loop resolves the selectors. Requires the Python bridge.',
  },
};

function buildAuthRow(library: AuthLibrary, smoke?: { passed: boolean; wallClockMinutes: number; evidence: string }): AuthRow {
  const scriptPath = path.join(SCRIPTS_DIR, `${library}.auth-setup.ts`);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Missing auth-setup script for ${library} at ${scriptPath}`);
  }
  const source = fs.readFileSync(scriptPath, 'utf8');
  const loc = countLoc(source);
  const meta = LIBRARY_NOTES[library];
  return {
    library,
    scriptPath: path.relative(process.cwd(), scriptPath),
    loc: loc.loc,
    blankLines: loc.blankLines,
    commentLines: loc.commentLines,
    totalLines: loc.totalLines,
    profileAttach: meta.profileAttach,
    wallClockMinutes: smoke?.wallClockMinutes ?? null,
    loggedInSmoked: smoke?.passed ?? false,
    localFixtureSmoke: smoke ? (smoke.passed ? 'passed' : 'failed') : 'not-run',
    note: smoke ? `${meta.note} Local fixture smoke: ${smoke.evidence}` : meta.note,
  };
}

async function smokeLocalAuthFixture(): Promise<{ passed: boolean; wallClockMinutes: number; evidence: string }> {
  const app = await startAuthApp();
  const started = Date.now();
  try {
    const login = await fetch(`${app.url}/login`);
    if (!login.ok) throw new Error(`GET /login HTTP ${login.status}`);
    const body = new URLSearchParams({ username: app.credentials.username, password: app.credentials.password });
    const post = await fetch(`${app.url}/login`, {
      method: 'POST',
      body,
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookie = post.headers.get('set-cookie');
    if (post.status !== 302 || !cookie) throw new Error(`POST /login did not set session cookie; status=${post.status}`);
    const dashboard = await fetch(`${app.url}/`, { headers: { cookie } });
    const html = await dashboard.text();
    const passed = dashboard.ok && html.includes('data-testid="protected-content"');
    return {
      passed,
      wallClockMinutes: (Date.now() - started) / 60000,
      evidence: passed ? 'credential login reached protected content' : 'protected content not observed after login',
    };
  } finally {
    await app.close();
  }
}

export function runAuthBenchmark(): AuthRow[] {
  return AUTH_LIBRARIES.map((library) => buildAuthRow(library));
}

export async function runAuthBenchmarkWithLocalSmoke(): Promise<AuthRow[]> {
  const smoke = await smokeLocalAuthFixture();
  return AUTH_LIBRARIES.map((library) => buildAuthRow(library, smoke));
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatReport(rows: AuthRow[]): string {
  const lines = [
    'Auth & Real-World Usability (#1260) — setup-cost table',
    'library         LOC   profile-attach   wall-clock minutes   smoke',
  ];
  for (const r of rows) {
    lines.push(
      [
        r.library.padEnd(14),
        String(r.loc).padStart(5),
        r.profileAttach ? '          yes' : '           no',
        r.wallClockMinutes === null ? '            (live)' : `         ${r.wallClockMinutes.toFixed(1)}`,
        r.loggedInSmoked ? '   ✓' : '   pending',
      ].join(' '),
    );
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const runLocalSmoke = argv.includes('--local-smoke') || process.env.OPENCHROME_BENCH_AUTH_LOCAL_SMOKE === '1';
  const rows = runLocalSmoke ? await runAuthBenchmarkWithLocalSmoke() : runAuthBenchmark();
  const envelope = buildResultEnvelope({
    axis: 'auth-usability',
    environment: captureEnvironment(),
    competitors: AUTH_LIBRARIES.map((lib) => ({
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
    '\nNote: --local-smoke measures the reproducible login-wall fixture without external accounts; third-party live-tier auth remains operator-provided only.\n' +
      'Ethics reminder: live-tier benchmarks must use only the operator\'s own / authorized accounts.\n' +
      'No third-party credentials may be committed to this repository.',
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Auth benchmark failed:', err);
    process.exit(1);
  });
}
