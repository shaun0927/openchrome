/**
 * oc_profile_fingerprint — secret-free profile fingerprint MCP tool
 * (B3-PR2 of #1359).
 *
 * Captures the current tab's storage state (cookies + localStorage +
 * sessionStorage + origin) via the same CDP walker that
 * `oc_context_export` uses, runs it through the deterministic
 * fingerprint pipeline (B3-PR1), and returns a hex digest plus a
 * non-secret breakdown.
 *
 * The fingerprint is a SHAPE hash — values never enter the hash. Two
 * sessions with identical storage layouts but different secrets
 * fingerprint identically; this is the intended property and the
 * negative tests on `fingerprintEnvelope` enforce it.
 *
 * Per #1359 §Pillar B (profile/auth reuse) + §Pillar D (portable
 * memory): the host uses this tool to ask "is this the same logged-in
 * session?" *without* needing access to the secrets themselves.
 *
 * Read-only annotation: capture is observation only — no cookies or
 * storage entries are written or deleted.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import {
  captureContextEnvelopeData,
  type CDPClientLike,
} from '../storage-state/storage-state-manager';
import {
  fingerprintEnvelope,
  FINGERPRINT_ALGORITHM,
  FINGERPRINT_VERSION,
  type ProfileFingerprint,
} from '../storage-state/fingerprint';

interface OcProfileFingerprintOutput {
  /** Lowercase hex digest. 64 chars for sha256. */
  hash: string;
  algorithm: typeof FINGERPRINT_ALGORITHM;
  version: typeof FINGERPRINT_VERSION;
  /**
   * Non-secret diagnostic counts. Lets the host verify the capture
   * shape (e.g. "12 cookies, 3 localStorage keys for https://example.com")
   * without exposing values.
   */
  breakdown: ProfileFingerprint['breakdown'];
}

const definition: MCPToolDefinition = {
  name: 'oc_profile_fingerprint',
  description:
    'Compute a deterministic, secret-free fingerprint of the current ' +
    'tab\'s storage state (cookies + localStorage + sessionStorage + ' +
    'origin). Returns { hash, version, algorithm, breakdown }. Values ' +
    'never enter the hash — two sessions with identical layouts but ' +
    'different secrets fingerprint identically. Read-only. Useful for ' +
    'comparing two captures to ask "is this the same logged-in ' +
    'session?" without seeing the secrets.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to fingerprint. Required.',
      },
      includeSessionStorage: {
        type: 'boolean',
        description:
          'Capture window.sessionStorage for the active origin in the ' +
          'fingerprint. Default false (sessionStorage is ephemeral per ' +
          'tab so excluding it makes fingerprints more comparable ' +
          'across reattach).',
      },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.oc_profile_fingerprint,
};

function errorResult(message: string): MCPResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const tabId = typeof args.tabId === 'string' ? args.tabId : '';
  if (!tabId) return errorResult('tabId is required');

  const includeSessionStorage = args.includeSessionStorage === true;

  const sessionManager = getSessionManager();
  const page = await sessionManager.getPage(sessionId, tabId, undefined, 'oc_profile_fingerprint');
  if (!page) return errorResult(`Tab ${tabId} not found`);

  // Use the same CDP walker that powers oc_context_export so the
  // fingerprint reflects the same envelope shape downstream tools
  // would see when round-tripping the storage state.
  const cdpClient = sessionManager.getCDPClient();
  const cdpClientLike: CDPClientLike = {
    send: <T,>(p: import('puppeteer-core').Page, method: string, params?: Record<string, unknown>): Promise<T> =>
      cdpClient.send<T>(p, method, params),
  };

  let envelope;
  try {
    envelope = await captureContextEnvelopeData(page, cdpClientLike, {
      includeCookies: true,
      includeLocalStorage: true,
      includeSessionStorage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`failed to capture envelope: ${message}`);
  }

  const fp = fingerprintEnvelope(envelope);
  const out: OcProfileFingerprintOutput = {
    hash: fp.hash,
    algorithm: fp.algorithm,
    version: fp.version,
    breakdown: fp.breakdown,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(out) }],
  };
};

export function registerOcProfileFingerprintTool(server: MCPServer): void {
  server.registerTool('oc_profile_fingerprint', handler, definition);
}
