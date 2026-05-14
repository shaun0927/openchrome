/**
 * Integration test for `openchrome doctor --json`
 * Runs the doctor command as a subprocess and validates the DoctorReport shape.
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import type { DoctorReport } from '../../src/cli/doctor';

const DIST_INDEX = path.join(__dirname, '../../dist/index.js');

// All check IDs that must appear in the report (network-remote is excluded by default)
const REQUIRED_CHECK_IDS = [
  'node-version',
  'home-writable',
  'chrome-binary',
  'chrome-port',
  'pid-lock',
  'orphan-chrome',
  'profile-lock',
  'disk-space',
  'macos-perms',
  'network-local',
  'optional-deps',
];

// Run the doctor command using the compiled dist output
function runDoctorJson(): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(process.execPath, [DIST_INDEX, 'doctor', '--json'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('openchrome doctor --json', () => {
  let report: DoctorReport;
  let exitCode: number;

  beforeAll(() => {
    // Skip if dist not built
    const fs = require('fs');
    if (!fs.existsSync(DIST_INDEX)) {
      console.warn('dist/index.js not found — skipping doctor integration test (run npm run build first)');
      return;
    }
    const result = runDoctorJson();
    exitCode = result.exitCode;
    try {
      report = JSON.parse(result.stdout) as DoctorReport;
    } catch (err) {
      throw new Error(`Failed to parse doctor JSON output: ${err}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
  });

  test('parses as valid DoctorReport', () => {
    const fs = require('fs');
    if (!fs.existsSync(DIST_INDEX)) return;
    expect(report).toBeDefined();
    expect(typeof report.openchromeVersion).toBe('string');
    expect(typeof report.platform).toBe('string');
    expect(typeof report.arch).toBe('string');
    expect(typeof report.nodeVersion).toBe('string');
    expect(typeof report.startedAt).toBe('string');
    expect(Array.isArray(report.results)).toBe(true);
    expect(typeof report.summary).toBe('object');
    expect([0, 1, 2]).toContain(report.exitCode);
  });

  test('all required check ids are present', () => {
    const fs = require('fs');
    if (!fs.existsSync(DIST_INDEX)) return;
    const ids = report.results.map(r => r.id);
    for (const id of REQUIRED_CHECK_IDS) {
      expect(ids).toContain(id);
    }
  });

  test('summary counts match results', () => {
    const fs = require('fs');
    if (!fs.existsSync(DIST_INDEX)) return;
    const computed = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const r of report.results) {
      computed[r.status]++;
    }
    expect(report.summary).toEqual(computed);
  });

  test('each result has required fields', () => {
    const fs = require('fs');
    if (!fs.existsSync(DIST_INDEX)) return;
    for (const result of report.results) {
      expect(typeof result.id).toBe('string');
      expect(typeof result.title).toBe('string');
      expect(['ok', 'warn', 'fail', 'skip']).toContain(result.status);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('exit code matches summary', () => {
    const fs = require('fs');
    if (!fs.existsSync(DIST_INDEX)) return;
    const expectedExit = report.summary.fail > 0 ? 2 : report.summary.warn > 0 ? 1 : 0;
    expect(report.exitCode).toBe(expectedExit);
    expect(exitCode).toBe(expectedExit);
  });

  test('network-remote check is absent by default', () => {
    const fs = require('fs');
    if (!fs.existsSync(DIST_INDEX)) return;
    const ids = report.results.map(r => r.id);
    expect(ids).not.toContain('network-remote');
  });

  test('CI matrix: command exits without crashing on this platform', () => {
    const fs = require('fs');
    if (!fs.existsSync(DIST_INDEX)) return;
    // Exit code 0 (all ok) or 1 (warn) are acceptable on a clean runner.
    // Exit code 2 is acceptable when Chrome is absent (common in CI).
    expect([0, 1, 2]).toContain(exitCode);
  });
});
