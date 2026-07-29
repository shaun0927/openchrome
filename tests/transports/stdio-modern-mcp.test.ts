/// <reference types="jest" />

import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { currentRequestContext } from '../../src/observability/request-id';
import type { MCPResponse } from '../../src/types/mcp';
import { SdkStdioTransport } from '../../src/transports/sdk-stdio';

const VERSION = '2026-07-28';

function envelope(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'openchrome-stdio-test', version: '1.0.0' },
  };
}

interface Harness {
  transport: SdkStdioTransport;
  input: PassThrough;
  messages: Array<Record<string, unknown>>;
  waitFor: (
    predicate: (message: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
}

function createHarness(
  handler: (
    message: Record<string, unknown>,
    signal?: AbortSignal,
    context?: { mcpSessionId?: string },
  ) => Promise<MCPResponse | null>,
): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];
  let buffer = '';

  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index !== -1) {
        const [waiter] = waiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  });

  const wire = new StdioServerTransport(input, output);
  const transport = new SdkStdioTransport(wire);
  transport.onMessage(handler);
  transport.start();

  return {
    transport,
    input,
    messages,
    waitFor: (predicate) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for stdio message: ${JSON.stringify(messages)}`)),
          3_000,
        );
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
  };
}

function write(input: PassThrough, message: Record<string, unknown>): void {
  input.write(`${JSON.stringify(message)}\n`);
}

describe('MCP 2026-07-28 stdio boundary', () => {
  test('negotiates modern discovery and routes filtered subscriptions', async () => {
    const harness = createHarness(async (message) => {
      if (message.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: message.id as number,
          result: { tools: [] },
        };
      }
      return {
        jsonrpc: '2.0',
        id: message.id as number,
        error: { code: -32601, message: 'Unknown method' },
      };
    });

    try {
      write(harness.input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: envelope() },
      });
      const discovery = await harness.waitFor((message) => message.id === 1);
      expect(discovery.result).toMatchObject({
        resultType: 'complete',
        supportedVersions: [VERSION],
      });

      write(harness.input, {
        jsonrpc: '2.0',
        id: 2,
        method: 'subscriptions/listen',
        params: {
          notifications: { toolsListChanged: true },
          _meta: envelope(),
        },
      });
      const acknowledged = await harness.waitFor(
        (message) => message.method === 'notifications/subscriptions/acknowledged',
      );
      expect(acknowledged.params).toMatchObject({
        notifications: { toolsListChanged: true },
        _meta: { 'io.modelcontextprotocol/subscriptionId': 2 },
      });

      harness.transport.publishToolsChanged();
      const changed = await harness.waitFor(
        (message) => message.method === 'notifications/tools/list_changed',
      );
      expect(changed.params).toMatchObject({
        _meta: { 'io.modelcontextprotocol/subscriptionId': 2 },
      });
    } finally {
      await harness.transport.close();
    }
  });

  test('keeps legacy initialize and connection-scoped ids working', async () => {
    let observedSessionId: string | undefined;
    let observedRoots: unknown;
    let rootsCompletion: Promise<void> | undefined;
    const harness = createHarness(async (message, _signal, context) => {
      if (
        message.method === 'notifications/initialized' ||
        message.method === 'notifications/roots/list_changed'
      ) {
        const requestClient = currentRequestContext()?.requestClient;
        if (!requestClient) throw new Error('Legacy SDK request bridge missing');
        rootsCompletion = requestClient('roots/list').then((roots) => {
          observedRoots = roots;
        });
        await rootsCompletion;
        return null;
      }
      if (message.method === 'tools/list') {
        observedSessionId = context?.mcpSessionId;
        return {
          jsonrpc: '2.0',
          id: message.id as number,
          result: { tools: [] },
        };
      }
      return null;
    });

    try {
      write(harness.input, {
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'legacy-test', version: '1.0.0' },
        },
      });
      const initialized = await harness.waitFor((message) => message.id === 10);
      expect(initialized.result).toMatchObject({
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'openchrome' },
      });

      write(harness.input, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      const rootsRequest = await harness.waitFor(
        (message) => message.method === 'roots/list',
      );
      write(harness.input, {
        jsonrpc: '2.0',
        id: rootsRequest.id as string | number,
        result: { roots: [{ uri: 'file:///workspace', name: 'workspace' }] },
      });
      await rootsCompletion;
      expect(observedRoots).toEqual({
        roots: [{ uri: 'file:///workspace', name: 'workspace' }],
      });

      observedRoots = undefined;
      rootsCompletion = undefined;
      write(harness.input, {
        jsonrpc: '2.0',
        method: 'notifications/roots/list_changed',
      });
      const refreshedRootsRequest = await harness.waitFor(
        (message) =>
          message.method === 'roots/list' &&
          message.id !== rootsRequest.id,
      );
      write(harness.input, {
        jsonrpc: '2.0',
        id: refreshedRootsRequest.id as string | number,
        result: { roots: [{ uri: 'file:///updated', name: 'updated' }] },
      });
      await rootsCompletion;
      expect(observedRoots).toEqual({
        roots: [{ uri: 'file:///updated', name: 'updated' }],
      });

      write(harness.input, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/list',
        params: {},
      });
      await harness.waitFor((message) => message.id === 11);
      expect(observedSessionId).toMatch(/^stdio-/);
    } finally {
      await harness.transport.close();
    }
  });
});
