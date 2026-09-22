import { randomUUID } from 'crypto';
import { getVersion } from '../core/version';
import { MCPError, MCPErrorCodes } from '../types/mcp';

export const RUNTIME_META_KEY = 'io.openchrome/runtimeId';
export const PROTOCOL_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const LEGACY_PROTOCOL_VERSION = '2024-11-05';

export function createRuntimeContract() {
  return Object.freeze({
    contractVersion: 1,
    runtimeId: randomUUID(),
    packageVersion: getVersion(),
    protocolVersions: Object.freeze([LEGACY_PROTOCOL_VERSION]),
    protocolMode: 'legacy-stateful',
    restartRequiresRediscovery: true,
    replayMutations: false,
  });
}

export type RuntimeContract = ReturnType<typeof createRuntimeContract>;

export function rejectUnsupportedProtocol(meta: unknown, httpVersion?: string | string[]): MCPError | undefined {
  const fields = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown> : {};
  const legacyHeader = httpVersion === undefined || httpVersion === LEGACY_PROTOCOL_VERSION;
  if (!legacyHeader || PROTOCOL_META_KEY in fields || 'io.modelcontextprotocol/clientCapabilities' in fields) {
    // A legacy error lets dual-era clients fall back to initialize instead of treating us as modern.
    return {
      code: MCPErrorCodes.INVALID_REQUEST,
      message: 'STATELESS_PROTOCOL_UNSUPPORTED: use the legacy initialize handshake',
      data: { supported: [LEGACY_PROTOCOL_VERSION], upgradeRequired: true },
    };
  }
  return undefined;
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
  const protocolError = rejectUnsupportedProtocol(meta);
  if (protocolError) return protocolError;
  if (RUNTIME_META_KEY in fields && fields[RUNTIME_META_KEY] !== runtime.runtimeId) {
    return {
      code: MCPErrorCodes.INVALID_PARAMS,
      message: 'STALE_RUNTIME: rediscover the server and reacquire browser handles; do not replay mutations',
      data: { reason: 'STALE_RUNTIME', retrySafe: false },
    };
  }
  return undefined;
}
