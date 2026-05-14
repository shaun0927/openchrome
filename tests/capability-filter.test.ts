/// <reference types="jest" />
/**
 * Capability-gated tool surface tests (#829)
 *
 * Covers:
 * 1. Default surface matches v1.11.0 snapshot (P2 compliance)
 * 2. --tools-only=core removes workflow/recording/crawl tools
 * 3. --disable-tools=workflow,recording removes exactly those groups
 * 4. expand_tools rejects capability-excluded tool with CAPABILITY_DISABLED
 * 5. lint:tools-capabilities fails when a tool lacks a capability entry
 */

import { createMockSessionManager } from './utils/mock-session';

// Block CDP / real Chrome connections
jest.mock('../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    forceReconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(false),
  })),
}));

jest.mock('../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../src/session-manager';
import { MCPServer, MCPServerOptions } from '../src/mcp-server';
import { TOOL_CAPABILITY_MAP, registerAllTools } from '../src/tools';
import { resolveCapabilityFilterOptions } from '../src/config/capability-filter';
import type { ToolCapability } from '../src/types/mcp';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

// Flexible response type used throughout tests
interface TestResponse {
  jsonrpc: string;
  id: number | string;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(options: MCPServerOptions = {}): MCPServer {
  const mockSM = createMockSessionManager();
  (getSessionManager as jest.Mock).mockReturnValue(mockSM);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MCPServer(mockSM as any, options);
}

async function getToolNames(server: MCPServer): Promise<string[]> {
  const req = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.0' }, capabilities: {} },
  };
  await server.handleRequest(req);

  const listReq = {
    jsonrpc: '2.0' as const,
    id: 2,
    method: 'tools/list',
    params: {},
  };
  const resp = (await server.handleRequest(listReq)) as unknown as TestResponse;
  return (resp.result?.tools ?? []).map(t => t.name).sort();
}

// ---------------------------------------------------------------------------
// Test 1: Default surface matches v1.11.0 snapshot
// ---------------------------------------------------------------------------

describe('capability-filter: default surface (P2 compliance)', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = makeServer();
    registerAllTools(server);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('tools/list matches v1.11.0 baseline snapshot', async () => {
    const snapshotPath = path.join(
      __dirname,
      '../src/tools/__tests__/__snapshots__/tools-list.v1.11.snap.json',
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
      tools: Array<{ name: string }>;
    };
    const expected = snapshot.tools.map(t => t.name).sort();
    const actual = await getToolNames(server);
    expect(actual).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Test 2: --tools-only=core removes workflow/recording/crawl tools
// ---------------------------------------------------------------------------

describe('capability-filter: --tools-only=core', () => {
  let server: MCPServer;

  beforeEach(() => {
    const filter: Set<ToolCapability> = new Set(['core']);
    server = makeServer({ capabilityFilter: filter });
    registerAllTools(server);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('no workflow_* tools exposed', async () => {
    const names = await getToolNames(server);
    const workflow = names.filter(n => n.startsWith('workflow_'));
    expect(workflow).toEqual([]);
  });

  test('no oc_recording_* tools exposed', async () => {
    const names = await getToolNames(server);
    const recording = names.filter(n => n.startsWith('oc_recording_'));
    expect(recording).toEqual([]);
  });

  test('no crawl* tools exposed', async () => {
    const names = await getToolNames(server);
    const crawl = names.filter(n => n.startsWith('crawl') || n === 'batch_execute' || n === 'batch_paginate' || n === 'worker_update' || n === 'worker_complete');
    expect(crawl).toEqual([]);
  });

  test('core tools are still present', async () => {
    const names = await getToolNames(server);
    expect(names).toContain('navigate');
    expect(names).toContain('read_page');
    expect(names).toContain('interact');
    expect(names).toContain('javascript_tool');
  });
});

// ---------------------------------------------------------------------------
// Test 2a: CLI alias parsing for --slim
// ---------------------------------------------------------------------------

describe('capability-filter: --slim alias parsing', () => {
  test('--slim resolves to core-only capability filter', () => {
    const result = resolveCapabilityFilterOptions({ slim: true });
    expect(result.errorMessage).toBeUndefined();
    expect(Array.from(result.capabilityFilter ?? [])).toEqual(['core']);
    expect(result.logMessage).toContain('Capability filter (slim): core');
  });

  test('--slim is mutually exclusive with explicit filter flags', () => {
    expect(resolveCapabilityFilterOptions({ slim: true, toolsOnly: 'core' }).errorMessage)
      .toContain('mutually exclusive');
    expect(resolveCapabilityFilterOptions({ slim: true, disableTools: 'workflow' }).errorMessage)
      .toContain('mutually exclusive');
  });
});

// ---------------------------------------------------------------------------
// Test 3: --disable-tools=workflow,recording removes exactly those groups
// ---------------------------------------------------------------------------

describe('capability-filter: --disable-tools=workflow,recording', () => {
  let defaultNames: string[];
  let filteredNames: string[];

  beforeEach(async () => {
    // Default (no filter)
    const defaultServer = makeServer();
    registerAllTools(defaultServer);
    defaultNames = await getToolNames(defaultServer);
    jest.clearAllMocks();

    // With workflow + recording disabled
    const allCapabilities: ToolCapability[] = ['core', 'crawl', 'storage', 'profile', 'totp', 'pilot'];
    const filter = new Set<ToolCapability>(allCapabilities);
    const filteredServer = makeServer({ capabilityFilter: filter });
    registerAllTools(filteredServer);
    filteredNames = await getToolNames(filteredServer);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('no workflow_* tools in filtered set', () => {
    const workflow = filteredNames.filter(n => n.startsWith('workflow_') || n === 'execute_plan');
    expect(workflow).toEqual([]);
  });

  test('no oc_recording_* tools in filtered set', () => {
    const recording = filteredNames.filter(n => n.startsWith('oc_recording_'));
    expect(recording).toEqual([]);
  });

  test('filtered set is exactly default minus workflow and recording groups', () => {
    const workflowTools = new Set(
      Object.entries(TOOL_CAPABILITY_MAP)
        .filter(([, cap]) => cap === 'workflow' || cap === 'recording')
        .map(([name]) => name),
    );
    const expected = defaultNames.filter(n => !workflowTools.has(n)).sort();
    expect(filteredNames).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Test 4: expand_tools rejects capability-excluded tool with CAPABILITY_DISABLED
// ---------------------------------------------------------------------------

describe('capability-filter: expand_tools respects capability gate', () => {
  let server: MCPServer;

  beforeEach(async () => {
    const filter: Set<ToolCapability> = new Set(['core']);
    server = makeServer({ capabilityFilter: filter, initialToolTier: 3 });
    registerAllTools(server);
    // Initialize the server so the client is recognized
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.0' }, capabilities: {} },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('expand_tools with a capability-excluded tool name returns CAPABILITY_DISABLED', async () => {
    const resp = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'expand_tools',
        arguments: { name: 'workflow_init', tier: '2' },
      },
    })) as unknown as TestResponse;

    expect(resp.result?.isError).toBe(true);
    const payload = JSON.parse(resp.result?.content?.[0].text ?? '{}') as {
      code: string;
      capability: string;
    };
    expect(payload.code).toBe('CAPABILITY_DISABLED');
    expect(payload.capability).toBe('workflow');
  });


  test('expand_tools is hidden and rejected when core capability is excluded', async () => {
    const filter: Set<ToolCapability> = new Set(['workflow']);
    const coreExcludedServer = makeServer({ capabilityFilter: filter });
    registerAllTools(coreExcludedServer);
    await coreExcludedServer.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'test', version: '0.0.0' },
        capabilities: { tools: { listChanged: true } },
      },
    });

    const listResp = (await coreExcludedServer.handleRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
      params: {},
    })) as unknown as TestResponse;
    const names = (listResp.result?.tools ?? []).map(t => t.name);
    expect(names).not.toContain('expand_tools');

    const callResp = (await coreExcludedServer.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'expand_tools', arguments: { tier: '2' } },
    })) as unknown as TestResponse;
    expect(callResp.result?.isError).toBe(true);
    const payload = JSON.parse(callResp.result?.content?.[0].text ?? '{}') as {
      code: string;
      capability: string;
    };
    expect(payload).toEqual({ code: 'CAPABILITY_DISABLED', capability: 'core' });
  });

  test('workflow_init is not in tools/list after expand_tools rejection', async () => {
    // Try to expand with an excluded tool
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'expand_tools',
        arguments: { name: 'workflow_init', tier: '2' },
      },
    });

    const listResp = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: {},
    })) as unknown as TestResponse;
    const names = (listResp.result?.tools ?? []).map(t => t.name);
    expect(names).not.toContain('workflow_init');
  });
});

// ---------------------------------------------------------------------------
// Test 5: lint:tools-capabilities fails when a tool lacks a capability entry
// ---------------------------------------------------------------------------

describe('lint:tools-capabilities', () => {
  const lintScript = path.join(__dirname, '../scripts/lint-tools-capabilities.js');

  test('passes for the current codebase (all tools have capability tags)', () => {
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(process.execPath, [lintScript], { encoding: 'utf8' });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status ?? 1;
      output = (err as { stdout?: string; stderr?: string }).stdout ?? '';
      output += (err as { stdout?: string; stderr?: string }).stderr ?? '';
    }
    expect(exitCode).toBe(0);
    expect(output).toContain('OK');
  });

  test('TOOL_CAPABILITY_MAP covers all tool names listed in the v1.11 snapshot', () => {
    const snapshotPath = path.join(
      __dirname,
      '../src/tools/__tests__/__snapshots__/tools-list.v1.11.snap.json',
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
      tools: Array<{ name: string }>;
    };
    const missing = snapshot.tools.map(t => t.name).filter(n => !(n in TOOL_CAPABILITY_MAP));
    expect(missing).toEqual([]);
  });
});
