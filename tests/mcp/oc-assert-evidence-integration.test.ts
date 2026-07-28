/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Principal } from '../../src/auth/api-key-types';
import {
  AssertEvidenceStore,
  setAssertEvidenceStoreForTests,
} from '../../src/core/contracts/assert-evidence-store';
import { MCPServer } from '../../src/mcp-server';
import { PRINCIPAL_SYM } from '../../src/middleware/auth';
import { registerOcAssertTool } from '../../src/tools/oc-assert';
import { registerOcEvidenceGetTool } from '../../src/tools/oc-evidence-get';
import type { MCPRequest, MCPResponse } from '../../src/types/mcp';
import { createMockSessionManager } from '../utils/mock-session';

const tenantAWrite: Principal = {
  mode: 'api-key',
  tenantId: 'tenant-a',
  keyId: 'key-a',
  scopes: ['write'],
};

const tenantARead: Principal = {
  ...tenantAWrite,
  scopes: ['read'],
};

const tenantBRead: Principal = {
  mode: 'api-key',
  tenantId: 'tenant-b',
  keyId: 'key-b',
  scopes: ['read'],
};

function toolCall(id: number, name: string, args: Record<string, unknown>): MCPRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

function authenticated(request: MCPRequest, principal: Principal): Record<string, unknown> {
  const message = request as unknown as Record<PropertyKey, unknown>;
  message[PRINCIPAL_SYM] = principal;
  return message as Record<string, unknown>;
}

