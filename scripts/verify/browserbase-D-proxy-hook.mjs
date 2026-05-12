#!/usr/bin/env node
/**
 * Reproducer script for issue #874 (browserbase adoption D — oc_proxy_hook).
 *
 * Walks the "Real verification" steps from the issue body against a live
 * openchrome MCP server. Requires:
 *
 *   - A local HTTP proxy on 127.0.0.1:8888 (the verification text uses
 *     `tinyproxy`; any HTTP-CONNECT-capable proxy works).
 *   - openchrome started with `--pilot` AND `OPENCHROME_PROXY_HOOK=1`.
 *   - MCP_PROXY_TINY_HOST / MCP_PROXY_TINY_PORT env override for non-default
 *     proxy hosts.
 *   - The Anthropic-style MCP CLI on PATH (any MCP client works — the script
 *     just shells out to it as `mcp-cli call`).
 *
 * This file is committed for reproducibility; it does NOT run in CI. The
 * unit-test coverage of the egress invariant lives in
 * `tests/pilot/proxy/egress.test.ts`.
 */

import { spawn } from 'node:child_process';
import { promisify } from 'node:util';

const sleep = promisify(setTimeout);

const TINY_HOST = process.env.MCP_PROXY_TINY_HOST ?? '127.0.0.1';
const TINY_PORT = process.env.MCP_PROXY_TINY_PORT ?? '8888';
const TINY_UPSTREAM = `http://${TINY_HOST}:${TINY_PORT}`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
  });
}

async function mcp(tool, args) {
  const { stdout } = await run('mcp-cli', [
    'call',
    `mcp__openchrome__${tool}`,
    '--args',
    JSON.stringify(args),
  ]);
  return JSON.parse(stdout);
}

async function main() {
  console.error('[browserbase-D] step 1: sanity-check the local proxy');
  await run('curl', ['-x', TINY_UPSTREAM, 'https://example.com', '-I', '--max-time', '5']);

  console.error('[browserbase-D] step 2: openchrome must be running with --pilot OPENCHROME_PROXY_HOOK=1');
  console.error('[browserbase-D] step 3: apply rule');
  const apply = await mcp('oc_proxy_hook', {
    action: 'apply',
    rules: [
      { originPattern: 'https://example.com', upstream: TINY_UPSTREAM, ruleTag: 'local-tiny' },
    ],
  });
  if (!apply.ok) throw new Error(`apply failed: ${JSON.stringify(apply)}`);
  console.error('  apply OK');

  console.error('[browserbase-D] step 4: navigate via openchrome (request should route through tinyproxy)');
  await mcp('navigate', { url: 'https://example.com' });

  console.error('[browserbase-D] step 5: inspect tinyproxy access log (manual)');
  console.error('  → tail /var/log/tinyproxy/tinyproxy.log; expect an entry for example.com');

  console.error('[browserbase-D] step 6: clear');
  const clear = await mcp('oc_proxy_hook', { action: 'clear' });
  if (!clear.ok) throw new Error(`clear failed: ${JSON.stringify(clear)}`);

  console.error('[browserbase-D] step 7: re-navigate; tinyproxy log MUST NOT receive a new entry');
  await mcp('navigate', { url: 'https://example.com' });

  console.error('[browserbase-D] step 8: offline-upstream apply (host owns the upstream lifecycle)');
  const offlineApply = await mcp('oc_proxy_hook', {
    action: 'apply',
    rules: [
      { originPattern: 'https://example.com', upstream: 'http://127.0.0.1:1', ruleTag: 'offline' },
    ],
  });
  if (!offlineApply.ok) throw new Error('apply against offline upstream MUST succeed');
  console.error('  apply succeeds even with offline upstream — invariant I1 holds in the field');

  console.error('[browserbase-D] step 9: re-clear');
  await mcp('oc_proxy_hook', { action: 'clear' });

  console.error('[browserbase-D] step 10: pilot-off — restart openchrome WITHOUT --pilot, expect MCP "unknown tool"');
  console.error('  (manual step; verifies invariant I4)');

  await sleep(50);
  console.error('[browserbase-D] all reproducer steps complete');
}

main().catch((err) => {
  console.error('[browserbase-D] FAILED:', err);
  process.exitCode = 1;
});
