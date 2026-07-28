#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const root = resolve(new URL('../..', import.meta.url).pathname);
const entry = join(root, 'dist', 'index.js');
const timeoutMs = Number(process.env.OPENCHROME_AUTO_ELECT_SMOKE_TIMEOUT_MS || 60000);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function allocPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close((err) => err ? reject(err) : resolve(addr.port));
    });
  });
}

function start(name, args, env) {
  const child = spawn(process.execPath, [entry, 'serve', ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.name = name;
  child.stderrText = '';
  child.stdoutText = '';
  child.stderr.on('data', (b) => { child.stderrText += b.toString(); });
  child.stdout.on('data', (b) => { child.stdoutText += b.toString(); });
  return child;
}

async function waitFor(label, fn, ms = timeoutMs) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function readOnlyMetadata(registryDir) {
  const files = readdirSync(registryDir).filter((name) => name.endsWith('.json'));
  if (files.length !== 1) return null;
  return JSON.parse(readFileSync(join(registryDir, files[0]), 'utf8'));
}

function sendRpc(child, id, method, params = {}) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

function jsonLines(text) {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function waitForRpc(child, id, label) {
  return waitFor(label, () => jsonLines(child.stdoutText).find((message) => message.id === id));
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function liveManagedChromeRootCount(port) {
  if (process.platform === 'win32') return null;
  const output = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
  return output.split('\n').filter((line) =>
    line.includes(`--remote-debugging-port=${port}`) && !line.includes('--type='),
  ).length;
}

async function terminate(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await sleep(500);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'openchrome-auto-elect-'));
  const userDataDir = join(tmp, 'profile');
  const homeDir = join(tmp, 'home');
  const registryDir = join(tmp, 'brokers');
  const lockDir = join(tmp, 'locks');
  mkdirSync(homeDir, { recursive: true });
  const cdpPort = await allocPort();
  const httpPort = await allocPort();
  const env = {
    HOME: homeDir,
    OPENCHROME_BROKER_REGISTRY_DIR: registryDir,
    OPENCHROME_CONTROLLER_LOCK_DIR: lockDir,
    OPENCHROME_PPID_WATCH: '0',
    OPENCHROME_HEALTH_ENDPOINT: '0',
    OPENCHROME_LOCK_HEARTBEAT_INTERVAL_MS: '1000',
    OPENCHROME_LOCK_TAKEOVER_GRACE_MS: '2500',
    OPENCHROME_LOCK_PROBE_ATTEMPTS: '1',
    OPENCHROME_LOCK_PROBE_INTERVAL_MS: '0',
    OPENCHROME_RECOVERY_LEDGER: '0',
  };
  const baseArgs = ['--auto-launch', '--headless', '--port', String(cdpPort), '--user-data-dir', userDataDir, '--http', String(httpPort), '--http-host', '127.0.0.1'];
  const children = [];

  try {
    const owner = start('owner', baseArgs, env);
    children.push(owner);
    await waitFor('auto-elected broker metadata', () => /Broker metadata: .*\(auto-elected\)/.test(owner.stderrText));

    const metadata = await waitFor('live broker metadata file', async () => {
      try {
        const m = readOnlyMetadata(registryDir);
        if (!m) return null;
        const res = await fetch(new URL('/health', m.endpoint), { signal: AbortSignal.timeout(1000) });
        return res.ok ? m : null;
      } catch { return null; }
    });
    if (metadata.pid !== owner.pid) throw new Error(`metadata pid ${metadata.pid} != owner pid ${owner.pid}`);
    if (/\[ChromeLauncher\] Launching Chrome/.test(owner.stderrText)) {
      throw new Error(`owner launched Chrome before browser demand:\n${owner.stderrText}`);
    }

    const lockBeforeIdle = readOnlyMetadata(lockDir);
    if (!lockBeforeIdle) throw new Error('controller lock metadata missing before idle window');
    await sleep(3500);
    const lockAfterIdle = readOnlyMetadata(lockDir);
    if (!lockAfterIdle) throw new Error('controller lock metadata disappeared during lazy idle window');
    if (Date.parse(lockAfterIdle.lastHeartbeatAt) <= Date.parse(lockBeforeIdle.lastHeartbeatAt)) {
      throw new Error('lazy owner did not refresh controller heartbeat before browser demand');
    }

    const client = start('client', baseArgs, env);
    children.push(client);
    await waitFor('surplus client broker attach', () => /auto-elect: attaching as broker client/.test(client.stderrText));
    sendRpc(client, 1, 'initialize');
    const initialize = await waitForRpc(client, 1, 'proxied initialize response');
    if (initialize.result?.serverInfo?.name !== 'openchrome') throw new Error(`unexpected initialize response: ${JSON.stringify(initialize)}`);
    sendRpc(client, 2, 'tools/list');
    const tools = await waitForRpc(client, 2, 'proxied tools/list response');
    if (!Array.isArray(tools.result?.tools)) throw new Error(`unexpected tools/list response: ${JSON.stringify(tools)}`);
    if (/\[ChromeLauncher\] Launching Chrome/.test(owner.stderrText)) throw new Error('tools/list triggered owner Chrome launch');
    if (/\[ChromeLauncher\] Launching Chrome/.test(client.stderrText)) throw new Error('broker client launched Chrome before browser demand');

    sendRpc(client, 3, 'tools/call', { name: 'tabs_context', arguments: { sessionId: 'lazy-a' } });
    sendRpc(client, 4, 'tools/call', { name: 'tabs_context', arguments: { sessionId: 'lazy-b' } });
    let firstUseA;
    let firstUseB;
    try {
      [firstUseA, firstUseB] = await Promise.all([
        waitForRpc(client, 3, 'first proxied browser response'),
        waitForRpc(client, 4, 'second proxied browser response'),
      ]);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `owner stderr:\n${owner.stderrText}\n` +
          `client stderr:\n${client.stderrText}\n` +
          `client stdout:\n${client.stdoutText}`,
      );
    }
    if (firstUseA.error || firstUseA.result?.isError) {
      throw new Error(`first browser call A failed: ${JSON.stringify(firstUseA)}\nowner stderr:\n${owner.stderrText}`);
    }
    if (firstUseB.error || firstUseB.result?.isError) {
      throw new Error(`first browser call B failed: ${JSON.stringify(firstUseB)}\nowner stderr:\n${owner.stderrText}`);
    }
    await waitFor('owner Chrome ready after browser demand', () => /\[ChromeLauncher\] Chrome ready at/.test(owner.stderrText));
    const ownerLaunchAttempts = countMatches(owner.stderrText, /\[ChromeLauncher\] Launching Chrome/g);
    const clientLaunches = countMatches(client.stderrText, /\[ChromeLauncher\] Launching Chrome/g);
    const firstDemandSignals = countMatches(owner.stderrText, /First browser\/CDP-requiring operation requested/g);
    const coalescedConnects = countMatches(owner.stderrText, /Coalescing concurrent connect\(\) call/g);
    const liveChromeRoots = liveManagedChromeRootCount(cdpPort);
    if (ownerLaunchAttempts !== 1) throw new Error(`expected exactly one owner Chrome launch, saw ${ownerLaunchAttempts}\n${owner.stderrText}`);
    if (clientLaunches !== 0) throw new Error(`broker client launched Chrome ${clientLaunches} time(s)\n${client.stderrText}`);
    if (firstDemandSignals !== 1) throw new Error(`expected one first-demand transition, saw ${firstDemandSignals}\n${owner.stderrText}`);
    if (coalescedConnects < 1) throw new Error(`concurrent first use did not coalesce\n${owner.stderrText}`);
    if (liveChromeRoots !== null && liveChromeRoots !== 1) {
      throw new Error(`expected one live managed Chrome root, saw ${liveChromeRoots}\n${owner.stderrText}`);
    }

    const optedOut = start('optout', [...baseArgs, '--no-auto-elect'], env);
    children.push(optedOut);
    await waitFor('opt-out duplicate remediation', () => /Refusing to start a second direct controller/.test(optedOut.stderrText) || /Another OpenChrome controller/.test(optedOut.stderrText));
    if (/auto-elect: attaching as broker client/.test(optedOut.stderrText)) throw new Error('--no-auto-elect unexpectedly attached as broker client');

    console.log(JSON.stringify({
      ok: true,
      cdpPort,
      httpPort,
      ownerPid: owner.pid,
      brokerPid: metadata.pid,
      lazyOwnerRetainedThroughIdle: true,
      clientAttachedBeforeChrome: true,
      ownerLaunchAttempts,
      clientLaunches,
      firstDemandSignals,
      coalescedConnects,
      liveChromeRoots,
      optOutPreservedFailFast: true,
    }, null, 2));
  } finally {
    await terminate(children);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
