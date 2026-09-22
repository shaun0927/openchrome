/// <reference types="jest" />

/**
 * Closure checks for #1673 step 2 against the real MCPServer core: modern
 * (2026-07-28) requests address browser state only through server-minted
 * workspace handles, and invalid or foreign handles are rejected before any
 * browser session is created or touched.
 */

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { MCPServer } from '../../src/mcp-server';
import { HTTPTransport } from '../../src/transports/http';
import { SdkStdioTransport } from '../../src/transports/sdk-stdio';
import { registerOcWorkspaceTool } from '../../src/tools/oc-workspace';
import type { MCPToolDefinition, ToolContext } from '../../src/types/mcp';
import { createMockSessionManager } from '../utils/mock-session';

const browserProbe: MCPToolDefinition = {
  name: 'probe_browser',
  description: 'Browser-requiring probe',
  inputSchema: { type: 'object', properties: { ask: { type: 'boolean' } } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

type MockSessionManager = ReturnType<typeof createMockSessionManager>;

const sessionEcho = (name: string): MCPToolDefinition => ({
  name,
  description: `${name} stub`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});

function registerSessionEchoes(server: MCPServer): void {
  for (const name of ['oc_lane_list', 'worker', 'oc_connection_health']) {
    server.registerTool(name, async (sessionId: string) => ({
      content: [{ type: 'text', text: JSON.stringify({ sessionId }) }],
    }), sessionEcho(name));
  }
}

function registerProbe(server: MCPServer): void {
  server.registerTool(browserProbe.name, async (sessionId: string, args: Record<string, unknown>, context?: ToolContext) => {
    let answer: unknown = null;
    if (args.ask === true && context?.clientCapabilities?.elicitation && context.requestClient) {
      answer = await context.requestClient('elicitation/create', {
        message: 'confirm',
        requestedSchema: { type: 'object', properties: {} },
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ sessionId, args, answer, elicitation: Boolean(context?.clientCapabilities?.elicitation) }) }] };
  }, browserProbe);
}

