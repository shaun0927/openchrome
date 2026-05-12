/**
 * MCP tool surface for the pilot handoff primitive (Phase 3, issue #793).
 *
 * Exposes two tools, both gated by `isHandoffPersistEnabled()`:
 *
 *   oc_pilot_handoff_create   — mint a token for { sessionId, scope, ttlMs }
 *   oc_pilot_handoff_redeem   — exchange a token for the originating record
 *
 * The "handoff_persist" family flag covers both the in-memory primitive
 * (this PR) and the persistence layer (#794) because the two ship as a
 * unit — operators that want one want the other. When the flag is off,
 * the tools register but every call settles `{ ok: false, reason:
 * "disabled" }` so the agent receives a structured response rather than
 * a missing-tool error.
 *
 * Pilot-tier convention: this module owns its own process-wide singleton
 * `HandoffManager` so multiple registrations (one per server instance)
 * share the same in-memory store. Tests can swap it via
 * {@link _resetHandoffManagerForTesting}.
 */

import { MCPServer } from '../../mcp-server.js';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../../types/mcp.js';
import { isHandoffPersistEnabled } from '../../harness/flags.js';
import { HandoffManager } from './manager.js';
import { renderHandoffBanner } from './banner.js';
import { verifyHandoffToken, DEFAULT_TOKEN_TTL_MS } from './token.js';

/**
 * Process-wide handoff store. The singleton is intentional — pilot
 * registers tools per MCPServer instance, but a token minted on one
 * server must redeem on another (the whole point of handoff). Use
 * {@link _resetHandoffManagerForTesting} from tests to drop state.
 */
let manager: HandoffManager | undefined;

function getManager(): HandoffManager {
  if (manager === undefined) {
    manager = new HandoffManager();
  }
  return manager;
}

/**
 * Test-only hook. Disposes any existing manager (clearing its timer) and
 * lets the next `getManager()` call create a fresh one. Exposed with a
 * leading underscore so production callers do not depend on it.
 */
export function _resetHandoffManagerForTesting(): void {
  if (manager !== undefined) {
    manager.dispose();
    manager = undefined;
  }
}

interface CreateOutput extends Record<string, unknown> {
  ok: boolean;
  reason?: 'disabled' | 'invalid_args';
  token?: string;
  expires_at?: number;
  banner?: string;
  scope?: string;
  session_id?: string;
  error_message?: string;
}

interface RedeemOutput extends Record<string, unknown> {
  ok: boolean;
  reason?: 'disabled' | 'invalid_args' | 'unknown_token';
  session_id?: string;
  scope?: string;
  expires_at?: number;
  created_at?: number;
  redeemed_at?: number;
  banner?: string;
  error_message?: string;
}

const createDefinition: MCPToolDefinition = {
  name: 'oc_pilot_handoff_create',
  description:
    'Pilot-tier: mint a single-use handoff token that lets another agent ' +
    'inherit the named browser session. In-memory only; process restart ' +
    'drops every active handoff. Gated by --pilot + handoff_persist family.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Browser session being transferred. Required.',
      },
      scope: {
        type: 'string',
        description:
          'Caller-defined scope label (e.g. "checkout", "read-only"). ' +
          'Surfaced back to the redeeming agent. Required.',
      },
      ttl_ms: {
        type: 'number',
        description:
          'Optional explicit TTL in ms. Defaults to ' +
          `${DEFAULT_TOKEN_TTL_MS}ms (5 min). Non-finite, zero, or negative ` +
          'values fall back to the default.',
      },
    },
    required: ['session_id', 'scope'],
  },
};

const redeemDefinition: MCPToolDefinition = {
  name: 'oc_pilot_handoff_redeem',
  description:
    'Pilot-tier: redeem a single-use handoff token previously minted by ' +
    'oc_pilot_handoff_create. Consumes the record on success — subsequent ' +
    'calls with the same token return unknown_token. Gated by --pilot + ' +
    'handoff_persist family.',
  inputSchema: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'Token returned by oc_pilot_handoff_create.',
      },
    },
    required: ['token'],
  },
};

const createHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  if (!isHandoffPersistEnabled()) {
    return jsonResult<CreateOutput>({
      ok: false,
      reason: 'disabled',
      error_message:
        'handoff_persist family is disabled — start the server with ' +
        '`--pilot` (and do not unset OPENCHROME_HANDOFF_PERSIST).',
    });
  }
  const sessionIdArg = args.session_id;
  const scopeArg = args.scope;
  const ttlArg = args.ttl_ms;
  if (typeof sessionIdArg !== 'string' || sessionIdArg.length === 0) {
    return jsonResult<CreateOutput>({
      ok: false,
      reason: 'invalid_args',
      error_message: 'session_id is required and must be a non-empty string',
    });
  }
  if (typeof scopeArg !== 'string' || scopeArg.length === 0) {
    return jsonResult<CreateOutput>({
      ok: false,
      reason: 'invalid_args',
      error_message: 'scope is required and must be a non-empty string',
    });
  }
  const result = getManager().register({
    sessionId: sessionIdArg,
    scope: scopeArg,
    ttlMs: typeof ttlArg === 'number' ? ttlArg : undefined,
  });
  const banner = renderHandoffBanner({
    sessionId: sessionIdArg,
    scope: scopeArg,
    expiresAt: result.expiresAt,
  });
  return jsonResult<CreateOutput>({
    ok: true,
    token: result.token,
    expires_at: result.expiresAt,
    banner,
    scope: scopeArg,
    session_id: sessionIdArg,
  });
};

const redeemHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  if (!isHandoffPersistEnabled()) {
    return jsonResult<RedeemOutput>({
      ok: false,
      reason: 'disabled',
      error_message:
        'handoff_persist family is disabled — start the server with ' +
        '`--pilot` (and do not unset OPENCHROME_HANDOFF_PERSIST).',
    });
  }
  const tokenArg = args.token;
  if (typeof tokenArg !== 'string' || tokenArg.length === 0) {
    return jsonResult<RedeemOutput>({
      ok: false,
      reason: 'invalid_args',
      error_message: 'token is required and must be a non-empty string',
    });
  }
  const redemption = getManager().redeem(tokenArg);
  if (redemption === null) {
    return jsonResult<RedeemOutput>({
      ok: false,
      reason: 'unknown_token',
      error_message: 'token is unknown, expired, or already redeemed',
    });
  }
  // Defensive: timing-safe verify against the originating token format.
  // `verifyHandoffToken` rejects malformed candidates without throwing;
  // we never receive the original here (it was consumed), so we compare
  // the supplied token against itself purely to assert the charset /
  // length invariants survived round-tripping.
  if (!verifyHandoffToken(tokenArg, tokenArg)) {
    return jsonResult<RedeemOutput>({
      ok: false,
      reason: 'unknown_token',
      error_message: 'token failed structural verification',
    });
  }
  const banner = renderHandoffBanner({
    sessionId: redemption.sessionId,
    scope: redemption.scope,
    expiresAt: redemption.expiresAt,
    now: () => redemption.redeemedAt,
  });
  return jsonResult<RedeemOutput>({
    ok: true,
    session_id: redemption.sessionId,
    scope: redemption.scope,
    expires_at: redemption.expiresAt,
    created_at: redemption.createdAt,
    redeemed_at: redemption.redeemedAt,
    banner,
  });
};

function jsonResult<T extends Record<string, unknown>>(payload: T): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...payload,
  };
}

/**
 * Register both pilot handoff MCP tools onto the given server. Idempotent
 * per server (the underlying registry overwrites by name). Wired through
 * `src/pilot/index.ts` so registration happens iff `--pilot` opened the
 * bootstrap path.
 */
export function registerOcPilotHandoffTool(server: MCPServer): void {
  server.registerTool('oc_pilot_handoff_create', createHandler, createDefinition);
  server.registerTool('oc_pilot_handoff_redeem', redeemHandler, redeemDefinition);
}
