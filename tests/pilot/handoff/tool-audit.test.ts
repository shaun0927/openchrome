/**
 * Tests for the semantic audit events emitted by the pilot handoff MCP
 * tools (issue #733 verification surface).
 *
 * Two named events are exercised:
 *
 *   banner_injection
 *     - emitted by `oc_pilot_handoff_create` on success, carrying the
 *       freshly minted record's session/scope/expiry but never the raw
 *       token (the banner string also omits the token; we keep parity).
 *     - emitted by `oc_pilot_handoff_redeem` on success, marking the
 *       redemption-side banner surface.
 *
 *   handoff_token_resume
 *     - emitted by `oc_pilot_handoff_redeem` on success only. This is
 *       the moment the single-use token actually transferred its scope
 *       to a redeeming agent — auditors look for this kind to confirm
 *       a session was resumed by an external party.
 *
 * Both kinds are ADDITIVE to the automatic per-tool audit row emitted
 * by the MCP request pipeline; the tests therefore mock `logAuditEntry`
 * and assert ONLY against the calls made from inside the handoff tool
 * implementations. A lightweight stub server captures the registered
 * handlers so the suite does not instantiate the full MCPServer.
 */

import { jest } from '@jest/globals';

jest.mock('../../../src/security/audit-logger.js', () => ({
  logAuditEntry: jest.fn(),
}));

// `isHandoffPersistEnabled` is consulted on every call; default it to
// `true` so the handlers reach the audit emission paths. Individual
// tests can override per-call.
jest.mock('../../../src/harness/flags.js', () => ({
  isHandoffPersistEnabled: jest.fn(() => true),
}));

import { logAuditEntry } from '../../../src/security/audit-logger.js';
import { isHandoffPersistEnabled } from '../../../src/harness/flags.js';
import type { MCPServer } from '../../../src/mcp-server.js';
import type { MCPToolDefinition, ToolHandler } from '../../../src/types/mcp.js';
import {
  registerOcPilotHandoffTool,
  _resetHandoffManagerForTesting,
} from '../../../src/pilot/handoff/tool.js';

interface AuditCall {
  tool: string;
  sessionId: string;
  args: Record<string, unknown>;
}

function recordedAuditCalls(): AuditCall[] {
  const mock = logAuditEntry as unknown as jest.Mock;
  return mock.mock.calls.map((call) => ({
    tool: call[0] as string,
    sessionId: call[1] as string,
    args: call[2] as Record<string, unknown>,
  }));
}

function semanticOnly(calls: AuditCall[]): AuditCall[] {
  // We own the `banner_injection` + `handoff_token_resume` kinds. Any
  // other audit row in the mock would be unexpected — assert presence by
  // filtering down to ours rather than locking the negative-space list.
  return calls.filter(
    (c) => c.tool === 'banner_injection' || c.tool === 'handoff_token_resume',
  );
}

/**
 * Minimal MCPServer stub that captures whatever the handoff tool barrel
 * registers. Avoids constructing the real MCPServer (which would pull in
 * session-manager wiring, transport stubs, etc.) just to test two
 * audit emission call sites.
 */
class CapturingServer {
  readonly handlers = new Map<
    string,
    { handler: ToolHandler; definition: MCPToolDefinition }
  >();
  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.handlers.set(name, { handler, definition });
  }
}

function makeServer(): { server: MCPServer; capture: CapturingServer } {
  const capture = new CapturingServer();
  return { server: capture as unknown as MCPServer, capture };
}

function findHandler(capture: CapturingServer, name: string): ToolHandler {
  const entry = capture.handlers.get(name);
  if (!entry) throw new Error(`tool '${name}' not registered`);
  return entry.handler;
}

function parseOutput(result: unknown): Record<string, unknown> {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
  } & Record<string, unknown>;
  // Both shapes (content[0].text JSON, or the flat top-level spread copy)
  // are produced by the handler. Prefer the JSON text to assert exactly
  // what the agent receives over the wire.
  const text = r.content?.[0]?.text;
  if (typeof text === 'string') {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return r as Record<string, unknown>;
}

