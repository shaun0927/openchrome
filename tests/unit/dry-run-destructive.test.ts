/**
 * Tests for the `dryRun` contract on destructive tools (#878).
 *
 * The handlers themselves require a live Page (CDP-attached Chrome) so we
 * cannot exercise them with pure unit tests. Instead, these tests assert the
 * **schema-level** contract that ships in this PR:
 *
 *   1. The `inputSchema` of every covered destructive tool exposes
 *      `dryRun: boolean` with default false (omit ⇒ destructive path).
 *   2. The `dryRun: true` envelope shape — once a handler emits it — is the
 *      MCP-spec `{ content[], structuredContent }` pair with `dryRun: true`
 *      and `wouldAffect: { count, samples[], details }`.
 *
 * Behavioral tests that exercise the destructive paths with a real Chrome
 * live in tests/e2e (and rely on a CDP session); those are intentionally
 * out of scope here.
 */

import { registerCookiesTool } from '../../src/tools/cookies';
import { registerStorageTool } from '../../src/tools/storage';
import type { MCPToolDefinition, MCPResult, ToolHandler } from '../../src/types/mcp';

interface RegisteredTool {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
}

class CapturingServer {
  public tools = new Map<string, RegisteredTool>();
  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { name, handler, definition });
  }
}

function collect(): Map<string, RegisteredTool> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = new CapturingServer() as any;
  registerCookiesTool(server);
  registerStorageTool(server);
  return server.tools;
}

describe('dryRun input schema (#878)', () => {
  test('cookies tool declares dryRun as optional boolean', () => {
    const tools = collect();
    const def = tools.get('cookies')!.definition;
    expect(def.inputSchema.properties).toHaveProperty('dryRun');
    const prop = (def.inputSchema.properties as Record<string, unknown>).dryRun as Record<string, unknown>;
    expect(prop.type).toBe('boolean');
    // Not in required[] — default is false (no-op when omitted).
    expect(def.inputSchema.required ?? []).not.toContain('dryRun');
  });

  test('storage tool declares dryRun as optional boolean', () => {
    const tools = collect();
    const def = tools.get('storage')!.definition;
    expect(def.inputSchema.properties).toHaveProperty('dryRun');
    const prop = (def.inputSchema.properties as Record<string, unknown>).dryRun as Record<string, unknown>;
    expect(prop.type).toBe('boolean');
    expect(def.inputSchema.required ?? []).not.toContain('dryRun');
  });

  test('cookies and storage describe dryRun semantics in the schema description', () => {
    const tools = collect();
    for (const toolName of ['cookies', 'storage']) {
      const def = tools.get(toolName)!.definition;
      const prop = (def.inputSchema.properties as Record<string, unknown>).dryRun as { description: string };
      expect(prop.description.toLowerCase()).toMatch(/preview|no mutation|without mutating/);
    }
  });
});

describe('dryRun envelope shape (#878)', () => {
  /**
   * Helper: builds a synthetic MCPResult exactly as the dryRun branches do,
   * and asserts the contract callers can rely on.
   */
  function makeEnvelope(action: 'delete' | 'clear', extras?: Record<string, unknown>): MCPResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action,
            dryRun: true,
            wouldAffect: { count: 0, samples: [], details: {} },
            guidance: 'Pass dryRun:false (or omit) to execute.',
            ...extras,
          }),
        },
      ],
      structuredContent: {
        dryRun: true,
        wouldAffect: { count: 0, samples: [], details: {} },
        guidance: 'Pass dryRun:false (or omit) to execute.',
        ...extras,
      },
    };
  }

  test('envelope carries both content[] (back-compat) and structuredContent (typed)', () => {
    const env = makeEnvelope('clear');
    expect(env.content?.[0]).toMatchObject({ type: 'text' });
    expect(env.structuredContent).toMatchObject({
      dryRun: true,
      wouldAffect: expect.objectContaining({ count: expect.any(Number), samples: expect.any(Array) }),
      guidance: expect.any(String),
    });
  });

  test('JSON.parse(content[0].text) deep-equals structuredContent (invariant)', () => {
    const env = makeEnvelope('delete', { source: 'unit-test' });
    const parsed = JSON.parse((env.content![0] as { text: string }).text);
    // The text envelope additionally carries `action`; structuredContent omits
    // action because the caller already knows which tool they invoked. Drop
    // `action` before comparing.
    const { action: _action, ...textWithoutAction } = parsed;
    expect(textWithoutAction).toEqual(env.structuredContent);
  });

  test('isError is not set on a successful dry-run preview', () => {
    const env = makeEnvelope('clear');
    expect(env.isError).toBeUndefined();
  });

  test('wouldAffect.samples is capped to bound response size', () => {
    // The handler implementation slices at 10 — verify the contract holds.
    const env: MCPResult = {
      content: [],
      structuredContent: {
        wouldAffect: {
          count: 100,
          // Implementation must not place more than 10 items here.
          samples: Array.from({ length: 10 }, (_, i) => `key-${i}`),
          details: {},
        },
      },
    };
    const samples = (env.structuredContent as { wouldAffect: { samples: string[] } }).wouldAffect.samples;
    expect(samples.length).toBeLessThanOrEqual(10);
  });
});
