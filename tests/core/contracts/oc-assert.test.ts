/// <reference types="jest" />

/**
 * Tests for the `oc_assert` MCP tool (issue #784).
 *
 * Covers:
 *  - registration into a mock server
 *  - pass / fail / inconclusive verdicts
 *  - failed_assertions extraction for leaf + logical (`and`) failures
 *  - one case per evaluator that is practical to drive from a snapshot
 *
 * The `evidence_handle` is a forward-reference placeholder for #792
 * (oc_evidence_bundle). It is asserted only by shape — not consumed.
 */

import { registerOcAssertTool, deriveFailureCategory } from '../../../src/tools/oc-assert';
import type { MCPToolDefinition, MCPResult, ToolHandler } from '../../../src/types/mcp';
import type { Evidence } from '../../../src/contracts/types';

interface RegisteredTool {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
}

class MockServer {
  public tools = new Map<string, RegisteredTool>();
  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { name, handler, definition });
  }
}

function parseResult(result: MCPResult): Record<string, unknown> {
  const text = result.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text as string) as Record<string, unknown>;
}

async function invoke(
  handler: ToolHandler,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await handler('test-session', args);
  return parseResult(result);
}

function setup(): { handler: ToolHandler; definition: MCPToolDefinition } {
  const server = new MockServer();
  registerOcAssertTool(server as unknown as Parameters<typeof registerOcAssertTool>[0]);
  const registered = server.tools.get('oc_assert');
  expect(registered).toBeDefined();
  return { handler: registered!.handler, definition: registered!.definition };
}

describe('oc_assert — registration', () => {
  test('registers a tool named oc_assert with an object schema', () => {
    const { definition } = setup();
    expect(definition.name).toBe('oc_assert');
    expect(definition.inputSchema.type).toBe('object');
    expect(definition.description).toMatch(/Outcome Contract/);
  });
});

describe('oc_assert — verdicts', () => {
  test('pass: url assertion against matching snapshot', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'url', pattern: '^https://example\\.com/?$' },
      evidence: { snapshot: { url: 'https://example.com' } },
    });
    expect(out.verdict).toBe('pass');
    expect(out.failed_assertions).toBeUndefined();
    expect(typeof out.evidence_handle).toBe('string');
    expect((out.evidence_handle as string).startsWith('ev_')).toBe(true);
  });

  test('fail: url assertion returns failed_assertions array', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'url', pattern: '^https://other\\.com' },
      evidence: { snapshot: { url: 'https://example.com' } },
    });
    expect(out.verdict).toBe('fail');
    const failed = out.failed_assertions as Array<Record<string, unknown>>;
    expect(Array.isArray(failed)).toBe(true);
    expect(failed.length).toBe(1);
    expect((failed[0].expected as { pattern: string }).pattern).toBe('^https://other\\.com');
    expect(failed[0].actual).toBe('https://example.com');
  });

  test('fail: surfaces a machine-stable failure_category (POSTCONDITION_FAILED for a clean mismatch)', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'url', pattern: '^https://other\\.com' },
      evidence: { snapshot: { url: 'https://example.com' } },
    });
    expect(out.verdict).toBe('fail');
    // A clean expected/actual mismatch (no evaluator error) classifies as a
    // postcondition failure so the host can branch recovery on a stable code.
    expect(out.failure_category).toBe('POSTCONDITION_FAILED');
    expect(typeof out.failure_reason).toBe('string');
  });

  test('pass / inconclusive verdicts carry no failure_category', async () => {
    const { handler } = setup();
    const pass = await invoke(handler, {
      contract: { kind: 'url', pattern: '^https://example\\.com/?$' },
      evidence: { snapshot: { url: 'https://example.com' } },
    });
    expect(pass.verdict).toBe('pass');
    expect(pass.failure_category).toBeUndefined();

    const inconclusive = await invoke(handler, {
      contract: { kind: 'url', pattern: '^x$' },
    });
    expect(inconclusive.verdict).toBe('inconclusive');
    expect(inconclusive.failure_category).toBeUndefined();
  });

  test('inconclusive: missing evidence.snapshot', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'url', pattern: '.*' },
    });
    expect(out.verdict).toBe('inconclusive');
    expect(typeof out.inconclusive_reason).toBe('string');
  });

  test('inconclusive: missing contract entirely', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {});
    expect(out.verdict).toBe('inconclusive');
    expect(out.inconclusive_reason).toMatch(/contract/);
  });

  test('inconclusive: contract_id supplied without a registry', async () => {
    const { handler } = setup();
    const out = await invoke(handler, { contract_id: 'cart_visible' });
    expect(out.verdict).toBe('inconclusive');
    expect(out.inconclusive_reason).toMatch(/contract_id/);
  });

  test('inconclusive: schema validation failure surfaces errors', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'url' /* missing pattern */ },
      evidence: { snapshot: { url: 'https://example.com' } },
    });
    expect(out.verdict).toBe('inconclusive');
    const errors = out.validation_errors as Array<{ path: string; message: string }>;
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('oc_assert — per-evaluator coverage', () => {
  test('dom_text: explicit selector hit', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'dom_text', selector: 'h1', contains: 'Cart' },
      evidence: { snapshot: { dom_text: { h1: 'Cart Total' } } },
    });
    expect(out.verdict).toBe('pass');
  });

  test('dom_text: default selector reads the string snapshot', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'dom_text', contains: 'Welcome' },
      evidence: { snapshot: { dom_text: 'Welcome to the site' } },
    });
    expect(out.verdict).toBe('pass');
  });

  test('dom_count: gte passes when observed >= target', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'dom_count', selector: 'li.item', op: 'gte', value: 3 },
      evidence: { snapshot: { dom_count: { 'li.item': 5 } } },
    });
    expect(out.verdict).toBe('pass');
  });

  test('network: matching status passes', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: {
        kind: 'network',
        url_pattern: '/api/cart',
        status_in: [200],
        since: 'last_tool_call',
      },
      evidence: {
        snapshot: {
          network: [{ url: 'https://example.com/api/cart', status: 200, ts: 1 }],
        },
      },
    });
    expect(out.verdict).toBe('pass');
  });

  test('no_dialog: passes when no dialog is open', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'no_dialog' },
      evidence: { snapshot: { has_open_dialog: false } },
    });
    expect(out.verdict).toBe('pass');
  });

  test('no_dialog: fails when a dialog is open', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'no_dialog' },
      evidence: { snapshot: { has_open_dialog: true } },
    });
    expect(out.verdict).toBe('fail');
  });

  test('screenshot_class: inconclusive without registry hook', async () => {
    // The default snapshot-driven EvalContext does not provide
    // loadScreenshotClass, so the evaluator records an error in
    // evidence.details — surfaced as `inconclusive`.
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: { kind: 'screenshot_class', class_id: 'cart.empty', distance_max: 8 },
      evidence: {
        snapshot: {
          // 1×1 transparent PNG, base64 — content does not matter, the
          // registry hook is what is missing.
          screenshot_png_base64:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        },
      },
    });
    expect(out.verdict).toBe('inconclusive');
  });

  test('and: short-circuits and surfaces the failing leaf in failed_assertions', async () => {
    const { handler } = setup();
    const out = await invoke(handler, {
      contract: {
        kind: 'and',
        children: [
          { kind: 'url', pattern: '^https://example\\.com' },
          { kind: 'dom_text', selector: 'h1', contains: 'NotPresent' },
        ],
      },
      evidence: {
        snapshot: {
          url: 'https://example.com',
          dom_text: { h1: 'Cart Total' },
        },
      },
    });
    expect(out.verdict).toBe('fail');
    const failed = out.failed_assertions as Array<{ name: string }>;
    expect(failed.length).toBe(1);
    // The failing leaf is the dom_text child at index 1.
    expect(failed[0].name).toContain('dom_text');
    expect(failed[0].name).toContain('children.1');
  });
});

