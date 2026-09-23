/**
 * Installed-package smoke for the stateless MCP 2026-07-28 path.
 *
 * Drives an installed OpenChrome entrypoint over stdio with the official MCP
 * SDK v2 client pinned to 2026-07-28 and a real headless Chrome: discovery,
 * the runtime contract, workspace-handle enforcement, a browser round trip
 * through a workspace, and rejection of a closed handle.
 *
 *   ts-node tests/harness/modern-installed-smoke.ts --entry <dist/index.js> --output <report.json>
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function structured(result: unknown): Record<string, unknown> {
  const r = result as { structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> };
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.find(item => item.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

function text(result: unknown): string {
  return ((result as { content?: Array<{ type: string; text?: string }> }).content ?? [])
    .filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
}

async function main(): Promise<void> {
  const entry = path.resolve(argValue('--entry') ?? 'dist/index.js');
  const output = path.resolve(argValue('--output') ?? 'artifacts/frontier/modern-installed-smoke.json');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-modern-smoke-'));
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  const bootstrap = path.join(root, 'isolate.cjs');
  await fs.writeFile(bootstrap, `require('node:os').homedir = () => ${JSON.stringify(root)};\n`);
  const port = await freePort();

  const fixture = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>modern-smoke</title><h1 id="ok">ready</h1>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;

  const report: Record<string, unknown> = { entry, startedAt: new Date().toISOString(), platform: process.platform, node: process.version, status: 'running' };
  const client = new Client(
    { name: 'openchrome-modern-installed-smoke', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--require', bootstrap, entry, 'serve', '--auto-launch', '--headless', '--no-auto-elect',
      '--launch-mode', 'isolated', '--port', String(port), '--user-data-dir', profile],
    cwd: root,
    env: {
      ...process.env as Record<string, string>,
      OPENCHROME_TASK_ROOT: path.join(root, 'tasks'),
      OPENCHROME_CONTROLLER_LOCK_DIR: path.join(root, 'locks'),
      OPENCHROME_BROKER_REGISTRY_DIR: path.join(root, 'brokers'),
      OC_STORAGE_DIR: path.join(root, 'storage'),
      NODE_PATH: '',
      NODE_OPTIONS: '',
    },
    stderr: 'ignore',
  });

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    const runtime = (client.getServerCapabilities()?.experimental as Record<string, Record<string, unknown>> | undefined)?.['io.openchrome/runtime'];
    assert.equal(runtime?.protocolMode, 'dual-era');
    report.runtime = { runtimeId: runtime?.runtimeId, packageVersion: runtime?.packageVersion };

    const tools = (await client.listTools()).tools;
    const tabsCreate = tools.find(tool => tool.name === 'tabs_create');
    assert.ok(tabsCreate?.inputSchema.required?.includes('workspace'), 'tabs_create must require workspace on 2026-07-28');
    assert.ok(tools.some(tool => tool.name === 'oc_workspace'));
    assert.ok(!tools.some(tool => tool.name === 'expand_tools'), 'modern tools/list is not progressive');
    report.toolCount = tools.length;

    const refused = await client.callTool({ name: 'tabs_create', arguments: { url: fixtureUrl } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /WORKSPACE_REQUIRED/);

    const workspace = structured(await client.callTool({ name: 'oc_workspace', arguments: { action: 'open' } })).workspace as string;
    assert.match(workspace, /^ocw_/);

    const created = await client.callTool({ name: 'tabs_create', arguments: { url: fixtureUrl, workspace } });
    assert.notEqual(created.isError, true, text(created));
    const tabId = JSON.parse(text(created)).tabId as string;
    assert.equal(typeof tabId, 'string');

    const title = await client.callTool({ name: 'javascript_tool', arguments: { tabId, workspace, code: 'document.title' } });
    assert.notEqual(title.isError, true, text(title));
    assert.match(text(title), /modern-smoke/);

    const context = await client.callTool({ name: 'tabs_context', arguments: { workspace } });
    assert.equal(JSON.parse(text(context)).tabCount, 1);

    const closed = structured(await client.callTool({ name: 'oc_workspace', arguments: { action: 'close', workspace } }));
    assert.equal(closed.closed, workspace);
    const afterClose = await client.callTool({ name: 'tabs_context', arguments: { workspace } });
    assert.equal(afterClose.isError, true);
    assert.match(text(afterClose), /WORKSPACE_UNKNOWN/);

    report.checks = {
      modernEra: true, runtimeContract: true, workspaceRequired: true,
      browserRoundTrip: true, closedHandleRejected: true,
    };
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    report.errorStack = error instanceof Error ? error.stack : undefined;
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
    try {
      const marker = JSON.parse(await fs.readFile(path.join(profile, '.openchrome-managed'), 'utf8')) as { pid?: number };
      if (marker.pid) {
        try { process.kill(marker.pid); } catch { /* already exited */ }
      }
    } catch { /* Chrome may never have launched */ }
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, output, ...(report.error ? { error: report.error } : {}) }));
  }
}

void main();
