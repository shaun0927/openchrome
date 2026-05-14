#!/usr/bin/env node
/**
 * scripts/verify/A5-element-pick.mjs
 *
 * Reproducer plan for issue #899 (`element_pick`). It is intentionally
 * dependency-free and prints the live MCP/CDP verification sequence unless an
 * MCP transport is provided by a future harness.
 *
 * Usage:
 *   node scripts/verify/A5-element-pick.mjs [--mcp-url ws://host:port]
 */

import { argv, env, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const args = argv.slice(2);
const mcpUrl =
  args.find((a) => a.startsWith('--mcp-url='))?.slice('--mcp-url='.length) ||
  env.OPENCHROME_MCP_URL ||
  '';

const fixturePath = resolve(repoRoot, 'tests/fixtures/element-pick/index.html');
const cspFixturePath = resolve(repoRoot, 'tests/fixtures/element-pick/csp-strict.html');

const steps = [
  {
    n: 1,
    description: `Serve or navigate to file://${fixturePath}`,
    predicate: 'navigate succeeds and page title is Element Pick Fixture',
  },
  {
    n: 2,
    description: 'Call element_pick action=start timeoutMs=60000 and concurrently dispatch CDP mousePressed/mouseReleased at #pick-target center',
    predicate: 'returns success=true with selectors.cssPath containing #pick-target and boundingBox width/height > 0',
  },
  {
    n: 3,
    description: 'Assert screenshotPng is base64 PNG evidence for bbox+8px clip',
    predicate: 'screenshotPng decodes and is below 200KB',
  },
  {
    n: 4,
    description: 'Assert DOM redaction on fixture secret input when picked',
    predicate: 'domSnippet never contains fixture-secret-token and contains [REDACTED]',
  },
  {
    n: 5,
    description: 'Start element_pick timeoutMs=1000 without clicking',
    predicate: 'returns {success:false,error:"timeout"} after about 1s',
  },
  {
    n: 6,
    description: 'Start element_pick and concurrently navigate away from the same tab',
    predicate: 'navigate returns within 5s and the in-flight pick returns {success:false,error:"navigated"}',
  },
  {
    n: 7,
    description: 'Start element_pick and concurrently call oc_journal plus oc_connection_health',
    predicate: 'both calls return within 1s while the pick is pending',
  },
  {
    n: 8,
    description: `Navigate to CSP-strict fixture file://${cspFixturePath} and synthetic-click #csp-target`,
    predicate: 'element_pick succeeds despite default-src none because injection uses CDP Runtime.evaluate',
  },
];

function log(line = '') {
  stderr.write(`${line}\n`);
}

async function main() {
  log('# openchrome A5 reproducer — element_pick (#899)');
  log(`# MCP URL: ${mcpUrl || '(none provided — printing plan only)'}`);
  log('');

  if (!mcpUrl) {
    log('No --mcp-url given. This script stays runnable without adding a test dependency.');
    log('Use it as the authoritative live verification checklist for #899.');
    log('');
    for (const step of steps) {
      log(`Step ${step.n}: ${step.description}`);
      log(`  Pass when: ${step.predicate}`);
    }
    exit(0);
  }

  log('Live MCP transport execution is not implemented in this dependency-free stub.');
  log('Wire this sequence to the local MCP client harness when a reusable client is in scope.');
  exit(0);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});

void stdout;