function resultPayload(response: MCPResponse): Record<string, unknown> {
  const result = response.result;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('expected JSON text result');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('oc_assert durable evidence through MCP', () => {
  let rootDir: string;
  let store: AssertEvidenceStore;
  let server: MCPServer;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-assert-evidence-mcp-'));
    store = new AssertEvidenceStore({ rootDir });
    setAssertEvidenceStoreForTests(store);
    server = new MCPServer(createMockSessionManager() as never);
    registerOcAssertTool(server, undefined, store);
    registerOcEvidenceGetTool(server, store);
  });

  afterEach(() => {
    setAssertEvidenceStoreForTests(null);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('assert -> persist -> retrieve preserves provenance and explicit trace unavailability', async () => {
    const asserted = await server.handleMessage(
      authenticated(toolCall(1, 'oc_assert', {
        contract: { kind: 'url', pattern: '^https://example\\.com/account$' },
        evidence: {
          provenance: {
            target_id: 'tab-a',
            worker_id: 'worker-a',
            captured_at: '2026-07-28T12:00:00.000Z',
          },
          snapshot: { url: 'https://example.com/account' },
        },
      }), tenantAWrite),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    const assertion = resultPayload(asserted);

    expect(assertion).toMatchObject({
      verdict: 'pass',
      evidence_status: 'persisted',
      trace_status: 'unavailable',
    });
    const handle = assertion.evidence_handle as string;

    const retrieved = await server.handleMessage(
      authenticated(toolCall(2, 'oc_evidence_get', { evidence_handle: handle }), tenantARead),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    const payload = resultPayload(retrieved);

    expect(payload.status).toBe('available');
    expect(payload.evidence_handle).toBe(handle);
    expect(payload.artifact).toMatchObject({
      evidence_handle: handle,
      provenance: {
        session_id: 'mcp-client-a',
        tenant_id: 'tenant-a',
        target_id: 'tab-a',
        worker_id: 'worker-a',
        page_url: 'https://example.com/account',
        captured_at: '2026-07-28T12:00:00.000Z',
        contract_source: 'inline',
        verdict: 'pass',
      },
      trace: { status: 'unavailable' },
    });
  });

  test('failed verdicts are durable and cross-session/tenant retrieval is denied', async () => {
    const asserted = await server.handleMessage(
      authenticated(toolCall(1, 'oc_assert', {
        contract: { kind: 'url', pattern: '^https://other\\.example$' },
        evidence: { snapshot: { url: 'https://example.com' } },
      }), tenantAWrite),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    const handle = resultPayload(asserted).evidence_handle as string;

    const crossSession = await server.handleMessage(
      authenticated(toolCall(2, 'oc_evidence_get', { evidence_handle: handle }), tenantARead),
      undefined,
      { mcpSessionId: 'client-b' },
    ) as MCPResponse;
    expect(crossSession.result?.isError).toBe(true);
    expect(resultPayload(crossSession)).toMatchObject({
      status: 'error',
      error: { code: 'EVIDENCE_FORBIDDEN' },
    });

    const crossTenant = await server.handleMessage(
      authenticated(toolCall(3, 'oc_evidence_get', { evidence_handle: handle }), tenantBRead),
      undefined,
      { mcpSessionId: 'client-c' },
    ) as MCPResponse;
    expect(crossTenant.result?.isError).toBe(true);
    expect(resultPayload(crossTenant)).toMatchObject({
      status: 'error',
      error: { code: 'EVIDENCE_FORBIDDEN' },
    });
  });

  test('sessions/delete removes launch-free evidence even when no browser session exists', async () => {
    const asserted = await server.handleMessage(
      authenticated(toolCall(1, 'oc_assert', {
        contract: { kind: 'url', pattern: 'example' },
        evidence: { snapshot: { url: 'https://example.com' } },
      }), tenantAWrite),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    const handle = resultPayload(asserted).evidence_handle as string;

    await server.handleMessage(authenticated({
      jsonrpc: '2.0',
      id: 2,
      method: 'sessions/delete',
      params: { sessionId: 'mcp-client-a' },
    }, tenantAWrite), undefined, { mcpSessionId: 'client-a' });

    const deleted = await server.handleMessage(
      authenticated(toolCall(3, 'oc_evidence_get', { evidence_handle: handle }), tenantARead),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    expect(resultPayload(deleted)).toMatchObject({
      status: 'error',
      error: { code: 'EVIDENCE_NOT_FOUND' },
    });
  });

  test('missing, expired, and malformed handles return stable MCP error codes', async () => {
    let now = 1_000;
    store = new AssertEvidenceStore({ rootDir, ttlMs: 10, now: () => now });
    setAssertEvidenceStoreForTests(store);
    server = new MCPServer(createMockSessionManager() as never);
    registerOcAssertTool(server, undefined, store);
    registerOcEvidenceGetTool(server, store);

    const asserted = await server.handleMessage(
      authenticated(toolCall(1, 'oc_assert', {
        contract: { kind: 'url', pattern: 'example' },
        evidence: { snapshot: { url: 'https://example.com' } },
      }), tenantAWrite),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    const handle = resultPayload(asserted).evidence_handle as string;
    now = 1_011;

    const missing = await server.handleMessage(
      authenticated(toolCall(2, 'oc_evidence_get', {}), tenantARead),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    expect(resultPayload(missing)).toMatchObject({
      status: 'error',
      error: { code: 'EVIDENCE_HANDLE_REQUIRED' },
    });

    const wrongType = await server.handleMessage(
      authenticated(toolCall(3, 'oc_evidence_get', { evidence_handle: 42 }), tenantARead),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    expect(resultPayload(wrongType)).toMatchObject({
      status: 'error',
      error: { code: 'EVIDENCE_HANDLE_MALFORMED' },
    });

    const expired = await server.handleMessage(
      authenticated(toolCall(4, 'oc_evidence_get', { evidence_handle: handle }), tenantARead),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    expect(resultPayload(expired)).toMatchObject({
      status: 'error',
      error: { code: 'EVIDENCE_EXPIRED' },
    });

    const malformed = await server.handleMessage(
      authenticated(toolCall(5, 'oc_evidence_get', { evidence_handle: '../escape' }), tenantARead),
      undefined,
      { mcpSessionId: 'client-a' },
    ) as MCPResponse;
    expect(resultPayload(malformed)).toMatchObject({
      status: 'error',
      error: { code: 'EVIDENCE_HANDLE_MALFORMED' },
    });
  });
});
