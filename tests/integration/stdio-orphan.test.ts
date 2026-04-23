/// <reference types="jest" />
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Integration test for issue #644 — parent-process watcher must terminate
 * an orphaned stdio openchrome server within a few seconds.
 *
 * Topology:
 *   test (jest)
 *     ├─ keeper (node child holding the write-end of a FIFO open forever)
 *     └─ intermediate bash (the future "killed parent")
 *           └─ openchrome stdio server, with stdin <- FIFO
 *
 * The FIFO + keeper are required so killing the bash does NOT close
 * openchrome's stdin. Without that, the existing stdin-EOF defense in
 * src/transports/stdio.ts would terminate the server and we would not be
 * exercising the new parent-watcher at all.
 *
 * After bash is SIGKILLed, openchrome's stdin remains open (the keeper
 * still holds the writer end) so the only viable exit path is the
 * parent-watcher detecting that the saved parent pid (bash) is gone.
 */

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const HAS_BUILD = fs.existsSync(ENTRY);
const IS_WINDOWS = process.platform === 'win32';
const HAS_MKFIFO = !IS_WINDOWS && spawnSync('which', ['mkfifo']).status === 0;

const describeFn = HAS_BUILD && !IS_WINDOWS && HAS_MKFIFO ? describe : describe.skip;

describeFn('stdio orphan cleanup (issue #644)', () => {
  test('orphaned openchrome stdio server exits within 5s after parent dies', async () => {
    const port = 19222 + Math.floor(Math.random() * 1000);
    const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-orphan-'));
    const pidFile = path.join(pidDir, 'server.pid');
    const logFile = path.join(pidDir, 'server.log');
    const fifoPath = path.join(pidDir, 'stdin.fifo');

    spawnSync('mkfifo', [fifoPath]);

    // Keeper: holds the writer end of the FIFO open so the server's stdin
    // does not EOF when the intermediate bash dies.
    const keeper = spawn(
      process.execPath,
      ['-e', `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(fifoPath)},'w');setInterval(()=>{},60_000);`],
      { stdio: 'ignore' },
    );

    // Give the keeper a moment to open the FIFO writer.
    await new Promise((r) => setTimeout(r, 200));

    // Intermediate bash: spawns the server in background, records its pid,
    // then sleeps. This bash will be the server's ppid until we kill it.
    const intermediateScript = [
      'set -e',
      `node "${ENTRY}" serve --port ${port} <"${fifoPath}" >>"${logFile}" 2>&1 &`,
      `echo $! > "${pidFile}"`,
      'sleep 3600',
    ].join('\n');

    const intermediate = spawn('bash', ['-c', intermediateScript], {
      stdio: 'ignore',
      detached: false,
      env: {
        ...process.env,
        OPENCHROME_PPID_WATCH_INTERVAL_MS: '500',
      },
    });

    try {
      // Wait for the server pid file.
      let serverPid: number | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const raw = fs.readFileSync(pidFile, 'utf8').trim();
          const parsed = parseInt(raw, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            serverPid = parsed;
            break;
          }
        } catch { /* file not yet present */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!serverPid) {
        throw new Error('server pid was not written by intermediate launcher');
      }

      expect(isAlive(serverPid)).toBe(true);

      // Wait until the watcher actually installs — we only count a watcher-
      // induced death, not a startup crash.
      const watcherInstalled = await (async () => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try {
            const log = fs.readFileSync(logFile, 'utf8');
            if (log.includes('Parent watcher: enabled')) return true;
            if (log.includes('Parent watcher: skipped')) {
              throw new Error(`watcher unexpectedly skipped (ppid was already <=1)`);
            }
          } catch (err) {
            if (err instanceof Error && err.message.includes('skipped')) throw err;
            /* file not yet readable */
          }
          if (!isAlive(serverPid)) return false;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      })();

      if (!watcherInstalled) {
        const log = (() => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return '<no log>'; } })();
        throw new Error(`watcher install line never appeared. server log:\n${log}`);
      }

      // Kill the intermediate bash. The server's saved parentPid now points
      // to a dead process; its FIFO stdin stays open thanks to the keeper.
      intermediate.kill('SIGKILL');

      // Watcher polls every 500ms (env override above). Allow generous
      // headroom for the next tick + ~1s for graceful exit.
      const died = await waitForDead(serverPid, 8000);
      if (!died) {
        const log = (() => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return '<no log>'; } })();
        throw new Error(`server pid ${serverPid} still alive 8s after parent died. server log:\n${log}`);
      }
      expect(died).toBe(true);
    } finally {
      try { intermediate.kill('SIGKILL'); } catch { /* already dead */ }
      try { keeper.kill('SIGKILL'); } catch { /* ignore */ }
      // Give signals a moment to settle before unlinking the FIFO.
      await new Promise((r) => setTimeout(r, 100));
      try { fs.rmSync(pidDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 30_000);
});
