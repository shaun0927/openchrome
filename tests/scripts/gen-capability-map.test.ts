/**
 * Tests for scripts/gen-capability-map.ts
 *
 * Verifies the generator produces deterministic, size-bounded output
 * that does not include the synthetic expand_tools hint.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'docs', 'agent', 'capability-map.md');
const MAX_BYTES = 6144;

function runGenerator(): Buffer {
  execSync('npm run gen:capability-map', {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  return fs.readFileSync(OUTPUT_PATH);
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('gen-capability-map', () => {
  beforeAll(() => {
    // Ensure the file exists before tests run (first run)
    runGenerator();
  });

  test('output is byte-identical on two consecutive runs', () => {
    const first = runGenerator();
    const second = runGenerator();
    expect(sha256(first)).toBe(sha256(second));
  });

  test('file size is at most 6144 bytes', () => {
    const buf = fs.readFileSync(OUTPUT_PATH);
    expect(buf.byteLength).toBeLessThanOrEqual(MAX_BYTES);
  });

  test('expand_tools is not present in output', () => {
    const content = fs.readFileSync(OUTPUT_PATH, 'utf8');
    expect(content).not.toContain('expand_tools');
  });

  test('generated file contains the do-not-edit comment', () => {
    const content = fs.readFileSync(OUTPUT_PATH, 'utf8');
    expect(content).toContain('do not edit');
  });

  test('all expected categories appear at least once', () => {
    const content = fs.readFileSync(OUTPUT_PATH, 'utf8');
    const expectedCategories = [
      'navigation',
      'dom',
      'interact',
      'forms',
      'lifecycle',
      'observability',
    ];
    for (const cat of expectedCategories) {
      expect(content).toContain(`## ${cat}`);
    }
  });

  test('pilot tools are present with pilot marker', () => {
    const content = fs.readFileSync(OUTPUT_PATH, 'utf8');
    expect(content).toContain('oc_pilot_handoff_create');
    expect(content).toContain('— pilot');
  });

  test('file ends with exactly one newline', () => {
    const content = fs.readFileSync(OUTPUT_PATH, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
  });
});
