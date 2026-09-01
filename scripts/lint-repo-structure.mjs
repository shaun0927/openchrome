#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cwd, exit } from 'node:process';

const root = cwd();

const allowedSrcRootFiles = new Set([
  'index.ts',
  'mcp-server.ts',
  'session-manager.ts',
  'version.ts',
]);

const allowedSrcUtilsFiles = new Set([
  'format-age.ts',
  'format-error.ts',
  'log.ts',
  'retry-with-fallback.ts',
  'safe-listener.ts',
  'url-utils.ts',
]);

const allowedTestsUtilsFiles = new Set([
  'mock-cdp.ts',
  'mock-session.ts',
  'retry-with-fallback.test.ts',
  'safe-listener.test.ts',
  'test-helpers.ts',
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

if (errors.length > 0) {
  console.error('Repository structure check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  exit(1);
}

console.log('Repository structure check passed.');
