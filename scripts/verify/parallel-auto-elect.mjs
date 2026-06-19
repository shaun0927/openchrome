#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const root = resolve(new URL('../..', import.meta.url).pathname);
const entry = join(root, 'dist', 'index.js');
const timeoutMs = Number(process.env.OPENCHROME_AUTO_ELECT_SMOKE_TIMEOUT_MS || 30000);
function parseClientCount(argv) {
  const eq = argv.find((arg) => arg.startsWith('--clients='));
  const spaced = argv[argv.indexOf('--clients') + 1];
  return Math.max(3, Number(eq?.split('=')[1] || spaced || process.env.OPENCHROME_PARALLEL_CLIENTS || 3));
}
const clientCount = parseClientCount(process.argv.slice(2));

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

function hasValidToolList(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools) || tools.length < 5) return false;
  const names = tools.map((tool) => typeof tool?.name === 'string' ? tool.name : '').filter(Boolean);
  return names.length === tools.length && new Set(names).size === names.length;
}

async function verifyMcpClient(child, idBase) {
  sendRpc(child, idBase, 'initialize');
  const initialized = Boolean(await waitFor(`${child.name} initialize response`, () => jsonLines(child.stdoutText).some((m) => m.id === idBase && m.result?.serverInfo?.name === 'openchrome')));
  sendRpc(child, idBase + 100, 'tools/list');
  const listedTools = Boolean(await waitFor(`${child.name} tools/list response`, () => jsonLines(child.stdoutText).some((m) => m.id === idBase + 100 && hasValidToolList(m))));
  return { initialized, listedTools };
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

    const clients = [owner];
    for (let i = 1; i < clientCount; i++) {
      const client = start(`client-${i}`, baseArgs, env);
      children.push(client);
      clients.push(client);
    }
    const mcpChecks = [];
    for (const [index, client] of clients.entries()) {
      if (client !== owner) await waitFor(`${client.name} broker attach`, () => /auto-elect: attaching as broker client/.test(client.stderrText));
      mcpChecks.push(await verifyMcpClient(client, index + 1));
    }

    const optedOut = start('optout', [...baseArgs, '--no-auto-elect'], env);
    children.push(optedOut);
    await waitFor('opt-out duplicate remediation', () => /Refusing to start a second direct controller/.test(optedOut.stderrText) || /Another OpenChrome controller/.test(optedOut.stderrText));
    if (/auto-elect: attaching as broker client/.test(optedOut.stderrText)) throw new Error('--no-auto-elect unexpectedly attached as broker client');

    const allClientsInitialized = mcpChecks.every((check) => check.initialized);
    const allClientsListedTools = mcpChecks.every((check) => check.listedTools);
    console.log(JSON.stringify({ ok: true, clients: clientCount, cdpPort, httpPort, directOwners: 1, ownerPid: owner.pid, brokerPid: metadata.pid, brokerClients: clients.length - 1, allClientsInitialized, allClientsListedTools, optOutPreservedFailFast: true }, null, 2));
  } finally {
    await terminate(children);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