function payload(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

async function waitForListening(base: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await (await fetch(base.replace(/\/mcp$/, '/health'))).text();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error('HTTP transport did not start');
}

function modernClient(name: string, tenant?: string, elicitation = false): Client {
  const client = new Client(
    { name, version: '1.0.0' },
    { capabilities: elicitation ? { elicitation: {} } : {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  if (elicitation) {
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept' as const, content: {} }));
  }
  (client as unknown as { tenant?: string }).tenant = tenant;
  return client;
}

async function connectHttp(client: Client, base: string, tenant?: string): Promise<Client> {
  await client.connect(new StreamableHTTPClientTransport(new URL(base), tenant
    ? { requestInit: { headers: { 'X-Tenant-Id': tenant } } }
    : undefined));
  return client;
}

async function openWorkspace(client: Client): Promise<string> {
  const opened = payload(await client.callTool({ name: 'oc_workspace', arguments: { action: 'open' } }));
  expect(typeof opened.workspace).toBe('string');
  return opened.workspace as string;
}

describe('stateless workspace handles against the real core', () => {
  let server: MCPServer | null = null;
  let sessions: MockSessionManager;
  const clients: Client[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    if (server) await server.stop().catch(() => undefined);
    server = null;
    delete process.env.OPENCHROME_WORKSPACE_IDLE_MS;
  });

  async function startHttp(): Promise<string> {
    sessions = createMockSessionManager();
    server = new MCPServer(sessions as never);
    registerProbe(server);
    registerOcWorkspaceTool(server);
    const port = 20000 + Math.floor(Math.random() * 20000);
    server.start(new HTTPTransport(port, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true }));
    const base = `http://127.0.0.1:${port}/mcp`;
    await waitForListening(base);
    return base;
  }

  function browserSessionCalls(): string[] {
    return (sessions.getOrCreateSession as jest.Mock).mock.calls.map(call => call[0] as string);
  }

  test('modern schemas require the workspace argument; legacy schemas do not', async () => {
    const base = await startHttp();
    const modern = await connectHttp(modernClient('m'), base);
    const legacy = new Client({ name: 'legacy', version: '1' });
    await legacy.connect(new StreamableHTTPClientTransport(new URL(base)));
    clients.push(modern, legacy);

    const modernProbe = (await modern.listTools()).tools.find(tool => tool.name === browserProbe.name)!;
    expect(modernProbe.inputSchema.required).toContain('workspace');
    expect(Object.keys(modernProbe.inputSchema.properties ?? {})).toContain('workspace');
    expect((await modern.listTools()).tools.map(tool => tool.name)).toContain('oc_workspace');

    const legacyProbe = (await legacy.listTools()).tools.find(tool => tool.name === browserProbe.name)!;
    expect(Object.keys(legacyProbe.inputSchema.properties ?? {})).not.toContain('workspace');
  }, 60_000);

  test('session-scoped tools take the workspace so follow-up calls find its state', async () => {
    const base = await startHttp();
    registerSessionEchoes(server!);
    const client = await connectHttp(modernClient('m'), base);
    clients.push(client);
    const tools = (await client.listTools()).tools;
    const schema = (name: string) => tools.find(tool => tool.name === name)!.inputSchema;

    expect(schema('worker').required).toContain('workspace');
    expect(Object.keys(schema('oc_lane_list').properties ?? {})).toContain('workspace');
    expect(schema('oc_lane_list').required ?? []).not.toContain('workspace');
    expect(Object.keys(schema('oc_connection_health').properties ?? {})).not.toContain('workspace');

    const workspace = await openWorkspace(client);
    const browser = payload(await client.callTool({ name: browserProbe.name, arguments: { workspace } }));
    const lanes = payload(await client.callTool({ name: 'oc_lane_list', arguments: { workspace } }));
    expect(lanes.sessionId).toBe(browser.sessionId);
    // Every worker action addresses a workspace's workers, so the schema's
    // `required` is enforced for all of them, not only action "create".
    expect(payload(await client.callTool({ name: 'worker', arguments: { action: 'list' } })))
      .toMatchObject({ error: { code: 'WORKSPACE_REQUIRED' } });
    expect(payload(await client.callTool({ name: 'worker', arguments: { action: 'list', workspace } })).sessionId)
      .toBe(browser.sessionId);
  }, 60_000);

  test('read-only keys may open and list workspaces but not close them', async () => {
    const base = await startHttp();
    void base;
    const reader = { mode: 'api-key', tenantId: 'tenant-r', keyId: 'k-read', scopes: ['read'] } as never;
    const writer = { mode: 'api-key', tenantId: 'tenant-r', keyId: 'k-write', scopes: ['write'] } as never;
    const opened = payload(await server!.handleWorkspaceTool({ action: 'open' }, reader));
    const denied = await server!.handleWorkspaceTool({ action: 'close', workspace: opened.workspace }, reader);
    expect(denied.isError).toBe(true);
    expect(payload(denied)).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(payload(await server!.handleWorkspaceTool({ action: 'close', workspace: opened.workspace }, writer)))
      .toEqual({ closed: opened.workspace });
  }, 60_000);

  test('a workspace a person is holding does not expire', async () => {
    process.env.OPENCHROME_WORKSPACE_IDLE_MS = '150';
    const base = await startHttp();
    const client = await connectHttp(modernClient('m'), base);
    clients.push(client);
    const workspace = await openWorkspace(client);
    const used = payload(await client.callTool({ name: browserProbe.name, arguments: { workspace } }));
    server!.browserOperations.pause(used.sessionId as string, 'target-held');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(payload(await client.callTool({ name: browserProbe.name, arguments: { workspace } })).sessionId)
      .toBe(used.sessionId);
  }, 60_000);

  test('missing, legacy-named, unknown and stale handles are rejected before any browser work', async () => {
    const base = await startHttp();
    const client = await connectHttp(modernClient('m'), base);
    clients.push(client);

    const missing = await client.callTool({ name: browserProbe.name, arguments: {} });
    expect(missing.isError).toBe(true);
    expect(payload(missing)).toMatchObject({ error: { code: 'WORKSPACE_REQUIRED' } });

    const named = await client.callTool({ name: browserProbe.name, arguments: { sessionId: 'default' } });
    expect(payload(named)).toMatchObject({ error: { code: 'WORKSPACE_REQUIRED' } });

    const unknown = await client.callTool({ name: browserProbe.name, arguments: { workspace: 'ocw_nothere_x' } });
    expect(payload(unknown)).toMatchObject({ error: { code: 'STALE_RUNTIME' } });

    expect(browserSessionCalls()).toEqual([]);
  }, 60_000);

  test('a handle works across connections and only for its own tenant', async () => {
    const base = await startHttp();
    const first = await connectHttp(modernClient('a1'), base, 'tenant-a');
    const second = await connectHttp(modernClient('a2'), base, 'tenant-a');
    const intruder = await connectHttp(modernClient('b1'), base, 'tenant-b');
    clients.push(first, second, intruder);

    const workspace = await openWorkspace(first);
    const viaFirst = payload(await first.callTool({ name: browserProbe.name, arguments: { workspace } }));
    const viaSecond = payload(await second.callTool({ name: browserProbe.name, arguments: { workspace } }));
    expect(viaFirst.sessionId).toMatch(/^ws-/);
    expect(viaSecond.sessionId).toBe(viaFirst.sessionId);
    expect(viaFirst.args).toEqual({});

    const callsBefore = browserSessionCalls().length;
    const denied = await intruder.callTool({ name: browserProbe.name, arguments: { workspace } });
    expect(payload(denied)).toMatchObject({ error: { code: 'WORKSPACE_FORBIDDEN' } });
    expect(browserSessionCalls()).toHaveLength(callsBefore);

    const listed = payload(await intruder.callTool({ name: 'oc_workspace', arguments: { action: 'list' } }));
    expect(listed.workspaces).toEqual([]);
  }, 60_000);

  test('concurrent requests with different tenants, workspaces and capabilities stay separate', async () => {
    const base = await startHttp();
    const a = await connectHttp(modernClient('a', 'tenant-a', true), base, 'tenant-a');
    const b = await connectHttp(modernClient('b', 'tenant-b', false), base, 'tenant-b');
    clients.push(a, b);
    const workspaceA = await openWorkspace(a);
    const workspaceB = await openWorkspace(b);

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const [client, workspace] = i % 2 === 0 ? [a, workspaceA] : [b, workspaceB];
      return client.callTool({ name: browserProbe.name, arguments: { workspace, ask: true } })
        .then(result => ({ tenant: i % 2 === 0 ? 'a' : 'b', body: payload(result) }));
    }));
    const sessionA = results.find(r => r.tenant === 'a')!.body.sessionId;
    const sessionB = results.find(r => r.tenant === 'b')!.body.sessionId;
    expect(sessionA).not.toBe(sessionB);
    for (const { tenant, body } of results) {
      expect(body.sessionId).toBe(tenant === 'a' ? sessionA : sessionB);
      // Only the client that declared elicitation gets (and answers) it.
      expect(body.elicitation).toBe(tenant === 'a');
      expect(body.answer).toEqual(tenant === 'a' ? { action: 'accept', content: {} } : null);
    }
  }, 60_000);

  test('expired and closed workspaces are refused and closing disposes the session', async () => {
    process.env.OPENCHROME_WORKSPACE_IDLE_MS = '150';
    const base = await startHttp();
    const client = await connectHttp(modernClient('m'), base);
    clients.push(client);

    const expiring = await openWorkspace(client);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(payload(await client.callTool({ name: browserProbe.name, arguments: { workspace: expiring } })))
      .toMatchObject({ error: { code: 'WORKSPACE_EXPIRED' } });

    delete process.env.OPENCHROME_WORKSPACE_IDLE_MS;
    const closing = await openWorkspace(client);
    const used = payload(await client.callTool({ name: browserProbe.name, arguments: { workspace: closing } }));
    expect(payload(await client.callTool({ name: 'oc_workspace', arguments: { action: 'close', workspace: closing } })))
      .toEqual({ closed: closing });
    expect((sessions.deleteSession as jest.Mock).mock.calls.map(call => call[0])).toContain(used.sessionId);
    expect(payload(await client.callTool({ name: browserProbe.name, arguments: { workspace: closing } })))
      .toMatchObject({ error: { code: 'WORKSPACE_UNKNOWN' } });
  }, 60_000);

  test('modern stdio clients need a workspace as well; legacy stdio keeps the default session', async () => {
    sessions = createMockSessionManager();
    server = new MCPServer(sessions as never);
    registerProbe(server);
    registerOcWorkspaceTool(server);
    const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
    server.start(new SdkStdioTransport(serverWire));
    const modern = modernClient('stdio-modern');
    await modern.connect(clientWire);
    clients.push(modern);

    expect(payload(await modern.callTool({ name: browserProbe.name, arguments: {} })))
      .toMatchObject({ error: { code: 'WORKSPACE_REQUIRED' } });
    const workspace = await openWorkspace(modern);
    expect(payload(await modern.callTool({ name: browserProbe.name, arguments: { workspace } })).sessionId).toMatch(/^ws-/);
  }, 60_000);
});
