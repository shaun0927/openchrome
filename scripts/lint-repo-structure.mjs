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

const errors = [];

function listFiles(dir) {
  return readdirSync(join(root, dir))
    .filter((entry) => statSync(join(root, dir, entry)).isFile())
    .sort();
}

for (const file of listFiles('src')) {
  if (!allowedSrcRootFiles.has(file)) {
    errors.push(
      `src/${file} is a root source file without an approved entrypoint/shim role. ` +
      'Move implementation code into an owning src/<domain>/ folder.',
    );
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

if (errors.length > 0) {
  console.error('Repository structure check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  exit(1);
}

console.log('Repository structure check passed.');