describe('pilot handoff MCP tools — semantic audit emissions', () => {
  let capture: CapturingServer;

  beforeEach(() => {
    (logAuditEntry as unknown as jest.Mock).mockClear();
    (isHandoffPersistEnabled as unknown as jest.Mock).mockReturnValue(true);
    _resetHandoffManagerForTesting();
    const made = makeServer();
    capture = made.capture;
    registerOcPilotHandoffTool(made.server);
  });

  afterEach(() => {
    _resetHandoffManagerForTesting();
  });

  it('registers both handoff tools', () => {
    expect(capture.handlers.has('oc_pilot_handoff_create')).toBe(true);
    expect(capture.handlers.has('oc_pilot_handoff_redeem')).toBe(true);
  });

  it('emits banner_injection on successful handoff_create with surface=handoff_create', async () => {
    const create = findHandler(capture, 'oc_pilot_handoff_create');
    const out = parseOutput(
      await create('caller-sess', { session_id: 'sess-A', scope: 'checkout' }),
    );
    expect(out.ok).toBe(true);

    const semantic = semanticOnly(recordedAuditCalls());
    expect(semantic).toHaveLength(1);
    expect(semantic[0]).toMatchObject({
      tool: 'banner_injection',
      sessionId: 'sess-A',
      args: { scope: 'checkout', surface: 'handoff_create' },
    });
    expect(typeof semantic[0].args.expires_at).toBe('number');
    expect(JSON.stringify(semantic[0].args)).not.toContain(out.token as string);
  });

  it('emits handoff_token_resume + banner_injection on successful handoff_redeem', async () => {
    const create = findHandler(capture, 'oc_pilot_handoff_create');
    const redeem = findHandler(capture, 'oc_pilot_handoff_redeem');

    const created = parseOutput(
      await create('caller-sess', { session_id: 'sess-B', scope: 'read-only' }),
    );
    expect(created.ok).toBe(true);

    (logAuditEntry as unknown as jest.Mock).mockClear();
    const out = parseOutput(await redeem('caller-sess', { token: created.token }));
    expect(out.ok).toBe(true);

    const semantic = semanticOnly(recordedAuditCalls());
    const kinds = semantic.map((c) => c.tool).sort();
    expect(kinds).toEqual(['banner_injection', 'handoff_token_resume']);

    const resume = semantic.find((c) => c.tool === 'handoff_token_resume')!;
    expect(resume.sessionId).toBe('sess-B');
    expect(resume.args).toMatchObject({ scope: 'read-only' });
    expect(typeof resume.args.created_at).toBe('number');
    expect(typeof resume.args.redeemed_at).toBe('number');

    const banner = semantic.find(
      (c) => c.tool === 'banner_injection' && c.args.surface === 'handoff_redeem',
    )!;
    expect(banner.sessionId).toBe('sess-B');
    expect(banner.args).toMatchObject({ scope: 'read-only', surface: 'handoff_redeem' });

    for (const call of semantic) {
      expect(JSON.stringify(call.args)).not.toContain(created.token as string);
    }
  });

  it('does NOT emit semantic audits when handoff_persist family is disabled', async () => {
    (isHandoffPersistEnabled as unknown as jest.Mock).mockReturnValue(false);
    const create = findHandler(capture, 'oc_pilot_handoff_create');
    const out = parseOutput(
      await create('caller-sess', { session_id: 'sess-C', scope: 'noop' }),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('disabled');
    expect(semanticOnly(recordedAuditCalls())).toHaveLength(0);
  });

  it('does NOT emit semantic audits on invalid_args (handoff_create)', async () => {
    const create = findHandler(capture, 'oc_pilot_handoff_create');
    const out = parseOutput(await create('caller-sess', { scope: 'x' }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('invalid_args');
    expect(semanticOnly(recordedAuditCalls())).toHaveLength(0);
  });

  it('does NOT emit semantic audits on unknown_token (handoff_redeem)', async () => {
    const redeem = findHandler(capture, 'oc_pilot_handoff_redeem');
    const out = parseOutput(
      await redeem('caller-sess', { token: 'definitely-not-a-real-token' }),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unknown_token');
    expect(semanticOnly(recordedAuditCalls())).toHaveLength(0);
  });

  it('redeem of an already-consumed token does not double-emit', async () => {
    const create = findHandler(capture, 'oc_pilot_handoff_create');
    const redeem = findHandler(capture, 'oc_pilot_handoff_redeem');

    const created = parseOutput(
      await create('caller-sess', { session_id: 'sess-D', scope: 'once' }),
    );
    expect(created.ok).toBe(true);
    expect(await redeem('caller-sess', { token: created.token })).toBeDefined();
    (logAuditEntry as unknown as jest.Mock).mockClear();

    const out = parseOutput(await redeem('caller-sess', { token: created.token }));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unknown_token');
    expect(semanticOnly(recordedAuditCalls())).toHaveLength(0);
  });

  it('audit failure does not break the verdict (best-effort)', async () => {
    (logAuditEntry as unknown as jest.Mock).mockImplementationOnce(() => {
      throw new Error('synthetic audit sink failure');
    });
    const create = findHandler(capture, 'oc_pilot_handoff_create');
    const out = parseOutput(
      await create('caller-sess', { session_id: 'sess-E', scope: 'best-effort' }),
    );
    expect(out.ok).toBe(true);
    expect(typeof out.token).toBe('string');
  });
});
