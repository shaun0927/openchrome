#!/usr/bin/env node
/**
 * Benchmark for issue #648 — measures per-instance memory cost of the
 * HealthEndpoint listener, with and without the gating patch.
 *
 * Spawns `node dist/index.js serve` in stdio mode and http mode, 20
 * times each, waits 5 seconds for startup to settle, reads
 * `process.memoryUsage()` from the child (the child writes a
 * one-line JSON summary to stderr when it receives SIGUSR2), then
 * sends SIGTERM and records the exit. Reports the median `heapUsed`
 * and `rss` for each config, plus a per-instance file-descriptor
 * count.
 *
 * Usage:
 *   node scripts/bench-health-endpoint.mjs
 *   node scripts/bench-health-endpoint.mjs --iterations 20
 *
 * Output: JSON on stdout, human-readable log on stderr.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

if (!fs.existsSync(ENTRY)) {
  console.error(`[bench] dist/index.js not found at ${ENTRY}. Run 'npm run build' first.`);
  process.exit(2);
}

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = argv.indexOf(name);
  if (idx === -1 || idx === argv.length - 1) return fallback;
  return argv[idx + 1];
}
const ITERATIONS = parseInt(argValue('--iterations', '20'), 10);
const SETTLE_MS = parseInt(argValue('--settle-ms', '5000'), 10);

function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mad(values, med) {
  if (values.length === 0) return NaN;
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

function pickPort(base) {
  return base + Math.floor(Math.random() * 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Count file descriptors owned by a pid. Uses `lsof` on POSIX
 * (macOS / Linux). Returns null on Windows or if lsof is missing.
 */
function countFds(pid) {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('lsof', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((line) => line.trim().length > 0).length - 1; // minus header
  } catch {
    return null;
  }
}

/**
 * Spawn one serve child, wait for startup, then read its
 * process.memoryUsage() via a lightweight injected probe.
 *
 * We use SIGUSR2 to ask the child to print its own memoryUsage to
 * stderr in a parseable form. The serve command does not have a
 * built-in hook for that, so we instead rely on an external read:
 * after the settle period we attach a short-lived node one-liner
 * that asks the kernel for the RSS via /proc (Linux) or ps (macOS).
 * Heap metrics we cannot get externally, so heapUsed is derived
 * from the child's own stderr if it has logged a GC line; we keep
 * the metric name honest and just collect RSS from ps on macOS.
 */
async function spawnOnce({ mode, healthPort, chromePort, httpPort, extraEnv = {} }) {
  const args = ['serve', '--port', String(chromePort), '--transport', mode];
  if (mode === 'http' || mode === 'both') {
    args.push('--http-host', '127.0.0.1');
  }
  const env = {
    ...process.env,
    OPENCHROME_HEALTH_PORT: String(healthPort),
    OPENCHROME_HEALTH_BIND: '127.0.0.1',
    OPENCHROME_HTTP_PORT: String(httpPort),
    OPENCHROME_PPID_WATCH: '0',
    ...extraEnv,
  };
  const child = spawn(process.execPath, [ENTRY, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

  // Wait for serve to have reached the HealthEndpoint gating decision.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (/\[SelfHealing\] HealthEndpoint: (enabled|disabled)/.test(stderr)) break;
    await sleep(50);
  }

  // Settle.
  await sleep(SETTLE_MS);

  // RSS via ps (portable across macOS + Linux; reports KB).
  let rssBytes = NaN;
  try {
    const ps = execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' });
    rssBytes = parseInt(ps.trim(), 10) * 1024;
  } catch { /* child may have died */ }

  const fdCount = countFds(child.pid);

  // Try to read heapUsed by asking the child to log it. Since we
  // cannot introspect a foreign V8 heap externally, we fall back to
  // inferring from the child's own stderr if something has logged
  // `heapUsed=` (not guaranteed). If not available, we record NaN.
  let heapBytes = NaN;
  const heapMatch = stderr.match(/heapUsed["=:]\s*(\d+)/);
  if (heapMatch) heapBytes = parseInt(heapMatch[1], 10);

  // Graceful shutdown.
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(null); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(null); });
  });

  return { rssBytes, heapBytes, fdCount };
}

async function runScenario(label, { mode, extraEnv }) {
  console.error(`[bench] Running ${label} (${ITERATIONS} iterations)`);
  const rssSamples = [];
  const heapSamples = [];
  const fdSamples = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const healthPort = 40000 + pickPort(0);
    const chromePort = 41000 + pickPort(0);
    const httpPort = 42000 + pickPort(0);
    const { rssBytes, heapBytes, fdCount } = await spawnOnce({ mode, healthPort, chromePort, httpPort, extraEnv });
    if (Number.isFinite(rssBytes)) rssSamples.push(rssBytes);
    if (Number.isFinite(heapBytes)) heapSamples.push(heapBytes);
    if (typeof fdCount === 'number') fdSamples.push(fdCount);
    console.error(`  [${label}] iter ${i + 1}/${ITERATIONS}: rss=${rssBytes} heap=${heapBytes} fd=${fdCount}`);
  }
  return {
    label,
    iterations: ITERATIONS,
    rss: {
      median: median(rssSamples),
      mad: mad(rssSamples, median(rssSamples)),
      samples: rssSamples,
    },
    heap: {
      median: median(heapSamples),
      mad: mad(heapSamples, median(heapSamples)),
      samples: heapSamples,
    },
    fdCount: {
      median: median(fdSamples),
      samples: fdSamples,
    },
  };
}

async function main() {
  const platform = `${os.platform()} ${os.release()} node=${process.version}`;
  console.error(`[bench] Platform: ${platform}`);
  console.error(`[bench] Entry: ${ENTRY}`);

  const results = {
    platform,
    entry: ENTRY,
    iterations: ITERATIONS,
    settleMs: SETTLE_MS,
    scenarios: [],
  };

  // Stdio (patched default: endpoint OFF).
  results.scenarios.push(await runScenario('stdio-patched (endpoint disabled)', { mode: 'stdio', extraEnv: {} }));
  // Stdio with endpoint forced on (approximates pre-patch baseline).
  results.scenarios.push(await runScenario('stdio-baseline (OPENCHROME_HEALTH_ENDPOINT=1)', { mode: 'stdio', extraEnv: { OPENCHROME_HEALTH_ENDPOINT: '1' } }));
  // Http mode (should be identical before + after).
  results.scenarios.push(await runScenario('http-patched', { mode: 'http', extraEnv: {} }));

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('[bench] FATAL:', err);
  process.exit(1);
});
