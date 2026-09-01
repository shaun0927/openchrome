#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cwd, exit } from 'node:process';

const root = cwd();

const allowedSrcRootFiles = new Map([
  ['index.ts', 'package and CLI entrypoint'],
  ['mcp-server.ts', 'compatibility shim for src/mcp/server'],
  ['session-manager.ts', 'compatibility shim for src/session/manager'],
  ['version.ts', 'compatibility shim for src/core/version'],
]);

const allowedSrcUtilsFiles = new Set([
  'format-age.ts',
  'format-error.ts',
  'log.ts',
  'retry-with-fallback.ts',
  'safe-listener.ts',
  'url-utils.ts',
]);

const allowedSrcHarnessFiles = new Set([
  'flags.ts',
]);

const allowedTestsUtilsFiles = new Set([
  'mock-cdp.ts',
  'mock-session.ts',
  'retry-with-fallback.test.ts',
  'safe-listener.test.ts',
  'test-helpers.ts',
]);

const allowedRootEntries = new Map([
  ['.dependency-cruiser.cjs', 'dependency boundary lint configuration'],
  ['.eslintrc.json', 'ESLint configuration'],
  ['.github', 'GitHub Actions automation'],
  ['.gitignore', 'Git ignore policy'],
  ['CHANGELOG.md', 'release history'],
  ['CLAUDE.md', 'host-specific contributor guidance'],
  ['CONTRIBUTING.md', 'contributor entrypoint'],
  ['LICENSE', 'package license'],
  ['README.ko.md', 'Korean README'],
  ['README.md', 'primary README'],
  ['SECURITY.md', 'security policy'],
  ['cli', 'CLI entrypoints and command adapters'],
  ['config', 'published runtime policy config'],
  ['docs', 'documentation'],
  ['jest.ci.config.js', 'CI Jest configuration'],
  ['jest.config.js', 'Jest configuration'],
  ['package-lock.json', 'npm lockfile'],
  ['package.json', 'npm package manifest'],
  ['scripts', 'maintenance and verification scripts'],
  ['src', 'shipped TypeScript runtime'],
  ['tests', 'test suites and approved shared fixtures'],
  ['tsconfig.cli.json', 'CLI TypeScript configuration'],
  ['tsconfig.json', 'runtime TypeScript configuration'],
  ['tsconfig.test.json', 'test TypeScript configuration'],
]);

const disallowedSrcDomainDirs = new Map([
  ['metrics', 'Runtime metrics primitives belong under src/core/metrics.'],
]);

const disallowedTestsDomainDirs = new Map([
  ['metrics', 'Metrics tests belong under tests/core/metrics.'],
]);

const errors = [];

function listFiles(dir) {
  return readdirSync(join(root, dir))
    .filter((entry) => statSync(join(root, dir, entry)).isFile())
    .sort();
}

function listEntries(dir) {
  return readdirSync(join(root, dir))
    .map((entry) => ({ entry, stat: statSync(join(root, dir, entry)) }))
    .sort((a, b) => a.entry.localeCompare(b.entry));
}

