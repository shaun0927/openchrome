#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const command = [
  path.join(repoRoot, 'scripts', 'build-standalone-cli.cjs'),
  '--kind',
  'sidecar',
  '--output-dir',
  path.join(repoRoot, 'desktop', 'src-tauri', 'binaries'),
  ...args,
];

const result = spawnSync(process.execPath, command, { cwd: repoRoot, stdio: 'inherit' });
process.exit(result.status ?? 1);
