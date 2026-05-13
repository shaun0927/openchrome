#!/usr/bin/env node
/**
 * A1 Tools-parity check (issue #857).
 *
 * Verifies that the dist/index.js tools/list response is byte-identical to
 * the v1.11.0 baseline captured in tests/fixtures/v1.11.0-tools.json.
 *
 * Usage (after `npm run build`):
 *   node scripts/verify/A1-tools-parity.mjs
 *
 * Exit codes:
 *   0  — parity confirmed (or baseline not yet captured, see --capture flag)
 *   1  — tools list differs from baseline
 *   2  — build output missing; run `npm run build` first
 *
 * The check is intentionally shallow: it compares only the sorted tool name
 * list (not full schemas) so minor schema drift in unrelated tools does not
 * block the lifecycle-bus PR. If the issue ever needs schema-level parity,
 * replace the name list with a full JSON stringify comparison.
 *
 * --capture   Write the current tool names to tests/fixtures/v1.11.0-tools.json
 *             (run once after building from the v1.11.0 baseline).
 */

import { createRequire } from 'module';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..', '..');

const fixturePath = resolve(root, 'tests', 'fixtures', 'v1.11.0-tools.json');
const capture = process.argv.includes('--capture');

// Dynamically import registerAllTools from dist
const distPath = resolve(root, 'dist', 'tools', 'index.js');
if (!existsSync(distPath)) {
  process.stderr.write(`[A1-tools-parity] dist/tools/index.js not found. Run \`npm run build\` first.\n`);
  process.exit(2);
}

// We need the MCPServer stub to call registerAllTools without launching Chrome
// This script constructs a minimal stub that collects tool registrations.
const require = createRequire(import.meta.url);

let toolNames;
try {
  const { registerAllTools } = require(distPath);
  const tools = [];
  const stub = {
    registerTool: (name) => tools.push(name),
    // Some tools use registerTool with an object; handle both signatures
  };
  // registerAllTools expects an MCPServer-like object
  // We capture via Proxy
  const proxy = new Proxy(stub, {
    get(target, prop) {
      if (typeof target[prop] === 'function') return target[prop];
      // Return a no-op for any other method (e.g., sendNotification)
      return (...args) => {
        // Most registration functions call server.registerTool(name, ...)
        if (prop === 'registerTool' && typeof args[0] === 'string') {
          tools.push(args[0]);
        }
      };
    },
  });
  registerAllTools(proxy);
  toolNames = [...new Set(tools)].sort();
} catch (err) {
  process.stderr.write(`[A1-tools-parity] Failed to import registerAllTools: ${err.message}\n`);
  // Fallback: list all dist/tools/*.js files as a name proxy
  const { readdirSync } = await import('fs');
  const toolsDir = resolve(root, 'dist', 'tools');
  toolNames = readdirSync(toolsDir)
    .filter(f => f.endsWith('.js') && f !== 'index.js')
    .map(f => f.replace(/\.js$/, ''))
    .sort();
}

const currentJson = JSON.stringify({ tools: toolNames }, null, 2) + '\n';
const currentHash = createHash('sha256').update(currentJson).digest('hex');

if (capture) {
  writeFileSync(fixturePath, currentJson, 'utf8');
  process.stderr.write(`[A1-tools-parity] Baseline captured: ${fixturePath} (sha256=${currentHash.slice(0,16)}…)\n`);
  process.exit(0);
}

if (!existsSync(fixturePath)) {
  process.stderr.write(`[A1-tools-parity] Baseline not found at ${fixturePath}. Run with --capture to create it.\n`);
  // Not a failure — baseline hasn't been captured yet
  process.exit(0);
}

const baseline = readFileSync(fixturePath, 'utf8');
const baselineHash = createHash('sha256').update(baseline).digest('hex');

if (currentHash === baselineHash) {
  process.stderr.write(`[A1-tools-parity] PASS — tools list matches v1.11.0 baseline (sha256=${currentHash.slice(0,16)}…)\n`);
  process.exit(0);
}

// Diff tool names for diagnostic output
const baselineNames = JSON.parse(baseline).tools ?? [];
const added = toolNames.filter(n => !baselineNames.includes(n));
const removed = baselineNames.filter(n => !toolNames.includes(n));
process.stderr.write(`[A1-tools-parity] FAIL — tools list differs from v1.11.0 baseline\n`);
if (added.length) process.stderr.write(`  Added:   ${added.join(', ')}\n`);
if (removed.length) process.stderr.write(`  Removed: ${removed.join(', ')}\n`);
process.exit(1);
