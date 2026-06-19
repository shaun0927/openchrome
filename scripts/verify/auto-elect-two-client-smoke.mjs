#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const root = resolve(new URL('../..', import.meta.url).pathname);
const entry = join(root, 'dist', 'index.js');
const timeoutMs = Number(process.env.OPENCHROME_AUTO_ELECT_SMOKE_TIMEOUT_MS || 30000);

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
  const registryDir = join(tmp, 'brokers');
  const cdpPort = await allocPort();
  const httpPort = await allocPort();
  const env = {
    OPENCHROME_BROKER_REGISTRY_DIR: registryDir,
    OPENCHROME_PPID_WATCH: '0',
    OPENCHROME_HEALTH_ENDPOINT: '0',
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

    const client = start('client', baseArgs, env);
    children.push(client);
    await waitFor('surplus client broker attach', () => /auto-elect: attaching as broker client/.test(client.stderrText));
    sendRpc(client, 1, 'initialize');
    await waitFor('proxied initialize response', () => jsonLines(client.stdoutText).some((m) => m.id === 1 && m.result?.serverInfo?.name === 'openchrome'));

    const optedOut = start('optout', [...baseArgs, '--no-auto-elect'], env);
    children.push(optedOut);
    await waitFor('opt-out duplicate remediation', () => /Refusing to start a second direct controller/.test(optedOut.stderrText) || /Another OpenChrome controller/.test(optedOut.stderrText));
    if (/auto-elect: attaching as broker client/.test(optedOut.stderrText)) throw new Error('--no-auto-elect unexpectedly attached as broker client');

    console.log(JSON.stringify({ ok: true, cdpPort, httpPort, ownerPid: owner.pid, brokerPid: metadata.pid, clientAttached: true, optOutPreservedFailFast: true }, null, 2));
  } finally {
    await terminate(children);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
