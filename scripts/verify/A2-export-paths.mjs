#!/usr/bin/env node
/**
 * Export-path verifier for issue #859.
 *
 * Packs the repository, installs the tarball into a temporary project, and
 * verifies every public export promised by the embeddable-server contract:
 *   - openchrome-mcp
 *   - openchrome-mcp/server
 *   - openchrome-mcp/lifecycle
 *
 * Usage:
 *   npm run build
 *   node scripts/verify/A2-export-paths.mjs
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const workDir = mkdtempSync(join(tmpdir(), 'oc-a2-exports-'));

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? 'pipe',
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
  });
}

function fail(message) {
  console.error(`[A2-export-paths] FAIL: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const requiredExports = ['.', './server', './lifecycle'];
for (const key of requiredExports) {
  if (!pkg.exports?.[key]) {
    fail(`package.json exports is missing ${key}`);
  }
}
if (pkg.main !== 'dist/index.js') {
  fail(`package.json main changed unexpectedly: ${pkg.main}`);
}

console.log('[A2-export-paths] Packing repository...');
// The verifier is intentionally run after `npm run build`; avoid letting
// npm pack re-run prepare/build inside this bounded export check.
run('npm', ['pack', '--ignore-scripts', '--pack-destination', workDir], { stdio: 'ignore' });
const tgz = readdirSync(workDir).find((name) => name.endsWith('.tgz'));
if (!tgz) fail(`npm pack did not create a tarball in ${workDir}`);

const consumerDir = join(workDir, 'consumer');
run('mkdir', ['-p', consumerDir]);
writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));
run('npm', ['install', '--silent', join(workDir, tgz)], { cwd: consumerDir, timeout: 180_000 });

const importProbe = `
const rootUrl = import.meta.resolve('openchrome-mcp');
const serverUrl = import.meta.resolve('openchrome-mcp/server');
const lifecycleUrl = import.meta.resolve('openchrome-mcp/lifecycle');
if (!rootUrl.endsWith('/dist/index.js')) throw new Error('root export resolved unexpectedly: ' + rootUrl);
if (!serverUrl.endsWith('/dist/core/server.js')) throw new Error('server export resolved unexpectedly: ' + serverUrl);
if (!lifecycleUrl.endsWith('/dist/core/lifecycle/index.js')) throw new Error('lifecycle export resolved unexpectedly: ' + lifecycleUrl);
const server = await import('openchrome-mcp/server');
const lifecycle = await import('openchrome-mcp/lifecycle');
if (typeof server.createOpenChromeServer !== 'function') throw new Error('missing createOpenChromeServer');
if (typeof lifecycle.getLifecycleBus !== 'function') throw new Error('missing getLifecycleBus');
console.log('esm ok');
`;
writeFileSync(join(consumerDir, 'probe-import.mjs'), importProbe);
run(process.execPath, ['probe-import.mjs'], { cwd: consumerDir, stdio: 'inherit' });

const requireProbe = `
const rootPath = require.resolve('openchrome-mcp');
const serverPath = require.resolve('openchrome-mcp/server');
const lifecyclePath = require.resolve('openchrome-mcp/lifecycle');
if (!rootPath.endsWith('/dist/index.js')) throw new Error('root export resolved unexpectedly: ' + rootPath);
if (!serverPath.endsWith('/dist/core/server.js')) throw new Error('server export resolved unexpectedly: ' + serverPath);
if (!lifecyclePath.endsWith('/dist/core/lifecycle/index.js')) throw new Error('lifecycle export resolved unexpectedly: ' + lifecyclePath);
const server = require('openchrome-mcp/server');
const lifecycle = require('openchrome-mcp/lifecycle');
if (typeof server.createOpenChromeServer !== 'function') throw new Error('missing createOpenChromeServer');
if (typeof lifecycle.getLifecycleBus !== 'function') throw new Error('missing getLifecycleBus');
console.log('cjs ok');
`;
writeFileSync(join(consumerDir, 'probe-require.cjs'), requireProbe);
run(process.execPath, ['probe-require.cjs'], { cwd: consumerDir, stdio: 'inherit' });

console.log('[A2-export-paths] OK: root, server, and lifecycle exports resolve via ESM and CJS.');
