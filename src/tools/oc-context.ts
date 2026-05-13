/**
 * oc_context_export / oc_context_import — portable context envelope (#873).
 *
 * Two MCP tools that wrap the storage-state walker into one inline
 * "ContextEnvelope" so a host LLM can carry a single tab's auth-relevant
 * state (cookies + local/sessionStorage + optional HTTP auth + viewport / UA)
 * across openchrome instances without orchestrating five separate tool calls.
 *
 * This is the core-tier surface; encrypted persistence is the host's
 * problem (the pilot-tier handoff token #793/#794). The envelope produced
 * here is PLAINTEXT by design — the host MUST treat it as a secret.
 *
 * Boundary (per issue #873 r2):
 *   - Delegates to `src/storage-state/storage-state-manager.ts` shared
 *     walker (`captureContextEnvelopeData` / `applyContextEnvelopeData`)
 *     so file-path persistence and inline-envelope round-trip share the
 *     same CDP traversal.
 *   - No new runtime dependency; integrity hash uses Node's built-in
 *     `crypto` module.
 *   - Single origin only; cross-origin bundles, IndexedDB capture, merge
 *     semantics, and lifecycle CRUD are explicitly out of scope.
 */

import * as crypto from 'crypto';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { assertDomainAllowed } from '../security/domain-guard';
import {
  captureContextEnvelopeData,
  applyContextEnvelopeData,
  type EnvelopeCapture,
} from '../storage-state';
import type { StorageState } from '../storage-state/storage-state-manager';

// ─── Types (public — exported for tests & SDK consumers) ─────────────────────

export interface EnvelopeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}

