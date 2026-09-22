import { randomUUID } from 'crypto';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { getVersion } from '../core/version';
import { MCPError, MCPErrorCodes } from '../types/mcp';

export const RUNTIME_META_KEY = 'io.openchrome/runtimeId';
export const PROTOCOL_META_KEY = 'io.modelcontextprotocol/protocolVersion';
/** Version negotiated by the sessionful legacy HTTP path. */
export const LEGACY_PROTOCOL_VERSION = '2024-11-05';
/** Stateless protocol revision served by the official SDK boundary. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Protocol versions each transport negotiates. Stdio legacy negotiation is
 * owned by the official SDK; the sessionful legacy HTTP path answers
 * initialize with 2024-11-05 only. Both transports serve 2026-07-28
 * statelessly.
 */
export const PROTOCOL_SUPPORT = Object.freeze({
  stdio: Object.freeze({
    legacy: Object.freeze([...SUPPORTED_PROTOCOL_VERSIONS]),
    modern: Object.freeze([MODERN_PROTOCOL_VERSION]),
  }),
  http: Object.freeze({
    legacy: Object.freeze([LEGACY_PROTOCOL_VERSION]),
    modern: Object.freeze([MODERN_PROTOCOL_VERSION]),
  }),
});

export function createRuntimeContract() {
  return Object.freeze({
    contractVersion: 2,
    runtimeId: randomUUID(),
    packageVersion: getVersion(),
    protocolVersions: Object.freeze([
      ...new Set([...PROTOCOL_SUPPORT.stdio.legacy, ...PROTOCOL_SUPPORT.http.legacy, MODERN_PROTOCOL_VERSION]),
    ]),
    protocolSupport: PROTOCOL_SUPPORT,
    protocolMode: 'dual-era',
    restartRequiresRediscovery: true,
    replayMutations: false,
  });
}

export type RuntimeContract = ReturnType<typeof createRuntimeContract>;

/**
 * The sessionful legacy HTTP path negotiates 2024-11-05 in initialize, so a
 * legacy request may omit MCP-Protocol-Version or send exactly that value.
 * Modern requests never reach this check: the SDK classifies and validates
 * them before the legacy path runs.
 */
export function rejectUnsupportedLegacyHttpVersion(httpVersion?: string | string[]): MCPError | undefined {
  const header = Array.isArray(httpVersion) ? httpVersion[0] : httpVersion;
  if (header === undefined || header.trim() === LEGACY_PROTOCOL_VERSION) return undefined;
  return {
    code: MCPErrorCodes.INVALID_REQUEST,
    message: `Unsupported MCP-Protocol-Version "${header}" on the sessionful HTTP path`,
    data: {
      supported: [LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION],
      requested: header,
    },
  };
}

export function validateRuntimeRequest(
  meta: unknown,
  runtime: RuntimeContract,
): MCPError | undefined {
  if (meta === undefined) return undefined;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { code: MCPErrorCodes.INVALID_PARAMS, message: '_meta must be an object' };
  }
  const fields = meta as Record<string, unknown>;
  if (RUNTIME_META_KEY in fields && fields[RUNTIME_META_KEY] !== runtime.runtimeId) {
    return {
      code: MCPErrorCodes.INVALID_PARAMS,
      message: 'STALE_RUNTIME: rediscover the server and reacquire browser handles; do not replay mutations',
      data: { reason: 'STALE_RUNTIME', retrySafe: false },
    };
  }
  return undefined;
}
