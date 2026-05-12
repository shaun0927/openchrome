/// <reference types="jest" />

/**
 * Tests for the oc_performance_analyze MCP tool (#846).
 *
 * Direct-handler tests — no real Chrome required. We populate the
 * shared PerfTraceStore singleton, invoke the tool's registered
 * handler via a stub MCPServer, and assert on the JSON payload.
 */

import {
  PerfTraceStore,
  setPerfTraceStoreForTests,
} from '../../src/core/performance/insights/trace-store';
import { INSIGHT_NAMES } from '../../src/core/performance/insights';
import { registerOcPerformanceAnalyzeTool } from '../../src/tools/oc-performance-analyze';
import { richTrace } from '../core/performance/fixtures/sample-trace';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface RegisteredTool {
  handler: (sessionId: string, args: Record<string, unknown>) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
    [key: string]: unknown;
  }>;
}

class StubServer {
  tools = new Map<string, RegisteredTool>();
  registerTool(name: string, handler: RegisteredTool['handler']): void {
    this.tools.set(name, { handler });
  }
}

function mkStore(): PerfTraceStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-analyze-test-'));
  return new PerfTraceStore({ rootDir: root });
}

function parsePayload(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('oc_performance_analyze handler', () => {
  let store: PerfTraceStore;
  let server: StubServer;
  let handler: RegisteredTool['handler'];

  beforeEach(() => {
    store = mkStore();
    setPerfTraceStoreForTests(store);
    server = new StubServer();
    registerOcPerformanceAnalyzeTool(server as unknown as Parameters<typeof registerOcPerformanceAnalyzeTool>[0]);
    handler = server.tools.get('oc_performance_analyze')!.handler;
  });

  afterEach(() => {
    setPerfTraceStoreForTests(null);
  });

  test('returns details + evidence for a valid trace_id + insight', async () => {
    const handle = store.store({ sessionId: 's-1', events: richTrace().traceEvents });
    const result = await handler('s-1', { trace_id: handle.trace_id, insight: 'LCPBreakdown' });
    expect(result.isError).toBeFalsy();
    const payload = parsePayload(result);
    expect(payload.insight).toBe('LCPBreakdown');
    expect(typeof payload.details_md).toBe('string');
    expect(Array.isArray(payload.evidence)).toBe(true);
  });

  test('unknown insight returns structured error with supported list', async () => {
    const handle = store.store({ sessionId: 's-1', events: richTrace().traceEvents });
    const result = await handler('s-1', { trace_id: handle.trace_id, insight: 'NotARealInsight' });
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toBe('unknown_insight');
    expect(payload.supported).toEqual([...INSIGHT_NAMES]);
  });

  test('missing insight argument is treated as unknown_insight', async () => {
    const handle = store.store({ sessionId: 's-1', events: richTrace().traceEvents });
    const result = await handler('s-1', { trace_id: handle.trace_id });
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toBe('unknown_insight');
  });

  test('unknown trace_id returns structured error', async () => {
    const result = await handler('s-1', {
      trace_id: '00000000-0000-0000-0000-000000000000',
      insight: 'LCPBreakdown',
    });
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toBe('unknown_trace_id');
  });

  test('missing trace_id returns trace_id-required error', async () => {
    const result = await handler('s-1', { insight: 'LCPBreakdown' });
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toMatch(/trace_id/);
  });
});
