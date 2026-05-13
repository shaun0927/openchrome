/// <reference types="jest" />
/**
 * Tests for cli/playbook/run.ts
 *
 * Uses an in-process mock MCP client to verify:
 *   1. Call ordering — tools are called in step order with correct args
 *   2. Fail-fast skip — steps after a failure are skipped, not executed
 *   3. Exit code semantics — summary.ok reflects pass/fail/skip correctly
 *   4. JSON output shape — RunResult matches the documented snapshot schema
 *   5. Assert verdict propagation — 'pass' vs 'fail' verdict drives step status
 *   6. Transport error escalation — connect() rejection throws TransportError
 */

import { runPlaybook, RunResult, RunOptions } from '../../../cli/playbook/run';
import type { Playbook } from '../../../cli/playbook/parse';
import { TransportError } from '../../../cli/playbook/stdio-client';
import type { CallResult } from '../../../cli/playbook/stdio-client';

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

type ToolCall = { tool: string; args: Record<string, unknown> };

interface MockClientOptions {
  /** Map of tool name → result to return. Missing tools return success:true. */
  results?: Record<string, CallResult>;
  /** If set, connect() will reject with this error. */
  connectError?: Error;
}

function makeMockClient(opts: MockClientOptions = {}): {
  client: RunOptions['client'];
  calls: ToolCall[];
  disconnected: boolean;
} {
  const calls: ToolCall[] = [];
  let disconnected = false;

  const client: RunOptions['client'] = {
    async connect(_reuse: boolean): Promise<void> {
      if (opts.connectError) throw opts.connectError;
    },
    async callTool(tool: string, args: Record<string, unknown>): Promise<CallResult> {
      calls.push({ tool, args });
      if (opts.results && Object.prototype.hasOwnProperty.call(opts.results, tool)) {
        return opts.results[tool];
      }
      return { success: true, result: { content: [{ type: 'text', text: '{}' }] } };
    },
    async disconnect(): Promise<void> {
      disconnected = true;
    },
  };

  return { client, calls, disconnected: false };
}

// ---------------------------------------------------------------------------
// Fixture playbooks
// ---------------------------------------------------------------------------

const sanityPlaybook: Playbook = {
  name: 'sanity',
  vars: { url: 'https://example.com' },
  steps: [
    { verb: 'navigate', args: { url: '${url}' } },
    { verb: 'assert', args: { kind: 'dom_text', selector: 'h1', pattern: 'Example' } },
    { verb: 'interact', args: { ref: 'More information…' } },
  ],
};

const failFastPlaybook: Playbook = {
  name: 'fail-fast fixture',
  steps: [
    { verb: 'navigate', args: { url: 'https://example.com' } },
    { verb: 'assert', args: { kind: 'url', pattern: 'WILL_NOT_MATCH' } },
    { verb: 'interact', args: { ref: 'should be skipped' } },
  ],
};

// ---------------------------------------------------------------------------
// Test 1: Call ordering
// ---------------------------------------------------------------------------

describe('runPlaybook — call ordering', () => {
  test('calls MCP tools in step order with correct tool names and args', async () => {
    const { client, calls } = makeMockClient();
    const varMap = { url: 'https://example.com' };

    await runPlaybook(sanityPlaybook, { reuse: false, varMap, client });

    expect(calls).toHaveLength(3);

    // Step 0: navigate → tool 'navigate', url substituted
    expect(calls[0].tool).toBe('navigate');
    expect(calls[0].args).toEqual({ url: 'https://example.com' });

    // Step 1: assert → tool 'oc_assert', wrapped in contract field
    expect(calls[1].tool).toBe('oc_assert');
    expect(calls[1].args).toEqual({
      contract: { kind: 'dom_text', selector: 'h1', pattern: 'Example' },
    });

    // Step 2: interact → tool 'interact', args pass-through
    expect(calls[2].tool).toBe('interact');
    expect(calls[2].args).toEqual({ ref: 'More information…' });
  });

  test('calls disconnect after run regardless of outcome', async () => {
    const mock = makeMockClient();
    const { client } = mock;
    let disconnectCalled = false;
    const wrappedClient: RunOptions['client'] = {
      connect: client!.connect.bind(client),
      callTool: client!.callTool.bind(client),
      disconnect: async () => { disconnectCalled = true; },
    };

    await runPlaybook(sanityPlaybook, { reuse: false, varMap: { url: 'https://example.com' }, client: wrappedClient });
    expect(disconnectCalled).toBe(true);
  });

  test('reuses navigate tabId for subsequent same-tab browser steps', async () => {
    const tabPlaybook: Playbook = {
      name: 'same-tab form',
      steps: [
        { verb: 'navigate', args: { url: 'https://example.com/form' } },
        { verb: 'fill_form', args: { fields: { name: 'OpenChrome' } } },
      ],
    };
    const { client, calls } = makeMockClient({
      results: {
        navigate: { success: true, result: { tabId: 'tab-123' } },
        fill_form: { success: true, result: { ok: true } },
      },
    });

    const result = await runPlaybook(tabPlaybook, { reuse: false, varMap: {}, client });

    expect(result.summary.ok).toBe(true);
    expect(calls[1]).toEqual({
      tool: 'fill_form',
      args: { fields: { name: 'OpenChrome' }, tabId: 'tab-123' },
    });
  });
});

