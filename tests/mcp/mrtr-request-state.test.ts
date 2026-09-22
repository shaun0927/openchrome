/// <reference types="jest" />

/**
 * Multi-round-trip (input_required) state for the stateless era must be
 * integrity-protected, bound to the caller and to the exact request, and
 * single use: client input gates side effects such as clearing cookies.
 */

import { MCPServer } from '../../src/mcp-server';
import { _resetMrtrStateForTesting } from '../../src/mcp/sdk-adapter';
import { HTTPTransport } from '../../src/transports/http';
import type { MCPToolDefinition, ToolContext } from '../../src/types/mcp';
import { createMockSessionManager } from '../utils/mock-session';

const confirmTool: MCPToolDefinition = {
  name: 'oc_policy',
  description: 'Asks for confirmation before a counted side effect',
  inputSchema: { type: 'object', properties: { target: { type: 'string' }, twice: { type: 'boolean' } } },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

interface JsonRpcBody {
  result?: Record<string, unknown> & { resultType?: string; inputRequests?: Record<string, unknown>; requestState?: string };
  error?: { code: number; message: string };
}

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const accept = { action: 'accept', content: {} };

describe('signed multi-round-trip state', () => {
  let server: MCPServer | null = null;
  let base = '';
  let sideEffects: Array<{ target: unknown; answers: unknown[] }> = [];
  let nextId = 1;

  beforeEach(async () => {
    _resetMrtrStateForTesting();
    sideEffects = [];
    server = new MCPServer(createMockSessionManager() as never);
    server.registerTool(confirmTool.name, async (_sessionId: string, args: Record<string, unknown>, context?: ToolContext) => {
      const answers = [await context!.requestClient!('elicitation/create', { message: `clear ${String(args.target)}?`, requestedSchema: { type: 'object', properties: {} } })];
      if (args.twice === true) {
        answers.push(await context!.requestClient!('elicitation/create', { message: 'really?', requestedSchema: { type: 'object', properties: {} } }));
      }
      sideEffects.push({ target: args.target, answers });
      return { content: [{ type: 'text', text: 'done' }] };
    }, confirmTool);
    const port = 20000 + Math.floor(Math.random() * 20000);
    server.start(new HTTPTransport(port, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true }));
    base = `http://127.0.0.1:${port}/mcp`;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await (await fetch(base.replace(/\/mcp$/, '/health'))).text(); break; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
  });

  afterEach(async () => {
    if (server) await server.stop().catch(() => undefined);
    server = null;
    delete process.env.OPENCHROME_MRTR_STATE_TTL_SECONDS;
    _resetMrtrStateForTesting();
  });

  async function call(args: Record<string, unknown>, extra: Record<string, unknown> = {}, tenant = 'tenant-a'): Promise<{ status: number; body: JsonRpcBody }> {
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': confirmTool.name,
        'x-tenant-id': tenant,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: confirmTool.name, arguments: args, ...extra, _meta: envelope },
      }),
    });
    const text = await response.text();
    const json = text.startsWith('{') ? text : text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).pop()!;
    return { status: response.status, body: JSON.parse(json) as JsonRpcBody };
  }

  async function ask(args: Record<string, unknown>) {
    const first = await call(args);
    expect(first.body.result?.resultType).toBe('input_required');
    const [key] = Object.keys(first.body.result!.inputRequests!);
    return { key, state: first.body.result!.requestState! };
  }

  test('issues a signed state and completes only with it', async () => {
    const { key, state } = await ask({ target: 'a' });
    expect(state).toMatch(/^v1\./);
    const done = await call({ target: 'a' }, { inputResponses: { [key]: accept }, requestState: state });
    expect(done.body.result?.resultType).toBe('complete');
    expect(sideEffects).toEqual([{ target: 'a', answers: [accept] }]);
  });

  test('ignores answers the client supplies without being asked', async () => {
    const forged = await call({ target: 'a' }, { inputResponses: { openchrome_1_elicitation_create: accept } });
    expect(forged.body.result?.resultType).toBe('input_required');
    expect(sideEffects).toEqual([]);
  });

  test('a state is single use: replaying it asks again', async () => {
    const { key, state } = await ask({ target: 'a' });
    await call({ target: 'a' }, { inputResponses: { [key]: accept }, requestState: state });
    const replay = await call({ target: 'a' }, { inputResponses: { [key]: accept }, requestState: state });
    expect(replay.body.result?.resultType).toBe('input_required');
    expect(sideEffects).toHaveLength(1);
  });

  test('an answer given for one request cannot authorize different arguments', async () => {
    const { key, state } = await ask({ target: 'a' });
    const swapped = await call({ target: 'everything' }, { inputResponses: { [key]: accept }, requestState: state });
    expect(swapped.body.result?.resultType).toBe('input_required');
    expect(sideEffects).toEqual([]);
  });

  test('tampered, foreign-tenant and expired states are rejected before the tool runs', async () => {
    const { key, state } = await ask({ target: 'a' });
    const [version, body, mac] = state.split('.');
    const tampered = `${version}.${body}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`;
    const badMac = await call({ target: 'a' }, { inputResponses: { [key]: accept }, requestState: tampered });
    expect(badMac.body.error?.code).toBe(-32602);

    const foreign = await call({ target: 'a' }, { inputResponses: { [key]: accept }, requestState: state }, 'tenant-b');
    expect(foreign.body.error?.code).toBe(-32602);

    // The same state still works for its own tenant: the rejections above
    // came from the MAC and the tenant binding, not from a consumed state.
    const owner = await call({ target: 'a' }, { inputResponses: { [key]: accept }, requestState: state });
    expect(owner.body.result?.resultType).toBe('complete');
    expect(sideEffects).toHaveLength(1);
    sideEffects = [];

    process.env.OPENCHROME_MRTR_STATE_TTL_SECONDS = '1';
    _resetMrtrStateForTesting();
    const short = await ask({ target: 'a' });
    await new Promise(resolve => setTimeout(resolve, 2_200));
    const expired = await call({ target: 'a' }, { inputResponses: { [short.key]: accept }, requestState: short.state });
    expect(expired.body.error?.code).toBe(-32602);
    expect(sideEffects).toEqual([]);
  }, 20_000);

  test('carries earlier answers across rounds in the signed state', async () => {
    const round1 = await ask({ target: 'a', twice: true });
    const round2 = await call({ target: 'a', twice: true }, { inputResponses: { [round1.key]: accept }, requestState: round1.state });
    expect(round2.body.result?.resultType).toBe('input_required');
    const [key2] = Object.keys(round2.body.result!.inputRequests!);
    expect(key2).not.toBe(round1.key);
    const second = { action: 'accept', content: { again: true } };
    const done = await call({ target: 'a', twice: true }, { inputResponses: { [key2]: second }, requestState: round2.body.result!.requestState });
    expect(done.body.result?.resultType).toBe('complete');
    expect(sideEffects).toEqual([{ target: 'a', answers: [accept, second] }]);
  });
});