describe('deriveFailureCategory — host-actionable taxonomy', () => {
  const failEvidence = (details: Record<string, unknown> = {}): Evidence => ({
    passed: false,
    assertion_kind: 'and',
    details,
  });

  test('clean expected/actual mismatch (no evaluator error) → POSTCONDITION_FAILED', () => {
    const out = deriveFailureCategory(failEvidence(), [
      { name: '$[url]', expected: { pattern: '^x$' }, actual: 'https://example.com' },
    ]);
    expect(out.category).toBe('POSTCONDITION_FAILED');
    expect(out.reason).toMatch(/postcondition/i);
  });

  test('classifies an evaluator error surfaced on a failed child leaf (ELEMENT_NOT_FOUND)', () => {
    // A logical (and/or) failure can crack open to a child leaf whose `actual`
    // carries an evaluator error string — that error is classified, not the diff.
    const out = deriveFailureCategory(failEvidence(), [
      { name: '$.children.0[dom_text]', expected: {}, actual: { error: 'element not found: .add-to-cart' } },
    ]);
    expect(out.category).toBe('ELEMENT_NOT_FOUND');
    expect(out.reason.length).toBeGreaterThan(0);
  });

  test('classifies a navigation-timeout error string', () => {
    const out = deriveFailureCategory(failEvidence({ error: 'navigation timeout exceeded' }), []);
    expect(out.category).toBe('NAVIGATION_TIMEOUT');
  });

  test('unclassifiable error text falls back to POSTCONDITION_FAILED (never UNKNOWN)', () => {
    const out = deriveFailureCategory(failEvidence(), [
      { name: '$[dom_text]', expected: {}, actual: { error: 'totally opaque failure xyzzy' } },
    ]);
    expect(out.category).toBe('POSTCONDITION_FAILED');
  });

  test('ignores non-object / non-string actual values without throwing', () => {
    const out = deriveFailureCategory(failEvidence(), [
      { name: '$[url]', expected: {}, actual: null },
      { name: '$[count]', expected: {}, actual: 3 },
      { name: '$[list]', expected: {}, actual: ['element not found'] },
    ]);
    expect(out.category).toBe('POSTCONDITION_FAILED');
  });
});
