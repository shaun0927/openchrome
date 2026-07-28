#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const REQUEST_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--binary') options.binary = path.resolve(argv[++index]);
    else if (arg === '--chrome') options.chrome = path.resolve(argv[++index]);
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function findChrome(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.OPENCHROME_TEST_CHROME,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function freeOpenChromePort() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await freePort();
    const hasPidCollision = Array.from({ length: 5 }, (_, offset) => port + offset).some((candidate) => (
      fs.existsSync(path.join(os.tmpdir(), `openchrome-${candidate}.pid`)) ||
      fs.existsSync(path.join(os.tmpdir(), `openchrome-chrome-${candidate}.pid`))
    ));
    if (!hasPidCollision) return port;
  }
  throw new Error('Could not reserve a CDP port without stale OpenChrome PID metadata.');
}

function waitForLog(getLog, pattern, child) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (pattern.test(getLog())) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`OpenChrome exited before readiness (code ${child.exitCode}).`));
        return;
      }
      if (Date.now() - startedAt >= STARTUP_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for OpenChrome readiness.\n${getLog().split('\n').slice(-20).join('\n')}`));
      }
    }, 100);
    timer.unref();
  });
}

function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for OpenChrome shutdown.')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForPortClosed(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Managed Chrome still responds on CDP port ${port} after oc_stop.`);
}

class StdioRpcClient {
  constructor(child, stderrTail) {
    if (!child.stdin || !child.stdout) throw new Error('Failed to open MCP stdio pipes.');
    this.child = child;
    this.stderrTail = stderrTail;
    this.pending = new Map();
    this.nextId = 1;
    this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      waiter.resolve(message);
    });
    child.once('exit', (code, signal) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(
          `OpenChrome exited during ${waiter.label} (code=${code}, signal=${signal}).\n${this.stderrTail()}`,
        ));
      }
      this.pending.clear();
    });
  }

  request(method, params, label = method) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${label}.\n${this.stderrTail()}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        label,
        resolve: (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`${label} failed: ${message.error.message}`));
          else resolve(message.result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.rl.close();
  }
}

