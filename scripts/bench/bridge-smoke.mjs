#!/usr/bin/env node
/**
 * Cross-platform smoke for the browser-use Python bridge.
 *
 * Drives `tests/benchmark/bridges/browser_use_bridge.py` over stdio via
 * Node's child_process so the smoke does not depend on bash / printf / grep
 * being identical across ubuntu / macOS / Windows runners. The bridge's
 * protocol guarantees:
 *
 *   1. A `ping` request returns `{"ok": true, "result": {"pong": true, ...}}`
 *   2. A `shutdown` request returns `{"ok": true, "result": {"shutdown": true}}`
 *      and the process exits cleanly.
 *
 * Sprint 3 #1259 PR-15 added this script when the bridge-smoke workflow
 * expanded from ubuntu-only to a 3-OS matrix.
 */

import { spawn } from 'node:child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE = path.join(REPO_ROOT, 'tests', 'benchmark', 'bridges', 'browser_use_bridge.py');

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

const stdoutLines = [];
let stderrBuf = '';

const child = spawn(PYTHON, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) stdoutLines.push(line);
  }
});

child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString();
  process.stderr.write(chunk);
});

let readyReceived = false;
const sendReady = (resolve) => {
  // Wait until the bridge prints "browser-use bridge ready" on stderr.
  const check = () => {
    if (stderrBuf.includes('browser-use bridge ready')) {
      readyReceived = true;
      resolve();
      return;
    }
    setTimeout(check, 50);
  };
  check();
};

function send(req) {
  child.stdin.write(JSON.stringify(req) + '\n');
}

const exitCode = await new Promise((resolve) => {
  child.on('exit', (code) => resolve(code ?? 0));
  child.on('error', (err) => {
    console.error(`[bridge-smoke] spawn error: ${err.message}`);
    resolve(1);
  });

  // Drive the protocol once the bridge announces ready.
  new Promise(sendReady).then(() => {
    send({ id: 1, method: 'ping', args: {} });
    setTimeout(() => send({ id: 2, method: 'shutdown', args: {} }), 200);
  });
});

if (!readyReceived) {
  console.error('[bridge-smoke] FAILED: bridge never printed "browser-use bridge ready"');
  process.exit(1);
}

const allOutput = stdoutLines.join('\n');
if (!allOutput.includes('"pong": true')) {
  console.error('[bridge-smoke] FAILED: did not observe "pong": true');
  console.error('stdout:\n' + allOutput);
  process.exit(1);
}
if (!allOutput.includes('"shutdown": true')) {
  console.error('[bridge-smoke] FAILED: did not observe "shutdown": true');
  console.error('stdout:\n' + allOutput);
  process.exit(1);
}

console.error(`[bridge-smoke] OK on ${process.platform} (exit ${exitCode})`);
process.exit(exitCode === null ? 0 : exitCode);
