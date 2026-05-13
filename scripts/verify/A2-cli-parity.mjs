#!/usr/bin/env node
/**
 * CLI parity verifier for issue #859 (A2 embeddable server).
 *
 * Runs `node dist/index.js --help`, `--version`, and `serve --help`,
 * then diffs against the v1.11.0 baselines in
 * tests/fixtures/v1.11.0-cli-output/.
 *
 * Non-deterministic fields (timestamps, pids) are not present in these
 * outputs so a plain string comparison is sufficient.
 *
 * Exit 0 = parity confirmed. Exit 1 = mismatch (diffs printed).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');
const fixturesDir = join(root, 'tests', 'fixtures', 'v1.11.0-cli-output');
const distEntry = join(root, 'dist', 'index.js');

function run(...args) {
  try {
    return execFileSync(process.execPath, [distEntry, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch (err) {
    // Commander writes --help to stdout; some versions exit non-zero.
    const out = (err.stdout || '').trim();
    const errout = (err.stderr || '').trim();
    return out || errout;
  }
}

function readBaseline(name) {
  return readFileSync(join(fixturesDir, name), 'utf8').trim();
}

const checks = [
  { args: ['--help'],       fixture: 'help.txt' },
  { args: ['--version'],    fixture: 'version.txt' },
  { args: ['serve', '--help'], fixture: 'serve-help.txt' },
];

let failures = 0;

for (const { args, fixture } of checks) {
  const actual = run(...args);
  const expected = readBaseline(fixture);

  if (actual === expected) {
    console.log(`PASS  node dist/index.js ${args.join(' ')}`);
  } else {
    failures++;
    console.error(`FAIL  node dist/index.js ${args.join(' ')}`);
    // Simple line-by-line diff
    const actualLines = actual.split('\n');
    const expectedLines = expected.split('\n');
    const maxLen = Math.max(actualLines.length, expectedLines.length);
    for (let i = 0; i < maxLen; i++) {
      const a = actualLines[i] ?? '<missing>';
      const e = expectedLines[i] ?? '<missing>';
      if (a !== e) {
        console.error(`  line ${i + 1}:`);
        console.error(`  - expected: ${JSON.stringify(e)}`);
        console.error(`  + actual:   ${JSON.stringify(a)}`);
      }
    }
  }
}

if (failures === 0) {
  console.log('\nCLI parity: OK (all outputs match v1.11.0 baselines)');
  process.exit(0);
} else {
  console.error(`\nCLI parity: FAIL (${failures}/${checks.length} checks failed)`);
  process.exit(1);
}