function toolTexts(result, name) {
  if (!result || result.isError) throw new Error(`${name} returned an MCP tool error: ${JSON.stringify(result)}`);
  const texts = (result.content || [])
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text);
  if (texts.length === 0) throw new Error(`${name} returned no text content.`);
  return texts;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}; payload=${value.slice(0, 1000)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/verify-standalone-browser-smoke.cjs --binary <path> [--chrome <path>]\n');
    return;
  }
  if (!options.binary || !fs.existsSync(options.binary)) throw new Error('--binary must name an existing executable.');
  const chrome = findChrome(options.chrome);
  if (!chrome) throw new Error('Chrome was not found; pass --chrome or set OPENCHROME_TEST_CHROME.');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-standalone-live-'));
  const home = path.join(tmp, 'home');
  const userDataDir = path.join(tmp, 'chrome-profile');
  const lockDir = path.join(tmp, 'locks');
  const brokerDir = path.join(tmp, 'brokers');
  for (const dir of [home, userDataDir, lockDir, brokerDir]) fs.mkdirSync(dir, { recursive: true });

  const fixtureBody = '<!doctype html><html><head><title>Standalone CLI live smoke</title></head><body><main><h1>Standalone CLI live smoke</h1><button id="fixture-ready">Fixture ready</button></main></body></html>';
  let fixtureRequests = 0;
  const fixtureServer = http.createServer((_request, response) => {
    fixtureRequests++;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(fixtureBody),
      connection: 'close',
    });
    response.end(fixtureBody);
  });
  const fixturePort = await listen(fixtureServer);
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
  const fixtureProbe = await fetch(fixtureUrl);
  if (!fixtureProbe.ok || !(await fixtureProbe.text()).includes('Fixture ready')) {
    throw new Error('Controlled fixture preflight failed.');
  }
  const cdpPort = await freeOpenChromePort();
  const systemPath = process.platform === 'win32'
    ? 'C:\\Windows\\System32;C:\\Windows'
    : '/usr/bin:/bin:/usr/sbin:/sbin';
  const cleanEnv = {
    ...process.env,
    PATH: systemPath,
    HOME: home,
    CHROME_PATH: chrome,
    OPENCHROME_TEST_CHROME: chrome,
    OPENCHROME_UPDATE_CHECK: '0',
    OPENCHROME_PPID_WATCH: '0',
    OPENCHROME_AUTO_ELECT: '0',
    OPENCHROME_HEALTH_ENDPOINT: '0',
    OPENCHROME_RECOVERY_LEDGER: '0',
    OPENCHROME_CONTROLLER_LOCK_DIR: lockDir,
    OPENCHROME_BROKER_REGISTRY_DIR: brokerDir,
    OPENCHROME_PROCESS_WATCHDOG_INTERVAL_MS: '60000',
    OPENCHROME_TAB_HEALTH_PROBE_INTERVAL_MS: '60000',
  };

  const doctor = spawnSync(options.binary, [
    'doctor', '--json',
    '--check', 'chrome-binary',
    '--check', 'home-writable',
  ], { encoding: 'utf8', env: cleanEnv, timeout: 30_000 });
  if (doctor.status !== 0) {
    throw new Error(`Standalone doctor failed (${doctor.status}): ${doctor.stderr || doctor.stdout}`);
  }
  const doctorReport = parseJson(doctor.stdout, 'doctor --json');

  let child;
  let rpc;
  let stderr = '';
  try {
    child = spawn(options.binary, [
      'serve',
      '--server-mode',
      '--no-auto-elect',
      '--port', String(cdpPort),
      '--user-data-dir', userDataDir,
      '--chrome-binary', chrome,
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnv, detached: process.platform !== 'win32' });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (process.env.OPENCHROME_STANDALONE_DEBUG === '1') process.stderr.write(text);
    });
    rpc = new StdioRpcClient(child, () => stderr.split('\n').slice(-20).join('\n'));

    await waitForLog(() => stderr, /STDIO transport enabled/, child);
    await rpc.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'openchrome-standalone-live-smoke', version: '1' },
    });
    rpc.notify('notifications/initialized');

    const navigateResult = await rpc.request('tools/call', {
      name: 'navigate',
      arguments: { url: fixtureUrl, autoFallback: false },
    }, 'navigate controlled fixture');
    const navigatePayload = parseJson(toolTexts(navigateResult, 'navigate controlled fixture')[0], 'navigate controlled fixture');
    if (!navigatePayload.tabId || navigatePayload.url !== fixtureUrl) {
      throw new Error(`navigate did not return the controlled fixture target: ${JSON.stringify(navigatePayload)}`);
    }

    const readResult = await rpc.request('tools/call', {
      name: 'read_page',
      arguments: { tabId: navigatePayload.tabId, mode: 'dom', depth: 4, filter: 'all' },
    });
    const readText = toolTexts(readResult, 'read_page').join('\n');
    if (!readText.includes('Standalone CLI live smoke') || !readText.includes('Fixture ready')) {
      throw new Error(`read_page did not contain the controlled fixture markers: ${readText.slice(0, 1000)}`);
    }

    child.stdin.end();
    const exit = await waitForExit(child);
    if (exit.code !== 0) throw new Error(`OpenChrome exited with code ${exit.code} signal ${exit.signal}.`);
    await waitForPortClosed(cdpPort);

    const chromeVersion = spawnSync(chrome, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      binary: options.binary,
      chrome: chromeVersion.stdout.trim() || chrome,
      fixtureUrl,
      tabId: navigatePayload.tabId,
      fixtureRequests,
      doctorSummary: doctorReport.summary,
      readBytes: Buffer.byteLength(readText),
      cleanShutdown: true,
    }, null, 2)}\n`);
  } finally {
    rpc?.close();
    if (child && child.exitCode === null) {
      if (process.env.OPENCHROME_STANDALONE_DEBUG === '1') {
        console.error('[standalone-live-smoke] Cleanup is sending SIGTERM to OpenChrome');
      }
      child.kill('SIGTERM');
      try {
        await waitForExit(child, 5_000);
      } catch {
        child.kill('SIGKILL');
      }
    }
    await new Promise((resolve) => fixtureServer.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      console.error(`[standalone-live-smoke] Temporary cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error(`[standalone-live-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
