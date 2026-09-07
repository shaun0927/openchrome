/** Real MCP/Chrome acceptance. The fixture server, not tool prose, is the oracle. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MCPClient } from '../e2e/harness/mcp-client';
import { readProcessMemory, ProcessMemorySample, PROCESS_MEMORY_TIMEOUT_MS } from '../../src/core/process/memory';

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function main(): Promise<void> {
  const option = (name: string, fallback: string) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? fallback : process.argv[i + 1];
  };
  const entry = path.resolve(option('--entry', 'dist/index.js'));
  const relativeEntry = path.relative(process.cwd(), entry);
  const entryOutsideCheckout = relativeEntry === '..' || relativeEntry.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEntry);
  const artifact = option('--artifact', '');
  const runtimeContract = process.argv.includes('--runtime-contract');
  const output = path.resolve(option('--output', 'artifacts/frontier/acceptance.json'));
  try {
    await fs.copyFile(output, output.replace(/\.json$/, '') + `-previous-${Date.now()}.json`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-frontier-'));
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  // Older releases lack overrides for every persisted file. Isolate homedir
  // inside the tested Node child before importing the package; do not change
  // the user's shell HOME/USERPROFILE or edit the installed package.
  const bootstrap = path.join(root, 'isolate.cjs');
  await fs.writeFile(bootstrap, `require('node:os').homedir = () => ${JSON.stringify(root)};\n`);
  const port = await freePort();
  const accounts = new Map<string, string>();
  const receipts = new Map<string, string>();
  const rejected: string[] = [];
  const duplicateJobs: string[] = [];
  const fixture = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    const account = url.searchParams.get('account') || '';
    if (url.pathname === '/login') {
      const token = crypto.randomUUID();
      accounts.set(account, token);
      res.setHeader('Set-Cookie', `fixture=${token}; HttpOnly; SameSite=Strict; Path=/`);
    }
    if (url.pathname === '/commit') {
      const token = /(?:^|; )fixture=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      if (!token || accounts.get(account) !== token) {
        rejected.push(account);
        res.writeHead(401).end('login required');
        return;
      }
      const job = url.searchParams.get('job') || '';
      if (receipts.has(job)) { duplicateJobs.push(job); res.writeHead(409).end('duplicate'); return; }
      receipts.set(job, account);
      res.end('committed');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Frontier fixture</title><button id="commit">Commit</button>' +
      '<script>document.querySelector("button").onclick=async()=>{' +
      'const q=new URLSearchParams(location.search);q.set("job",document.body.dataset.job);' +
      'const r=await fetch("/commit?"+q,{method:"POST"});document.body.dataset.status=String(r.status)};</script>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const client = new MCPClient({ entry, cwd: root, nodeArgs: ['--require', bootstrap], timeoutMs: 60_000, startupTimeoutMs: 120_000, args: [
    '--headless', '--no-auto-elect', '--launch-mode', 'isolated',
    '--port', String(port), '--user-data-dir', profile,
  ], env: {
    OPENCHROME_TASK_ROOT: path.join(root, 'tasks'),
    OPENCHROME_CONTROLLER_LOCK_DIR: path.join(root, 'locks'),
    OPENCHROME_BROKER_REGISTRY_DIR: path.join(root, 'brokers'),
    OC_STORAGE_DIR: path.join(root, 'storage'),
    NODE_PATH: '',
    NODE_OPTIONS: '',
  } });
  const samples: ProcessMemorySample[] = [];
  const timings: Array<{ tool: string; durationMs: number }> = [];
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(entry), '..', 'package.json'), 'utf8'));
  const report: Record<string, unknown> = {
    schemaVersion: 1, startedAt: new Date().toISOString(), entry,
    childWorkingDirectory: root,
    dependencyIsolation: { nodePath: 'empty', entryOutsideCheckout },
    harnessSourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    harnessDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim()),
    packageVersion: manifest.version, packageGitHead: manifest.gitHead ?? null,
    entrySha256: crypto.createHash('sha256').update(await fs.readFile(entry)).digest('hex'),
    artifactSha512: artifact ? crypto.createHash('sha512').update(await fs.readFile(artifact)).digest('base64') : null,
    platform: process.platform, os: os.release(), node: process.version,
    profile: 'fresh isolated temporary profile; four named contexts',
    measurement: { startupTimeoutMs: 120_000, collectorTimeoutMs: PROCESS_MEMORY_TIMEOUT_MS, warmupRounds: 1, measuredRounds: 5, parallelism: 4,
      sampling: 'awaited process-tree sample after launch and each measured round',
      missingSamplesAllowed: 0, metricCaveat: 'Summed working set/RSS includes shared pages; not private bytes.',
      verdictScope: 'functional smoke and sample availability; no speed or leak threshold claim' },
    timings, samples, status: 'running', measurementStatus: 'not_started',
  };
  const write = async () => { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2)); };
  let chromePid: number | undefined;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const start = performance.now();
    const result = await client.callTool(name, args);
    timings.push({ tool: name, durationMs: performance.now() - start });
    assert.notEqual(result.raw.isError, true, `${name}: ${result.text}`);
    return result;
  };
  const waitFor = async (condition: () => boolean) => {
    const end = Date.now() + 5000;
    while (!condition()) { assert.ok(Date.now() < end, 'fixture oracle timed out'); await new Promise(r => setTimeout(r, 20)); }
  };
  try {
    await write();
    const start = performance.now();
    await client.start();
    report.mcpStartupMs = performance.now() - start;
    const listed = await client.send('tools/list', {});
    assert.ok(!listed.error && Array.isArray(listed.result?.tools));
    const before = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
    report.lazyStartup = !before;
    assert.equal(before, false, 'Chrome launched before the first browser operation');
    const tabs: string[] = [];
    // First use is serialized to separate cold startup from parallel work.
    for (let i = 0; i < 4; i++) {
      const result = await tool('tabs_create', { url: `${base}/login?account=a${i}`, isolatedContext: `account${i}` });
      const payload = JSON.parse(result.content.find(item => item.type === 'text')!.text!);
      assert.equal(typeof payload.tabId, 'string');
      tabs.push(payload.tabId);
    }
    if (runtimeContract) {
      const profileResult = await tool('oc_profile_status', {});
      const profileStatus = JSON.parse(profileResult.content.find(item => item.type === 'text')!.text!);
      assert.equal(profileStatus.authentication, 'unverified');
      assert.equal(profileStatus.storageRestore.status, 'unavailable');
      assert.equal(profileStatus.storageRestore.reason, 'missing');
      const extra = await tool('tabs_create', { url: 'about:blank' });
      const extraId = JSON.parse(extra.content.find(item => item.type === 'text')!.text!).tabId;
      const refused = await client.callTool('tabs_create', { url: 'about:blank' });
      assert.equal(refused.raw.isError, true, 'sixth tab must be refused instead of evicting active work');
      assert.ok(refused.text.includes('TARGET_CAPACITY'));
      await tool('tabs_close', { tabId: extraId });
      report.runtimeContract = { unverifiedAuthentication: true, missingSnapshotExplicit: true, capacityRefused: true };
      // The receipts below independently prove all four original targets survived.
    }
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
    report.browser = version.Browser;
    const marker = JSON.parse(await fs.readFile(path.join(profile, '.openchrome-managed'), 'utf8'));
    chromePid = marker.pid;
    const sample = async () => {
      try {
        const value = await readProcessMemory(chromePid!, true);
        if (samples.length) assert.equal(value.identity, samples[0].identity, 'Chrome PID reused');
        samples.push(value);
        report.measurementStatus = 'valid';
      } catch (error) {
        report.measurementStatus = 'inconclusive';
        throw error;
      }
    };
    await sample();
    for (let round = 0; round < 6; round++) {
      await Promise.all(tabs.map(async (tabId, i) => {
        const job = `r${round}-a${i}`;
        await tool('javascript_tool', { tabId, code: `document.body.dataset.job=${JSON.stringify(job)}; document.querySelector('#commit').click();` });
        await waitFor(() => receipts.has(job));
        assert.equal(receipts.get(job), `a${i}`, 'cross-account write');
      }));
      if (round > 0) await sample();
      await write();
    }
    assert.equal(receipts.size, 24);
    // Expiry is independent server state, not a DOM signal produced by the agent.
    accounts.delete('a0');
    await tool('javascript_tool', { tabId: tabs[0], code: "document.body.dataset.job='expired'; document.querySelector('#commit').click();" });
    await waitFor(() => rejected.includes('a0'));
    assert.equal(receipts.has('expired'), false);
    await tool('navigate', { tabId: tabs[0], url: `${base}/login?account=a0`, autoFallback: false });
    await tool('javascript_tool', { tabId: tabs[0], code: "document.body.dataset.job='resumed'; document.querySelector('#commit').click();" });
    await waitFor(() => receipts.has('resumed'));
    assert.equal(receipts.get('resumed'), 'a0');
    assert.deepEqual(duplicateJobs, [], 'duplicate write attempts');
    report.oracle = { receipts: [...receipts], rejected, expiryAndExplicitRelogin: true };
    for (const tabId of tabs) await tool('tabs_close', { tabId });
    await sample();
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    if (!chromePid) {
      try { chromePid = JSON.parse(await fs.readFile(path.join(profile, '.openchrome-managed'), 'utf8')).pid; } catch { /* Chrome may never have launched. */ }
    }
    await client.stop().catch(error => { report.shutdownError = String(error); report.status = 'failed'; process.exitCode = 1; });
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    if (chromePid) {
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try { process.kill(chromePid, 0); await new Promise(r => setTimeout(r, 100)); } catch { alive = false; }
      }
      report.chromeExited = !alive;
      if (alive) { report.status = 'failed'; process.exitCode = 1; }
    }
    report.oracle = { ...(report.oracle as object || {}), receipts: [...receipts], rejected, duplicateJobs };
    report.finishedAt = new Date().toISOString();
    report.retainedProfile = root;
    await write();
    console.log(JSON.stringify({ status: report.status, output, error: report.error }));
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