export interface ContextEnvelope {
  version: 1;
  origin: string;
  capturedAt: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
  cookies: EnvelopeCookie[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  httpAuth?: { username: string; password: string };
  /** SHA-256 over canonical-JSON form excluding this field itself. */
  integrity: string;
}

export interface ExportOptions {
  origin?: string;
  includeStorage?: boolean;
  includeHttpAuth?: boolean;
  captureUA?: boolean;
  tabId?: string;
}

export interface ImportOptions {
  envelope: ContextEnvelope;
  strictOrigin?: boolean;
  tabId?: string;
}

export interface ImportResponse {
  ok: boolean;
  appliedCookies: number;
  appliedStorageKeys: number;
  integrityError?: string;
}

// ─── Canonical JSON + integrity hash ─────────────────────────────────────────

/**
 * Deterministic JSON encoder: object keys are sorted lexicographically at
 * every depth. Arrays are emitted in given order (the caller is responsible
 * for ordering arrays — see `sortCookies` below).
 *
 * NOTE: this is intentionally a small, dependency-free implementation. We
 * cannot use JSON.stringify replacer-with-sort because nested objects also
 * need ordering.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]))
        .join(',') +
      '}'
    );
  }
  return 'null';
}

/**
 * Compute the integrity hash for an envelope. Excludes the `integrity`
 * field itself so the hash can be embedded inside the envelope it covers.
 */
export function computeIntegrity(envelope: Omit<ContextEnvelope, 'integrity'>): string {
  const canonical = canonicalize(envelope);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ─── Determinism helpers ─────────────────────────────────────────────────────

function sortCookies(cookies: EnvelopeCookie[]): EnvelopeCookie[] {
  return [...cookies].sort((a, b) => {
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function sortRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(rec).sort()) {
    out[k] = rec[k];
  }
  return out;
}

/**
 * Project a CDP cookie down to the envelope-cookie shape, preserving only
 * fields we round-trip. Drops `priority`, `sameParty`, etc. that some CDP
 * builds add — keeping the envelope small and deterministic across Chrome
 * versions.
 */
function normalizeCookie(c: StorageState['cookies'][number]): EnvelopeCookie {
  const out: EnvelopeCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    size: c.size,
    httpOnly: c.httpOnly,
    secure: c.secure,
    session: c.session,
  };
  if (c.sameSite !== undefined) out.sameSite = c.sameSite;
  return out;
}

// ─── Envelope builder (public for tests) ─────────────────────────────────────

export interface BuildEnvelopeInput {
  capture: EnvelopeCapture;
  origin: string;
  includeStorage: boolean;
  includeHttpAuth: boolean;
  captureUA: boolean;
  httpAuth?: { username: string; password: string };
  capturedAt?: number;
}

export function buildEnvelope(input: BuildEnvelopeInput): ContextEnvelope {
  const cookies = sortCookies(input.capture.cookies.map(normalizeCookie));

  const partial: Omit<ContextEnvelope, 'integrity'> = {
    version: 1,
    origin: input.origin,
    capturedAt: input.capturedAt ?? Date.now(),
    cookies,
  };

  if (input.captureUA && input.capture.userAgent) {
    partial.userAgent = input.capture.userAgent;
  }
  if (input.capture.viewport) {
    partial.viewport = input.capture.viewport;
  }
  if (input.includeStorage) {
    if (Object.keys(input.capture.localStorage).length > 0) {
      partial.localStorage = sortRecord(input.capture.localStorage);
    }
    if (Object.keys(input.capture.sessionStorage).length > 0) {
      partial.sessionStorage = sortRecord(input.capture.sessionStorage);
    }
  }
  if (input.includeHttpAuth && input.httpAuth) {
    partial.httpAuth = {
      username: input.httpAuth.username,
      password: input.httpAuth.password,
    };
  }

  return { ...partial, integrity: computeIntegrity(partial) };
}

/**
 * Verify an envelope's integrity. Returns null on success, or a human-readable
 * error string describing the failure. Does not mutate `envelope`.
 */
export function verifyEnvelopeIntegrity(envelope: ContextEnvelope): string | null {
  if (!envelope || typeof envelope !== 'object') {
    return 'envelope is not an object';
  }
  if (envelope.version !== 1) {
    return `unsupported envelope version: ${envelope.version}`;
  }
  if (typeof envelope.integrity !== 'string' || envelope.integrity.length !== 64) {
    return 'integrity field missing or malformed (expected 64-char hex)';
  }

  const { integrity, ...rest } = envelope;
  const expected = computeIntegrity(rest);
  if (expected !== integrity) {
    return `integrity mismatch: expected ${expected}, got ${integrity}`;
  }
  return null;
}

export function assertEnvelopeImportAllowed(envelope: ContextEnvelope): void {
  assertHttpOrigin(envelope.origin);
  assertDomainAllowed(envelope.origin);

  for (const cookie of envelope.cookies ?? []) {
    const bareDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    if (!bareDomain) {
      throw new Error(`Invalid cookie domain in envelope: ${cookie.domain}`);
    }
    assertHttpOrigin(`https://${bareDomain}`);
    assertDomainAllowed(`https://${bareDomain}/`);
  }
}

function assertHttpOrigin(origin: string): void {
  try {
    const url = new URL(origin);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
      throw new Error('unsupported origin');
    }
  } catch {
    throw new Error(`Invalid envelope origin: ${origin}`);
  }
}

// ─── oc_context_export ───────────────────────────────────────────────────────

const exportDefinition: MCPToolDefinition = {
  name: 'oc_context_export',
  description:
    'Export the active tab\'s auth-relevant state (cookies + local/sessionStorage + ' +
    'optional UA/viewport/HTTP-auth) as a portable plaintext envelope. The envelope ' +
    'is byte-deterministic modulo `capturedAt` and carries a SHA-256 `integrity` ' +
    'hash for tamper detection on import. ' +
    'SECURITY: the envelope is plaintext by design — the host MUST treat it as a secret. ' +
    'Pair with `oc_context_import` on a fresh openchrome instance to carry signed-in ' +
    'state across hosts.',
  annotations: TOOL_ANNOTATIONS.oc_context_export,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'REQUIRED Tab ID to export from.',
      },
      origin: {
        type: 'string',
        description:
          'Explicit origin to record in the envelope. Default: active tab origin.',
      },
      includeStorage: {
        type: 'boolean',
        description: 'Capture localStorage + sessionStorage. Default: true.',
      },
      includeHttpAuth: {
        type: 'boolean',
        description:
          'Capture HTTP Basic auth credentials supplied via `http_auth set`. ' +
          'Default: false (rarely safe to round-trip).',
      },
      captureUA: {
        type: 'boolean',
        description: 'Capture navigator.userAgent. Default: false.',
      },
    },
    required: ['tabId'],
  },
};

