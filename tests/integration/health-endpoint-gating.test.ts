/// <reference types="jest" />
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/**
 * Integration tests for issue #648 — the HealthEndpoint must be gated on
 * transport mode (off for stdio by default, on for http/both) with an
 * explicit override via `OPENCHROME_HEALTH_ENDPOINT`.
 *
 * Strategy: spawn `node dist/index.js serve ...` with a high random port
 * so we never collide with another openchrome instance. Probe the port
 * with `net.Socket.connect()` + short timeout — we deliberately avoid
 * matching specific errno strings because Windows reports refused
 * connections differently from POSIX. Each scenario then gets SIGTERM'd
 * and its termination result + stderr are audited to make sure the teardown path
 * (previously `await healthEndpoint.stop()` at `src/index.ts:602`) does
 * not throw a `TypeError: Cannot read properties of null` when the
 * endpoint was never constructed.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const HAS_BUILD = fs.existsSync(ENTRY);

type ProbeResult = 'connected' | 'refused' | 'timeout';

/**
 * Probe a TCP port with a short timeout. Returns 'connected' if the
 * socket opened, 'refused' if the OS rejected the connect (any error
 * class — we do NOT match errno strings because Windows uses
 * different codes than POSIX), or 'timeout' if neither happened
 * within `timeoutMs` (treated as "nothing listening" by callers since
 * 127.0.0.1 connects don't normally hang).
 */
function probePort(port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('connected'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', () => done('refused'));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Fetch `/health` over plain HTTP on the given port. Uses Node's
 * built-in http client so chunked transfer encoding is handled for
 * us (openchrome's HealthEndpoint emits `Transfer-Encoding: chunked`
 * responses, so a naive split on `\r\n\r\n` would leave hex chunk
 * framing inside the body).
 */
function getHealth(port: number, timeoutMs = 2000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const http = require('http') as typeof import('http');
    const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`health GET timed out after ${timeoutMs}ms`));
    });
    req.once('error', reject);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLog(getLog: () => string, pattern: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(getLog())) return true;
    await sleep(100);
  }
  return false;
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean };

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode, timedOut: false };
  }

  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

type Scenario = {
  name: string;
  args: string[];
  env: Record<string, string>;
  expectBound: boolean;
  expectedLogPattern: RegExp;
};

const describeFn = HAS_BUILD ? describe : describe.skip;

