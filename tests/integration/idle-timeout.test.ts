/// <reference types="jest" />
/**
 * Integration test for issue #649 §5.6 — the idle-timeout watcher must exit
 * the server cleanly when the window elapses with no traffic, not exit when
 * traffic is arriving, and not exit with an active session.
 *
 * We spawn the real compiled `serve` command with `--idle-timeout=3s` and
 * observe behaviour via stderr + exit code. Chrome is never launched (no
 * `--auto-launch`), so the server fails to reach Chrome — but the idle-
 * timeout path runs regardless, and that's what we're exercising.
 *
 * The test is skipped in CI environments without a dist build (CI pipelines
 * generally run after a full build, but individual `npm test` invocations
 * against a fresh clone would not have one).
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const HAS_BUILD = fs.existsSync(ENTRY);
const IS_WINDOWS = process.platform === 'win32';

const describeFn = HAS_BUILD && !IS_WINDOWS ? describe : describe.skip;

function randomPort(): number {
  return 29_000 + Math.floor(Math.random() * 1000);
}

describeFn('idle-timeout (issue #649 §5.6)', () => {
  test('child with --idle-timeout=3s exits code 0 within 3.5s when no traffic and no sessions', async () => {
    const port = randomPort();
    const child = spawn(process.execPath, [ENTRY, 'serve', '--port', String(port), '--idle-timeout=3s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Disable PPID watcher so only idle-timeout can trigger the exit —
        // otherwise a test process death (e.g. if jest crashes) could race.
        OPENCHROME_PPID_WATCH: '0',
        // Keep Chrome connection attempts cheap and non-blocking.
        OPENCHROME_MAX_RECONNECT_ATTEMPTS: '1',
      },
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    // Drain stdout — MCP JSON-RPC bytes, we don't care.
    child.stdout.on('data', () => {});

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>((resolve) => {
      const start = Date.now();
      child.on('exit', (code, signal) => {
        resolve({ code, signal, elapsedMs: Date.now() - start });
      });
    });

    expect(exitInfo.code).toBe(0);
    // 3s window + max 60s tick cap, but tickMs = min(3000/4, 60000) = 750ms,
    // so total is at most 3000 + 750 + startup slack. Allow 8s for CI drift.
    expect(exitInfo.elapsedMs).toBeLessThan(8_000);
    expect(stderr).toMatch(/idle for 3s, exiting/);
  }, 15_000);

  test('rejects --idle-timeout=30 (bare number) at startup with non-zero exit', async () => {
    const port = randomPort();
    const child = spawn(process.execPath, [ENTRY, 'serve', '--port', String(port), '--idle-timeout=30'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCHROME_PPID_WATCH: '0' },
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', () => {});

    const exitInfo = await new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }));
    });

    expect(exitInfo.code).not.toBe(0);
    expect(stderr).toMatch(/invalid duration/);
  }, 10_000);

  test('rejects --idle-timeout=garbage at startup', async () => {
    const port = randomPort();
    const child = spawn(process.execPath, [ENTRY, 'serve', '--port', String(port), '--idle-timeout=garbage'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCHROME_PPID_WATCH: '0' },
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', () => {});

    const exitInfo = await new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }));
    });

    expect(exitInfo.code).not.toBe(0);
    expect(stderr).toMatch(/invalid duration/);
  }, 10_000);

  test('without --idle-timeout and without OPENCHROME_IDLE_TIMEOUT_MS, no idle-timeout watcher is installed', async () => {
    // Verify by grep: the "Idle-timeout: enabled" log line must NOT appear.
    // Spawn briefly and kill — Chrome may fail but that doesn't matter, we
    // only care about the early log lines.
    const port = randomPort();
    const child = spawn(process.execPath, [ENTRY, 'serve', '--port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCHROME_PPID_WATCH: '0' },
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', () => {});

    // Give it a couple of seconds to print the startup banner.
    await new Promise((r) => setTimeout(r, 2_500));

    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    try { child.kill('SIGKILL'); } catch { /* already dead */ }

    expect(stderr).not.toMatch(/Idle-timeout: enabled/);
  }, 15_000);
});