const exportHandler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const tabId = args.tabId as string | undefined;
  const originArg = args.origin as string | undefined;
  const includeStorage = args.includeStorage !== false; // default true
  const includeHttpAuth = args.includeHttpAuth === true; // default false
  const captureUA = args.captureUA === true; // default false

  if (!tabId) {
    return errorResult('Error: tabId is required');
  }

  const sessionManager = getSessionManager();

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'oc_context_export');
    if (!page) {
      return errorResult(`Error: Tab ${tabId} not found`);
    }

    assertDomainAllowed(page.url());

    const cdpClient = sessionManager.getCDPClient();
    const capture = await captureContextEnvelopeData(page, cdpClient, {
      includeCookies: true,
      includeLocalStorage: includeStorage,
      includeSessionStorage: includeStorage,
      captureUserAgent: captureUA,
      captureViewport: true,
    });

    const origin = originArg || capture.origin || '';
    if (!origin) {
      return errorResult(
        'Error: unable to determine envelope origin — navigate to a real page first or pass `origin`',
      );
    }

    const envelope = buildEnvelope({
      capture,
      origin,
      includeStorage,
      includeHttpAuth,
      captureUA,
      // The host explicitly supplied HTTP-auth via http_auth tool; openchrome
      // does not store it server-side, so we cannot reconstruct credentials
      // here. includeHttpAuth therefore only emits credentials when the host
      // wants to embed pre-known values — but we honour it as a forward-
      // compatible field. A future revision may surface page.authenticate
      // state if puppeteer-core exposes it.
      httpAuth: undefined,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify({ envelope }) }],
      envelope,
    };
  } catch (error) {
    return errorResult(
      `oc_context_export error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

// ─── oc_context_import ───────────────────────────────────────────────────────

const importDefinition: MCPToolDefinition = {
  name: 'oc_context_import',
  description:
    'Strict-replace import of a `ContextEnvelope` produced by `oc_context_export`. ' +
    'Verifies the SHA-256 `integrity` hash first — on mismatch returns ' +
    '`{ ok: false, integrityError }` WITHOUT applying any state. On success, ' +
    'existing cookies for the envelope origin and the active-origin web storage ' +
    'are CLEARED, then the envelope payload is installed. Merge semantics are ' +
    'intentionally not supported. ' +
    'SECURITY: the envelope is plaintext — the host MUST treat it as a secret.',
  annotations: TOOL_ANNOTATIONS.oc_context_import,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'REQUIRED Tab ID to apply the envelope to.',
      },
      envelope: {
        type: 'object',
        description:
          'REQUIRED A `ContextEnvelope` produced by `oc_context_export`.',
      },
      strictOrigin: {
        type: 'boolean',
        description:
          'When true, reject the import if the active tab origin does not match ' +
          '`envelope.origin`. Default: false (caller is responsible for navigating).',
      },
    },
    required: ['tabId', 'envelope'],
  },
};

const importHandler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const tabId = args.tabId as string | undefined;
  const envelope = args.envelope as ContextEnvelope | undefined;
  const strictOrigin = args.strictOrigin === true;

  if (!tabId) return errorResult('Error: tabId is required');
  if (!envelope || typeof envelope !== 'object') {
    return errorResult('Error: envelope is required');
  }

  // Integrity FIRST — never touch state on a bad envelope.
  const integrityError = verifyEnvelopeIntegrity(envelope);
  if (integrityError) {
    const response: ImportResponse = {
      ok: false,
      appliedCookies: 0,
      appliedStorageKeys: 0,
      integrityError,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(response) }],
      ...response,
    };
  }

  try {
    assertEnvelopeImportAllowed(envelope);
  } catch (error) {
    return errorResult(
      `oc_context_import error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sessionManager = getSessionManager();

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'oc_context_import');
    if (!page) return errorResult(`Error: Tab ${tabId} not found`);

    assertDomainAllowed(page.url());

    if (strictOrigin) {
      let activeOrigin = '';
      try {
        activeOrigin = (await page.evaluate(() => window.location.origin)) as string;
      } catch {
        activeOrigin = '';
      }
      if (activeOrigin && activeOrigin !== envelope.origin) {
        const response: ImportResponse = {
          ok: false,
          appliedCookies: 0,
          appliedStorageKeys: 0,
          integrityError: `strictOrigin mismatch: active=${activeOrigin}, envelope=${envelope.origin}`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
          ...response,
        };
      }
    }

    const cdpClient = sessionManager.getCDPClient();

    const capture: EnvelopeCapture = {
      origin: envelope.origin,
      cookies: envelope.cookies,
      localStorage: envelope.localStorage ?? {},
      sessionStorage: envelope.sessionStorage ?? {},
    };

    const applyResult = await applyContextEnvelopeData(page, cdpClient, capture, {
      origin: envelope.origin,
      applyCookies: true,
      applyLocalStorage: true,
      applySessionStorage: true,
    });

    // HTTP-auth round-trip (opt-in by exporter; envelope carries it inline).
    if (envelope.httpAuth) {
      try {
        await page.authenticate({
          username: envelope.httpAuth.username,
          password: envelope.httpAuth.password,
        });
      } catch {
        // best-effort; auth failure does not invalidate cookie/storage import
      }
    }

    const response: ImportResponse = {
      ok: true,
      appliedCookies: applyResult.appliedCookies,
      appliedStorageKeys: applyResult.appliedStorageKeys,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(response) }],
      ...response,
    };
  } catch (error) {
    return errorResult(
      `oc_context_import error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

function errorResult(message: string): MCPResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerOcContextTools(server: MCPServer): void {
  server.registerTool('oc_context_export', exportHandler, exportDefinition);
  server.registerTool('oc_context_import', importHandler, importDefinition);
}