function listTrackedFiles(dir) {
  return execFileSync('git', ['ls-files', dir], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => {
      try {
        return statSync(join(root, file)).isFile();
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    })
    .sort();
}

function loadFixtureOwners() {
  const fixtureOwnersPath = join(root, 'tests', 'fixtures', 'OWNERS.json');
  return JSON.parse(readFileSync(fixtureOwnersPath, 'utf8'));
}

const trackedRootEntries = new Set();
for (const file of listTrackedFiles('.')) {
  const rootEntry = file.split('/')[0];
  trackedRootEntries.add(rootEntry);
}

for (const rootEntry of [...trackedRootEntries].sort()) {
  if (!allowedRootEntries.has(rootEntry)) {
    errors.push(
      `${rootEntry} is a tracked root entry without an approved repository-surface role. ` +
      'Move it under an owning folder or add the role to docs/dev/project-structure.md and this lint allow-list.',
    );
  }
}

for (const file of listFiles('src')) {
  if (!allowedSrcRootFiles.has(file)) {
    errors.push(
      `src/${file} is a root source file without an approved entrypoint/shim role. ` +
      'Move implementation code into an owning src/<domain>/ folder.',
    );
  }
}

for (const [dir, message] of disallowedSrcDomainDirs) {
  try {
    const stat = statSync(join(root, 'src', dir));
    if (stat.isDirectory()) {
      errors.push(`src/${dir} is a deprecated domain directory. ${message}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

for (const [dir, message] of disallowedTestsDomainDirs) {
  try {
    const stat = statSync(join(root, 'tests', dir));
    if (stat.isDirectory()) {
      errors.push(`tests/${dir} is a deprecated domain test directory. ${message}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

try {
  const testsSrc = statSync(join(root, 'tests', 'src'));
  if (testsSrc.isDirectory()) {
    errors.push('tests/src is not allowed. Put tests under the owning tests/<domain>/ folder.');
  }
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}

for (const { entry, stat } of listEntries('src/utils')) {
  if (stat.isDirectory()) {
    errors.push(
      `src/utils/${entry} is a utility subdirectory. ` +
      'Move domain code into an owning src/<domain>/ folder.',
    );
    continue;
  }
  if (stat.isFile() && !allowedSrcUtilsFiles.has(entry)) {
    errors.push(
      `src/utils/${entry} is not an approved leaf utility. ` +
      'Put domain-owned helpers under src/core, src/cdp, src/chrome, src/session, or src/tools.',
    );
  }
}

for (const { entry, stat } of listEntries('src/harness')) {
  if (stat.isDirectory()) {
    errors.push(
      `src/harness/${entry} is a harness subdirectory. ` +
      'Keep src/harness limited to cross-tier feature-flag bootstrap code.',
    );
    continue;
  }
  if (stat.isFile() && !allowedSrcHarnessFiles.has(entry)) {
    errors.push(
      `src/harness/${entry} is not an approved harness bootstrap file. ` +
      'Put runtime ledgers under src/core/task-ledger and run-level tooling under src/run-harness.',
    );
  }
}

for (const { entry, stat } of listEntries('tests/utils')) {
  if (stat.isDirectory()) {
    errors.push(
      `tests/utils/${entry} is a test utility subdirectory. ` +
      'Move domain tests under the matching tests/<domain>/ folder.',
    );
    continue;
  }
  if (stat.isFile() && !allowedTestsUtilsFiles.has(entry)) {
    errors.push(
      `tests/utils/${entry} is not an approved shared test helper or utility test. ` +
      'Mirror the owning production folder under tests/<domain>/.',
    );
  }
}

const fixtureOwners = loadFixtureOwners();
const ownerEntries = new Map();

for (const entry of fixtureOwners.fixtures ?? []) {
  if (!entry.path || typeof entry.path !== 'string') {
    errors.push('tests/fixtures/OWNERS.json has a fixture entry without a string path.');
    continue;
  }
  if (!entry.owner || typeof entry.owner !== 'string') {
    errors.push(`tests/fixtures/OWNERS.json entry ${entry.path} is missing an owner.`);
  }
  if (!entry.contract || typeof entry.contract !== 'string') {
    errors.push(`tests/fixtures/OWNERS.json entry ${entry.path} is missing a contract.`);
  }
  if (!entry.verification || typeof entry.verification !== 'string') {
    errors.push(`tests/fixtures/OWNERS.json entry ${entry.path} is missing verification.`);
  }
  ownerEntries.set(`tests/fixtures/${entry.path}`, entry);
}

for (const file of listTrackedFiles('tests/fixtures')) {
  if (file === 'tests/fixtures/OWNERS.json') continue;
  if (!ownerEntries.has(file)) {
    errors.push(
      `${file} is a shared fixture without an OWNERS.json entry. ` +
      'Either move it next to the owning test or declare its owner, contract, and verification.',
    );
  }
}

for (const file of ownerEntries.keys()) {
  try {
    const stat = statSync(join(root, file));
    if (!stat.isFile()) {
      errors.push(`tests/fixtures/OWNERS.json references ${file}, but it is not a file.`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      errors.push(`tests/fixtures/OWNERS.json references missing fixture ${file}.`);
    } else {
      throw error;
    }
  }
}

if (errors.length > 0) {
  console.error('Repository structure check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  exit(1);
}

console.log('Repository structure check passed.');
