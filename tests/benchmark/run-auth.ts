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
 *   - Wall-clock minutes from "Chrome installed, creds in hand" to "first
 *     authenticated task passes" — this measurement requires live driver
 *     wiring and is reported as `wallClockMinutes: null` today with the
 *     `live-only` annotation so the table never shows a fabricated 0.
 *   - profileAttach: boolean — true when the library can inherit a real
 *     Chrome profile's session (OpenChrome via `list_profiles`); false
 *     when it requires explicit storageState / userDataDir wiring.
 *
 * The actual logged-in-task-success measurement requires the live driver
 * to drive the fixture and run a smoke task; that lands in a follow-up.
 * Today the runner reports the LOC + profile-attach table + a clear
 * "live measurement pending" annotation so a reader cannot mistake the
 * absence for a 0.
 *
 *   npm run bench:auth
 */

import * as fs from 'fs';
import * as path from 'path';

import { countLoc } from './auth-setup-scripts/loc-counter';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';

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

function buildAuthRow(library: AuthLibrary): AuthRow {
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
    wallClockMinutes: null,
    loggedInSmoked: false,
    note: meta.note,
  };
}

export function runAuthBenchmark(): AuthRow[] {
  return AUTH_LIBRARIES.map(buildAuthRow);
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

export function main(): void {
  const rows = runAuthBenchmark();
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
    '\nNote: wall-clock minutes + logged-in smoke require the live driver and ship in a follow-up.\n' +
      'Ethics reminder: live-tier benchmarks must use only the operator\'s own / authorized accounts.\n' +
      'No third-party credentials may be committed to this repository.',
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Auth benchmark failed:', err);
    process.exit(1);
  }
}