// ---------------------------------------------------------------------------
// Test 2: Fail-fast skip
// ---------------------------------------------------------------------------

describe('runPlaybook — fail-fast semantics', () => {
  test('skips steps after a failed step — does not call their tools', async () => {
    const { client, calls } = makeMockClient({
      results: {
        // navigate succeeds
        navigate: { success: true, result: null },
        // oc_assert fails (verdict=fail)
        oc_assert: { success: false, result: null, verdict: 'fail' },
      },
    });

    const result = await runPlaybook(failFastPlaybook, { reuse: false, varMap: {}, client });

    // Only navigate + oc_assert should have been called; interact must be skipped
    expect(calls).toHaveLength(2);
    expect(calls[0].tool).toBe('navigate');
    expect(calls[1].tool).toBe('oc_assert');

    // Step 2 (interact) must be 'skipped' in the result
    expect(result.steps[2].status).toBe('skipped');
    expect(result.steps[2].durationMs).toBe(0);
  });

  test('marks failed step as failed and all subsequent as skipped', async () => {
    const { client } = makeMockClient({
      results: {
        navigate: { success: true, result: null },
        oc_assert: { success: false, result: null, verdict: 'fail' },
      },
    });

    const result = await runPlaybook(failFastPlaybook, { reuse: false, varMap: {}, client });

    expect(result.steps[0].status).toBe('ok');
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[2].status).toBe('skipped');
  });

  test('summary reflects failed + skipped counts', async () => {
    const { client } = makeMockClient({
      results: {
        navigate: { success: true, result: null },
        oc_assert: { success: false, result: null },
      },
    });

    const result = await runPlaybook(failFastPlaybook, { reuse: false, varMap: {}, client });

    expect(result.summary.ok).toBe(false);
    expect(result.summary.total).toBe(3);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Exit code semantics via summary.ok
// ---------------------------------------------------------------------------

describe('runPlaybook — exit code semantics (summary.ok)', () => {
  test('summary.ok === true when all steps pass (exit 0 path)', async () => {
    const { client } = makeMockClient({
      results: {
        navigate: { success: true, result: null },
        oc_assert: { success: true, result: null, verdict: 'pass' },
        interact: { success: true, result: null },
      },
    });
    const varMap = { url: 'https://example.com' };

    const result = await runPlaybook(sanityPlaybook, { reuse: false, varMap, client });

    expect(result.summary.ok).toBe(true);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.skipped).toBe(0);
  });

  test('summary.ok === false when any step fails (exit 1 path)', async () => {
    const { client } = makeMockClient({
      results: {
        navigate: { success: false, result: null },
      },
    });

    const result = await runPlaybook(failFastPlaybook, { reuse: false, varMap: {}, client });

    expect(result.summary.ok).toBe(false);
  });

  test('summary.ok === false when skipped steps exist (partial run)', async () => {
    const { client } = makeMockClient({
      results: {
        navigate: { success: true, result: null },
        oc_assert: { success: false, result: null },
        // interact is skipped — never called
      },
    });

    const result = await runPlaybook(failFastPlaybook, { reuse: false, varMap: {}, client });

    expect(result.summary.ok).toBe(false);
    expect(result.summary.skipped).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: JSON output shape (snapshot)
// ---------------------------------------------------------------------------

describe('runPlaybook — JSON output shape', () => {
  test('RunResult matches documented schema shape', async () => {
    const { client } = makeMockClient({
      results: {
        navigate: { success: true, result: { url: 'https://example.com' } },
        oc_assert: { success: true, result: { verdict: 'pass' }, verdict: 'pass' },
        interact: { success: true, result: null },
      },
    });
    const varMap = { url: 'https://example.com' };

    const result = await runPlaybook(sanityPlaybook, { reuse: false, varMap, client });

    // Top-level fields
    expect(result).toHaveProperty('name', 'sanity');
    expect(result).toHaveProperty('steps');
    expect(result).toHaveProperty('summary');
    expect(Array.isArray(result.steps)).toBe(true);

    // Each step matches the StepResult shape
    for (const step of result.steps) {
      expect(typeof step.index).toBe('number');
      expect(typeof step.verb).toBe('string');
      expect(typeof step.tool).toBe('string');
      expect(typeof step.args).toBe('object');
      expect(['ok', 'failed', 'skipped']).toContain(step.status);
      expect(typeof step.durationMs).toBe('number');
    }

    // Summary shape
    const { summary } = result;
    expect(typeof summary.ok).toBe('boolean');
    expect(typeof summary.total).toBe('number');
    expect(typeof summary.passed).toBe('number');
    expect(typeof summary.failed).toBe('number');
    expect(typeof summary.skipped).toBe('number');
    expect(summary.total).toBe(3);
    expect(summary.passed + summary.failed + summary.skipped).toBe(summary.total);
  });

  test('JSON-serialisable — round-trips through JSON.parse(JSON.stringify())', async () => {
    const { client } = makeMockClient();
    const varMap = { url: 'https://example.com' };

    const result = await runPlaybook(sanityPlaybook, { reuse: false, varMap, client });
    const serialised = JSON.parse(JSON.stringify(result)) as RunResult;

    expect(serialised.name).toBe(result.name);
    expect(serialised.summary.total).toBe(result.summary.total);
    expect(serialised.steps).toHaveLength(result.steps.length);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Assert verdict propagation
// ---------------------------------------------------------------------------

describe('runPlaybook — assert verdict propagation', () => {
  test('assert step with verdict=pass is ok', async () => {
    const assertPlaybook: Playbook = {
      name: 'assert-pass',
      steps: [{ verb: 'assert', args: { kind: 'url', pattern: 'example\\.com' } }],
    };

    const { client } = makeMockClient({
      results: {
        oc_assert: { success: true, result: { verdict: 'pass' }, verdict: 'pass' },
      },
    });

    const result = await runPlaybook(assertPlaybook, { reuse: false, varMap: {}, client });

    expect(result.steps[0].status).toBe('ok');
    expect(result.summary.ok).toBe(true);
  });

  test('assert step with verdict=fail marks step failed', async () => {
    const assertPlaybook: Playbook = {
      name: 'assert-fail',
      steps: [{ verb: 'assert', args: { kind: 'url', pattern: 'WILL_NOT_MATCH' } }],
    };

    const { client } = makeMockClient({
      results: {
        oc_assert: { success: false, result: null, verdict: 'fail' },
      },
    });

    const result = await runPlaybook(assertPlaybook, { reuse: false, varMap: {}, client });

    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error).toMatch(/assert/i);
    expect(result.summary.ok).toBe(false);
  });

  test('assert step with verdict=inconclusive counts as failure', async () => {
    const assertPlaybook: Playbook = {
      name: 'assert-inconclusive',
      steps: [{ verb: 'assert', args: { kind: 'dom_text', selector: 'h1', pattern: 'X' } }],
    };

    const { client } = makeMockClient({
      results: {
        // success:false signals non-pass regardless of verdict string
        oc_assert: { success: false, result: null, verdict: 'inconclusive' },
      },
    });

    const result = await runPlaybook(assertPlaybook, { reuse: false, varMap: {}, client });

    expect(result.steps[0].status).toBe('failed');
    expect(result.summary.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Transport error escalation
// ---------------------------------------------------------------------------

describe('runPlaybook — transport error escalation', () => {
  test('connect() failure throws TransportError (exit 3 path)', async () => {
    const { client } = makeMockClient({
      connectError: new Error('ECONNREFUSED'),
    });

    await expect(
      runPlaybook(sanityPlaybook, { reuse: false, varMap: { url: 'https://example.com' }, client }),
    ).rejects.toThrow(TransportError);
  });

  test('callTool() rejection marks step failed and stops playbook', async () => {
    let callCount = 0;
    const client: RunOptions['client'] = {
      async connect() {},
      async callTool(tool) {
        callCount++;
        if (tool === 'oc_assert') throw new Error('network timeout');
        return { success: true, result: null };
      },
      async disconnect() {},
    };

    const result = await runPlaybook(failFastPlaybook, { reuse: false, varMap: {}, client });

    // navigate + oc_assert called; interact must be skipped
    expect(callCount).toBe(2);
    expect(result.steps[1].status).toBe('failed');
    expect(result.steps[1].error).toContain('network timeout');
    expect(result.steps[2].status).toBe('skipped');
  });
});