describeFn('health endpoint gating (issue #648)', () => {
  const scenarios: Scenario[] = [
    {
      name: 'default stdio: health port NOT bound, log declares disabled',
      args: ['--transport', 'stdio'],
      env: {},
      expectBound: false,
      expectedLogPattern: /\[SelfHealing\] HealthEndpoint: disabled \(transport-mode default, mode=stdio;/,
    },
    {
      name: '--transport http: health port bound, /health returns 200 JSON',
      args: ['--transport', 'http'],
      env: {},
      expectBound: true,
      expectedLogPattern: /\[SelfHealing\] HealthEndpoint: enabled \(port=\d+, bind=127\.0\.0\.1, mode=http\)/,
    },
    {
      name: 'OPENCHROME_HEALTH_ENDPOINT=1 + stdio: health port bound',
      args: ['--transport', 'stdio'],
      env: { OPENCHROME_HEALTH_ENDPOINT: '1' },
      expectBound: true,
      expectedLogPattern: /\[SelfHealing\] HealthEndpoint: enabled \(port=\d+, bind=127\.0\.0\.1, mode=stdio\)/,
    },
    {
      name: 'OPENCHROME_HEALTH_ENDPOINT=0 + http: health port NOT bound',
      args: ['--transport', 'http'],
      env: { OPENCHROME_HEALTH_ENDPOINT: '0' },
      expectBound: false,
      expectedLogPattern: /\[SelfHealing\] HealthEndpoint: disabled \(forced by OPENCHROME_HEALTH_ENDPOINT=0, mode=http\)/,
    },
    {
      name: 'OPENCHROME_HEALTH_ENDPOINT=garbage + stdio: falls through to stdio default (disabled)',
      args: ['--transport', 'stdio'],
      env: { OPENCHROME_HEALTH_ENDPOINT: 'garbage' },
      expectBound: false,
      expectedLogPattern: /\[SelfHealing\] HealthEndpoint: disabled \(transport-mode default, mode=stdio;/,
    },
    {
      name: 'OPENCHROME_HEALTH_ENDPOINT=garbage + http: falls through to http default (enabled)',
      args: ['--transport', 'http'],
      env: { OPENCHROME_HEALTH_ENDPOINT: 'garbage' },
      expectBound: true,
      expectedLogPattern: /\[SelfHealing\] HealthEndpoint: enabled \(port=\d+, bind=127\.0\.0\.1, mode=http\)/,
    },
    {
      name: '--transport both: health port bound, log declares enabled mode=both',
      args: ['--transport', 'both'],
      env: {},
      expectBound: true,
      expectedLogPattern: /\[SelfHealing\] HealthEndpoint: enabled \(port=\d+, bind=127\.0\.0\.1, mode=both\)/,
    },
  ];

  // We pick a fresh high port per test to avoid colliding with the
  // developer's stray openchrome on 9090, or with a previous test run.
  const pickPort = (() => {
    let next = 38000 + Math.floor(Math.random() * 2000);
    return () => next++;
  })();

  // Pick fresh Chrome/HTTP transport ports too so parallel jest workers
  // (or a stray dev-mode openchrome on 9222/3100) never collide.
  const pickTransportPorts = (() => {
    let next = 40000 + Math.floor(Math.random() * 4000);
    return () => ({ chromePort: next++, httpPort: next++ });
  })();

  scenarios.forEach((scenario) => {
    test(scenario.name, async () => {
      const healthPort = pickPort();
      const { chromePort, httpPort } = pickTransportPorts();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCHROME_HEALTH_PORT: String(healthPort),
        OPENCHROME_HEALTH_BIND: '127.0.0.1',
        OPENCHROME_HTTP_PORT: String(httpPort),
        // Disable the parent watcher: the jest worker is our parent,
        // and we do not want the watcher racing our SIGTERM teardown.
        OPENCHROME_PPID_WATCH: '0',
        ...scenario.env,
      };

      const args = ['serve', '--port', String(chromePort), ...scenario.args];
      // Prevent the HTTP transport from also trying to grab the
      // default :3100; always point it at our random high port.
      if (scenario.args.includes('http') || scenario.args.includes('both')) {
        args.push('--http-host', '127.0.0.1');
        env.OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP = '1';
      }

      // IMPORTANT: stdin must be a *pipe* (not 'ignore'), because 'ignore'
      // hands the child a /dev/null stdin → immediate EOF → stdio
      // transport shuts down before we can probe. We deliberately never
      // write to stdin; we keep it open and closable via child.stdin.end()
      // or just let child.kill('SIGTERM') tear everything down.
      const child = spawn(process.execPath, [ENTRY, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });

      try {
        // Wait for the HealthEndpoint log line so we know the gating
        // decision has been logged before we probe. If this never
        // arrives we fail loudly with the stderr dump.
        const sawHealthLog = await waitForLog(
          () => stderr,
          /\[SelfHealing\] HealthEndpoint: (enabled|disabled)/,
          15_000,
        );
        if (!sawHealthLog) {
          throw new Error(`HealthEndpoint log line never appeared. stderr so far:\n${stderr}\nstdout:\n${stdout}`);
        }

        // Exactly one declaration per startup (criterion #5).
        const occurrences = (stderr.match(/\[SelfHealing\] HealthEndpoint:/g) || []).length;
        expect(occurrences).toBe(1);

        // Expected wording.
        expect(stderr).toMatch(scenario.expectedLogPattern);

        // Wait for the listener to actually bind() on the enabled path.
        // Slow CI runners (especially ubuntu-20 with --transport=both) need
        // more than a fixed 500ms after the log line — bind() happens slightly
        // after the SelfHealing log on those machines. Poll instead of guess.
        let probe: 'connected' | 'refused' | 'timeout' = 'refused';
        if (scenario.expectBound) {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            probe = await probePort(healthPort, 300);
            if (probe === 'connected') break;
            await sleep(150);
          }
        } else {
          probe = await probePort(healthPort, 500);
        }
        if (scenario.expectBound) {
          expect(probe).toBe('connected');
          // And the payload should be the daemon's own /health JSON.
          const { status, body } = await getHealth(healthPort, 2000);
          expect(status).toBe(200);
          const parsed = JSON.parse(body);
          expect(typeof parsed.status).toBe('string');
          expect(typeof parsed.uptime).toBe('number');
          expect(parsed.memory).toBeDefined();
        } else {
          // 'refused' on POSIX, 'timeout' is also acceptable on systems
          // where the OS silently drops packets to unbound 127.0.0.1
          // ports. 'connected' is the failure condition.
          expect(probe).not.toBe('connected');
        }

        // Graceful shutdown audit (criterion #6): SIGTERM must terminate cleanly
        // and must NOT produce a TypeError for the stdio case where
        // healthEndpoint === null.
        child.kill('SIGTERM');
        const shutdownTimeoutMs = 30_000;
        const exit = await waitForExit(child, shutdownTimeoutMs);
        expect(exit.timedOut).toBe(false);
        // Node may report a clean SIGTERM shutdown as either code=0 or
        // code=null/signal=SIGTERM depending on platform and timing.
        expect(exit.code === 0 || exit.signal === 'SIGTERM').toBe(true);
        expect(stderr).not.toMatch(/TypeError/);
        expect(stderr).not.toMatch(/Cannot read properties of null/);
        expect(stderr).not.toMatch(/UnhandledPromiseRejection/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          await waitForExit(child, 2000);
        }
      }
    }, 45_000);
  });
});
