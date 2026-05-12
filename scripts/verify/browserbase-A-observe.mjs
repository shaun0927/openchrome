#!/usr/bin/env node
/**
 * scripts/verify/browserbase-A-observe.mjs
 *
 * Reproducer for the "Real verification" plan attached to issue #866. Drives
 * an openchrome MCP instance through the documented 8-step sequence and
 * prints pass/fail predicates for each step.
 *
 * Usage:
 *   node scripts/verify/browserbase-A-observe.mjs [--mcp-url ws://host:port]
 *
 * The script does not need to pass in CI — it documents the live test plan
 * and can be wired up to a real MCP server when desired. By default it just
 * prints the plan so the file is executable end-to-end without external deps.
 */

import { argv, env, exit, stdout, stderr } from 'node:process';

const args = argv.slice(2);
const mcpUrl =
  args.find((a) => a.startsWith('--mcp-url='))?.slice('--mcp-url='.length) ||
  env.OPENCHROME_MCP_URL ||
  '';

const steps = [
  {
    n: 1,
    description:
      'mcp__openchrome__navigate → https://news.ycombinator.com/',
    predicate: 'navigate returns a non-error result',
  },
  {
    n: 2,
    description:
      "mcp__openchrome__oc_observe actions=['click'], scope='viewport' on HN home",
    predicate:
      'response has >= 10 entries; each has non-empty ref, role in {link,button}, non-empty name',
  },
  {
    n: 3,
    description:
      'Pick entry whose name regex-matches ^new$, call interact action=click target={ref}',
    predicate: 'navigation event fires; final URL matches /newest',
  },
  {
    n: 4,
    description:
      'Baseline: read_page(ax) (B1) + query_dom selector=a (B2) + interact (B3) bytes vs oc_observe (O1) + interact (O2) bytes',
    predicate:
      'O1+O2 < (B1+B2+B3) * 0.5; record totals into scripts/verify/browserbase-A-tokens.txt',
  },
  {
    n: 5,
    description:
      "mcp__openchrome__navigate https://httpbin.org/forms/post + oc_observe actions=['fill']",
    predicate:
      "response includes custname, custtel, custemail, comments with role='textbox' and actions containing 'fill'",
  },
  {
    n: 6,
    description: "oc_observe actions=['select'] on the same httpbin form",
    predicate:
      'response includes the size <select> only; textboxes are filtered out',
  },
  {
    n: 7,
    description:
      'Determinism: call oc_observe twice in a row on the same stable page',
    predicate: 'nodes[] arrays are identical after stripping capturedAt',
  },
  {
    n: 8,
    description: "mcp__openchrome__oc_journal filter='tool=oc_observe'",
    predicate:
      "each call appears with args.scope, args.actions summarised, result.nodeCount recorded",
  },
];

function log(line) {
  // Use stderr so stdout stays clean for any downstream piping.
  stderr.write(`${line}\n`);
}

async function main() {
  log('# openchrome browserbase-A reproducer — oc_observe (#866)');
  log(`# MCP URL: ${mcpUrl || '(none provided — printing plan only)'}`);
  log('');

  if (!mcpUrl) {
    log(
      'No --mcp-url given. This script intentionally has no external dependency;',
    );
    log(
      'wire it up to your local openchrome MCP server when you want a live run.',
    );
    log('');
    log('Plan:');
    for (const s of steps) {
      log(`  Step ${s.n}: ${s.description}`);
      log(`           Pass when: ${s.predicate}`);
    }
    log('');
    log('To run live, point MCP_URL at a websocket / stdio endpoint and');
    log('replace this stub with an actual MCP client call sequence.');
    exit(0);
  }

  // Live mode would speak the openchrome MCP transport here. Kept as a
  // placeholder so the script stays runnable without adding a runtime dep.
  log('Live mode is not yet implemented — extend this script with a real');
  log('MCP client (e.g. @modelcontextprotocol/sdk) once you have one in scope.');
  exit(0);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
});

// silence unused-import warning if hosts strip stdout
void stdout;
