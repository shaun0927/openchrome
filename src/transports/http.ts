/**
 * Streamable HTTP transport for MCP server.
 *
 * Implements MCP Streamable HTTP transport (spec 2025-03-26):
 * - POST /mcp: receives JSON-RPC request/notification, returns JSON-RPC response
 * - GET /health: basic health check (separate from the self-healing health endpoint)
 * - DELETE /mcp: session termination
 *
 * Key difference from stdio: client disconnect does NOT kill the server.
 * The HTTP server continues to accept new connections.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { MCPResponse, MCPErrorCodes } from '../types/mcp';
import {
  DEFAULT_HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY,
  DEFAULT_HTTP_JSON_RPC_BATCH_MAX_SIZE,
} from '../config/defaults';
import { ClientDisconnectError } from '../errors/abort';
import { MCPTransport } from './index';
import { getDashboardState } from '../desktop/dashboard-state';
import type { SessionManager } from '../session-manager';
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_HEADER_LOWER,
  resolveRequestId,
  runWithRequestContext,
} from '../observability/request-id';
import type { ApiKeyStore } from '../auth/api-key-store';
import { createJwtVerifier, type JwtConfig, type JwtVerifier } from '../auth/jwt-verifier';
import {
  authenticate,
  requestPrincipals,
  PRINCIPAL_SYM,
  type AuthMode,
  type Principal,
} from '../middleware/auth';
import { logAuditEntry } from '../security/audit-logger';
import { extractTenantId, TenantIdError } from '../middleware/tenant-extractor';
import { isStrictTenantIsolationEnabled } from '../tenant/registry';
import type { TenantId } from '../tenant/types';

/** Maximum allowed HTTP request body size (10 MB) to prevent OOM from oversized requests */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** SSE keepalive ping interval in milliseconds */
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

// ─── Request/socket timeouts (Slowloris defense) ─────────────────────────
// Node's http.Server has two of these built-in (requestTimeout,
// headersTimeout, keepAliveTimeout) but their defaults vary across Node
// versions and platforms. Explicit values make behavior deterministic.
// All values in milliseconds; override via OPENCHROME_HTTP_* env vars.

/** Max wall time between accepting the connection and finishing the request. */
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
/** Max time to receive the full request headers. */
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
/** Idle timeout between keep-alive requests on the same connection. */
const DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS = 5_000;
/** Per-socket idle timeout (triggers automatic socket destroy). */
const DEFAULT_HTTP_SOCKET_TIMEOUT_MS = 60_000;
/** Max time to receive the full request body after headers. */
const DEFAULT_HTTP_BODY_TIMEOUT_MS = 15_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const HTTP_REQUEST_TIMEOUT_MS  = envInt('OPENCHROME_HTTP_REQUEST_TIMEOUT_MS',  DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
const HTTP_HEADERS_TIMEOUT_MS  = envInt('OPENCHROME_HTTP_HEADERS_TIMEOUT_MS',  DEFAULT_HTTP_HEADERS_TIMEOUT_MS);
const HTTP_KEEPALIVE_TIMEOUT_MS = envInt('OPENCHROME_HTTP_KEEPALIVE_TIMEOUT_MS', DEFAULT_HTTP_KEEPALIVE_TIMEOUT_MS);
const HTTP_SOCKET_TIMEOUT_MS   = envInt('OPENCHROME_HTTP_SOCKET_TIMEOUT_MS',   DEFAULT_HTTP_SOCKET_TIMEOUT_MS);
const HTTP_BODY_TIMEOUT_MS     = envInt('OPENCHROME_HTTP_BODY_TIMEOUT_MS',     DEFAULT_HTTP_BODY_TIMEOUT_MS);
const HTTP_JSON_RPC_BATCH_MAX_SIZE = envInt(
  'OPENCHROME_HTTP_JSON_RPC_BATCH_MAX_SIZE',
  DEFAULT_HTTP_JSON_RPC_BATCH_MAX_SIZE,
);
const HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY = Math.max(
  1,
  envInt(
    'OPENCHROME_HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY',
    DEFAULT_HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY,
  ),
);

/** Exported for tests to assert current effective values. */
export const HTTP_TIMEOUTS = Object.freeze({
  requestTimeoutMs:   HTTP_REQUEST_TIMEOUT_MS,
  headersTimeoutMs:   HTTP_HEADERS_TIMEOUT_MS,
  keepAliveTimeoutMs: HTTP_KEEPALIVE_TIMEOUT_MS,
  socketTimeoutMs:    HTTP_SOCKET_TIMEOUT_MS,
  bodyTimeoutMs:      HTTP_BODY_TIMEOUT_MS,
  jsonRpcBatchMaxSize: HTTP_JSON_RPC_BATCH_MAX_SIZE,
  jsonRpcBatchMaxConcurrency: HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY,
});

/** Active SSE connections for server-initiated notifications */
interface SSEConnection {
  res: http.ServerResponse;
  sessionId: string;
}

export interface HTTPTransportOptions {
  apiKeyStore?: ApiKeyStore;
  jwt?: JwtConfig;
}

export class HTTPTransport implements MCPTransport {
  private server: http.Server | null = null;
  private messageHandler:
    | ((msg: Record<string, unknown>, signal?: AbortSignal) => Promise<MCPResponse | null>)
    | null = null;
  private port: number;
  private host: string;
  private authToken: string | undefined;
  private authMode: AuthMode;
  private sessions: Set<string> = new Set();
  private sseConnections: SSEConnection[] = [];
  private sessionDeleteHandler: ((sessionId: string) => void) | null = null;
  private sessionManager: SessionManager | null = null;
  private readonly serverStartTime: number = Date.now();
  private sseKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Tenant bound to each MCP session. Populated on initialize and checked
   *  on subsequent requests so a leaked session id cannot swap tenants. (#7) */
  private sessionTenants: Map<string, TenantId> = new Map();

  constructor(
    port: number,
    host = '127.0.0.1',
    authToken?: string,
    options: HTTPTransportOptions = {},
  ) {
    this.port = port;
    this.host = host;
    this.authToken = authToken;
    const verifier = options.jwt ? createJwtVerifier(options.jwt) : undefined;
    this.authMode = HTTPTransport.resolveAuthMode(authToken, options.apiKeyStore, verifier);
  }

  /**
   * Resolve the runtime auth mode from env + ctor args.
   * Precedence:
   *   1. Explicit env OPENCHROME_AUTH_MODE=legacy-shared-token -> legacy
   *      (fail-closed: throws if no token is configured; setting this env is
   *      an explicit operator request to enforce auth, so we must not silently
   *      downgrade to `disabled` on a wiring/secret-injection failure).
   *   2. store && jwt -> api-key-or-jwt
   *   3. ApiKeyStore provided -> api-key
   *   4. jwt provided -> jwt
   *   5. authToken provided (backwards compat) -> legacy
   *   6. Nothing configured -> disabled
   */
  static resolveAuthMode(
    authToken: string | undefined,
    store: ApiKeyStore | undefined,
    verifier?: JwtVerifier,
  ): AuthMode {
    const envMode = process.env.OPENCHROME_AUTH_MODE;
    if (envMode === 'legacy-shared-token') {
      if (!authToken) {
        throw new Error(
          'OPENCHROME_AUTH_MODE=legacy-shared-token requires a shared token ' +
            '(set OPENCHROME_AUTH_TOKEN or pass authToken to HTTPTransport). ' +
            'Refusing to start with the env flag set but no token configured — ' +
            'silently falling back to unauthenticated mode would be a security regression.',
        );
      }
      return { kind: 'legacy-shared-token', token: authToken };
    }
    if (store && verifier) {
      return { kind: 'api-key-or-jwt', store, verifier };
    }
    if (store) {
      return { kind: 'api-key', store };
    }
    if (verifier) {
      return { kind: 'jwt', verifier };
    }
    if (authToken) {
      return { kind: 'legacy-shared-token', token: authToken };
    }
    return { kind: 'disabled' };
  }

  /** Returns the resolved principal for a given request, if any. */
  static getPrincipal(req: http.IncomingMessage): Principal | undefined {
    return requestPrincipals.get(req);
  }

  /**
   * Look up the tenant bound to an MCP session id. Callers outside this
   * transport (e.g. MCPServer handlers) use this to resolve the tenant for
   * the currently-processed request. Returns undefined when unknown. (#7)
   */
  getTenantForMcpSession(mcpSessionId: string): TenantId | undefined {
    return this.sessionTenants.get(mcpSessionId);
  }

  /**
   * Register a callback to be invoked whenever a session is deleted.
   * Used by MCPServer to clean up per-session state (e.g. rate-limiter buckets).
   */
  onSessionDelete(handler: (sessionId: string) => void): void {
    this.sessionDeleteHandler = handler;
  }

  /**
   * Set the session manager so dashboard API endpoints can access session/tab data.
   */
  setSessionManager(sm: SessionManager): void {
    this.sessionManager = sm;
  }

  onMessage(
    handler: (msg: Record<string, unknown>, signal?: AbortSignal) => Promise<MCPResponse | null>,
  ): void {
    this.messageHandler = handler;
  }

  /**
   * Send a server-initiated notification to all connected SSE clients.
   * For HTTP, request-correlated responses are sent directly in handlePost.
   */
  send(response: MCPResponse): void {
    // Broadcast to all SSE connections
    for (const conn of this.sseConnections) {
      try {
        conn.res.write(`data: ${JSON.stringify(response)}\n\n`);
      } catch {
        // Connection may have been closed
      }
    }
  }

  start(): void {
    this.server = http.createServer((req, res) => {
      this.handleHTTPRequest(req, res);
    });

    // Explicit timeout configuration so behavior is deterministic across
    // Node versions. These bound the wall time of a single request and
    // prevent Slowloris-style resource exhaustion.
    this.server.requestTimeout   = HTTP_REQUEST_TIMEOUT_MS;
    this.server.headersTimeout   = HTTP_HEADERS_TIMEOUT_MS;
    this.server.keepAliveTimeout = HTTP_KEEPALIVE_TIMEOUT_MS;

    // Per-socket idle timeout. socket.setTimeout() only emits a 'timeout'
    // event — the socket is NOT destroyed automatically, so we destroy it
    // here. Closing the socket propagates to `req` as an 'error' or 'close'
    // event and unblocks any pending body-read loop.
    this.server.on('connection', (socket) => {
      socket.setTimeout(HTTP_SOCKET_TIMEOUT_MS);
      socket.on('timeout', () => {
        socket.destroy();
      });
    });

    this.server.listen(this.port, this.host, () => {
      console.error(`[HTTPTransport] Listening on ${this.host}:${this.port}`);
      console.error(`[HTTPTransport] MCP endpoint: http://${this.host}:${this.port}/mcp`);
      console.error(`[HTTPTransport] SSE endpoint: http://${this.host}:${this.port}/mcp/sse`);
      console.error(
        `[HTTPTransport] Timeouts: request=${HTTP_REQUEST_TIMEOUT_MS}ms ` +
        `headers=${HTTP_HEADERS_TIMEOUT_MS}ms body=${HTTP_BODY_TIMEOUT_MS}ms ` +
        `socket=${HTTP_SOCKET_TIMEOUT_MS}ms keepalive=${HTTP_KEEPALIVE_TIMEOUT_MS}ms`,
      );
    });

    this.server.on('error', (err) => {
      console.error(`[HTTPTransport] Server error:`, err);
    });

    // Periodic SSE keepalive pings to prevent proxy/LB connection drops
    this.sseKeepaliveTimer = setInterval(() => {
      for (const conn of this.sseConnections) {
        try {
          conn.res.write(': keepalive\n\n');
        } catch {
          // Connection already closed; cleaned up on 'close' event
        }
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);
    this.sseKeepaliveTimer.unref();
  }

  async close(): Promise<void> {
    // Stop keepalive timer
    if (this.sseKeepaliveTimer) {
      clearInterval(this.sseKeepaliveTimer);
      this.sseKeepaliveTimer = null;
    }

    // Close all SSE connections
    for (const conn of this.sseConnections) {
      try {
        conn.res.end();
      } catch {
        // Already closed
      }
    }
    this.sseConnections = [];
    this.sessionTenants.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleHTTPRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    // CORS headers for all responses — restrict origin when auth is enforced
    const authEnforced = this.authMode.kind !== 'disabled';
    res.setHeader('Access-Control-Allow-Origin', authEnforced ? 'null' : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', `Content-Type, Mcp-Session-Id, Authorization, X-Tenant-Id, ${REQUEST_ID_HEADER}`);
    res.setHeader('Access-Control-Expose-Headers', `Mcp-Session-Id, ${REQUEST_ID_HEADER}`);

    // Request correlation: honour client-supplied X-Request-Id, otherwise mint
    // a fresh UUID. Echo it back on every response so clients (and downstream
    // proxies) can correlate logs, metrics, and audit entries for this request.
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER_LOWER]);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    (req as http.IncomingMessage & { requestId?: string }).requestId = requestId;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // /health is always unauthenticated
    if (pathname === '/health') {
      this.handleHealth(res);
      return;
    }

    // Pluggable auth: resolves Principal or returns a structured failure.
    // Route through a helper so we can keep this method synchronous in layout
    // while awaiting the async middleware.
    this.authenticateAndContinue(req, res, pathname, url).catch((err) => {
      console.error('[HTTPTransport] Auth error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal auth error' }));
      }
    });
  }

  private async authenticateAndContinue(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    url: URL,
  ): Promise<void> {
    const result = await authenticate(req, this.authMode);
    if (!result.ok) {
      // Audit the failure with the attempted keyId (never plaintext).
      try {
        logAuditEntry(
          'auth_failure',
          'anonymous',
          { path: pathname, status: result.status },
          undefined,
          result.keyId ? { keyId: result.keyId } : undefined,
        );
      } catch {
        // best-effort
      }
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.keyId ? { error: result.error, keyId: result.keyId } : { error: result.error }));
      return;
    }
    requestPrincipals.set(req, result.principal);
    this.routeAuthenticated(req, res, pathname, url);
  }

  private routeAuthenticated(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    url: URL,
  ): void {

    // ─── Dashboard REST API ────────────────────────────────────────────
    if (pathname === '/api/screenshot' && req.method === 'GET') {
      this.handleScreenshot(url, res);
      return;
    }
    if (pathname === '/api/sessions' && req.method === 'GET') {
      this.handleSessions(res);
      return;
    }
    if (pathname === '/api/tool-calls' && req.method === 'GET') {
      this.handleToolCalls(url, res);
      return;
    }
    if (pathname === '/api/metrics' && req.method === 'GET') {
      this.handleMetrics(res);
      return;
    }

    // Explicit /mcp/sse endpoint (MCP spec alias for GET /mcp SSE stream)
    if (pathname === '/mcp/sse') {
      if (req.method === 'GET') {
        const tenantId = this.resolveRequestTenant(req, res);
        if (tenantId === null) return;
        this.handleSSE(req, res, tenantId);
      } else {
        res.writeHead(405, { 'Allow': 'GET', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      }
      return;
    }

    if (pathname === '/mcp') {
      switch (req.method) {
        case 'POST': {
          const tenantId = this.resolveRequestTenant(req, res);
          if (tenantId === null) return;
          this.handlePost(req, res, tenantId);
          return;
        }
        case 'GET': {
          const tenantId = this.resolveRequestTenant(req, res);
          if (tenantId === null) return;
          this.handleSSE(req, res, tenantId);
          return;
        }
        case 'DELETE':
          this.handleDelete(req, res);
          return;
        default:
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
      }
    }

    // Unknown path
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /**
   * Validate `X-Tenant-Id` on an incoming /mcp request and resolve the
   * effective tenant. Writes a 400 JSON-RPC error and returns `null` on
   * failure so the caller can bail out without doing further work. (#7)
   *
   * - Missing header in STRICT mode                   → 400 (code `missing`)
   * - Invalid header format                           → 400 (code `invalid`)
   * - Header present but differs from a tenant already bound to the
   *   same Mcp-Session-Id                             → 400 (code `invalid`)
   */
  private resolveRequestTenant(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): TenantId | null {
    const strict = isStrictTenantIsolationEnabled();
    let tenantId: TenantId;
    try {
      tenantId = extractTenantId(req.headers, { required: strict });
    } catch (err) {
      if (err instanceof TenantIdError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            error: {
              code: MCPErrorCodes.INVALID_REQUEST,
              message: err.message,
              data: { field: 'X-Tenant-Id', reason: err.code },
            },
          }),
        );
        return null;
      }
      throw err;
    }

    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
    if (mcpSessionId) {
      const bound = this.sessionTenants.get(mcpSessionId);
      if (bound !== undefined && bound !== tenantId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            error: {
              code: MCPErrorCodes.INVALID_REQUEST,
              message: 'X-Tenant-Id does not match the tenant bound to this Mcp-Session-Id',
              data: { field: 'X-Tenant-Id', reason: 'tenant_mismatch' },
            },
          }),
        );
        return null;
      }
    }
    return tenantId;
  }

  /**
   * GET /health - basic health check
   */
  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      transport: 'http',
      activeSessions: this.sessions.size,
      sseConnections: this.sseConnections.length,
    }));
  }

  // ─── Dashboard API Handlers ──────────────────────────────────────────

  /**
   * GET /api/screenshot - capture active tab screenshot as base64 WebP
   */
  private handleScreenshot(url: URL, res: http.ServerResponse): void {
    const sessionId = url.searchParams.get('session_id') || 'default';

    if (!this.sessionManager) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session manager not available' }));
      return;
    }

    this.captureScreenshot(sessionId)
      .then((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        console.error('[HTTPTransport] Screenshot error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Screenshot failed' }));
      });
  }

  private async captureScreenshot(sessionId: string): Promise<{ base64: string; format: string; sessionId: string }> {
    const sm = this.sessionManager!;
    const infos = sm.getAllSessionInfos();
    const sessionInfo = infos.find((s) => s.id === sessionId);

    if (!sessionInfo || sessionInfo.targetCount === 0) {
      throw new Error(`No tabs found for session "${sessionId}"`);
    }

    // Get the first worker's first target as the "active" page
    const cdpClient = sm.getCDPClient();
    let targetId: string | undefined;

    for (const worker of sessionInfo.workers) {
      const workerData = sm.getWorker(sessionId, worker.id);
      if (workerData && workerData.targets.size > 0) {
        // Get the most recently added target (last in insertion order)
        for (const tid of workerData.targets) {
          targetId = tid;
        }
        break;
      }
    }

    if (!targetId) {
      throw new Error(`No active target found for session "${sessionId}"`);
    }

    const page = await cdpClient.getPageByTargetId(targetId);
    if (!page || page.isClosed()) {
      throw new Error(`Page for target ${targetId} is closed or unavailable`);
    }

    const cdpSession = await page.createCDPSession();
    try {
      const result = await cdpSession.send('Page.captureScreenshot', {
        format: 'webp',
        quality: 60,
      }) as { data: string };
      return { base64: result.data, format: 'webp', sessionId };
    } finally {
      await cdpSession.detach().catch(() => { /* ignore */ });
    }
  }

  /**
   * GET /api/sessions - return connected sessions with tab counts
   */
  private handleSessions(res: http.ServerResponse): void {
    if (!this.sessionManager) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }

    const infos = this.sessionManager.getAllSessionInfos();
    const sessions = infos.map((info) => ({
      id: info.id,
      name: info.name,
      tabCount: info.targetCount,
      workerCount: info.workerCount,
      createdAt: info.createdAt,
      lastActivityAt: info.lastActivityAt,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
  }

  /**
   * GET /api/tool-calls - return recent tool calls from dashboard state
   */
  private handleToolCalls(url: URL, res: http.ServerResponse): void {
    const sessionId = url.searchParams.get('session_id') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const clampedLimit = Math.min(Math.max(1, limit), 100);

    const dashboardState = getDashboardState();
    const calls = dashboardState.getToolCalls(sessionId, clampedLimit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ calls }));
  }

  /**
   * GET /api/metrics - return server metrics
   */
  private handleMetrics(res: http.ServerResponse): void {
    const mem = process.memoryUsage();
    const dashboardState = getDashboardState();

    let tabCount = 0;
    let sessionCount = 0;
    if (this.sessionManager) {
      const stats = this.sessionManager.getStats();
      tabCount = stats.totalTargets;
      sessionCount = stats.activeSessions;
    }

    const metrics = {
      ram_mb: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
      tab_count: tabCount,
      uptime_secs: dashboardState.getUptimeSecs(),
      session_count: sessionCount,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics));
  }

  /**
   * POST /mcp - handle JSON-RPC request or batch
   *
   * Each request is associated with an AbortController whose signal is wired
   * through to the tool handler via ToolContext. When the HTTP client
   * disconnects before the response is sent, the controller aborts with a
   * ClientDisconnectError so in-flight CDP work can short-circuit (issue #8).
   *
   * Set OPENCHROME_ABORT_ON_DISCONNECT=false to disable the disconnect signal
   * (preserves the legacy "run-to-completion" behaviour).
   */
  private handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    tenantId: TenantId,
  ): void {
    const acceptSSE = (req.headers['accept'] || '').includes('text/event-stream');

    const abortOnDisconnect = process.env.OPENCHROME_ABORT_ON_DISCONNECT !== 'false';
    const controller = new AbortController();
    const signal = abortOnDisconnect ? controller.signal : undefined;

    if (abortOnDisconnect) {
      // The only Node event that reliably means "the underlying TCP connection
      // is gone" is socket 'close'. IncomingMessage 'close' fires as part of
      // the request stream lifecycle (after body 'end'), so it can't be used
      // to detect mid-flight disconnect without false positives.
      //
      // The listener is removed once the response is fully flushed
      // ('finish') so it does not survive a keep-alive socket and fire for a
      // future request.
      const sock = req.socket;
      const onSockClose = () => {
        if (!res.writableEnded && !controller.signal.aborted) {
          controller.abort(new ClientDisconnectError());
        }
      };
      if (sock) {
        sock.on('close', onSockClose);
        res.on('finish', () => sock.removeListener('close', onSockClose));
      }
    }

    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let finished = false;

    // Body receive deadline — independent of per-request timeout so it
    // catches slow-body (Slowloris-style) clients that stream bytes at
    // sub-threshold rates. Unrefed so it never prevents process exit.
    // HTTP_BODY_TIMEOUT_MS === 0 disables the deadline (documented rollback
    // path): skip the timer entirely, otherwise setTimeout(..., 0) would fire
    // on the next tick and 408 every request before any bytes are read.
    let bodyTimer: NodeJS.Timeout | null = null;
    if (HTTP_BODY_TIMEOUT_MS > 0) {
      bodyTimer = setTimeout(() => {
        if (finished) return;
        finished = true;
        if (!res.headersSent) {
          res.writeHead(408, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            error: {
              code: MCPErrorCodes.INVALID_REQUEST,
              message: `Request body not received within ${HTTP_BODY_TIMEOUT_MS}ms`,
            },
          }));
        }
        req.destroy();
      }, HTTP_BODY_TIMEOUT_MS);
      bodyTimer.unref();
    }

    const clearBodyTimer = () => {
      if (bodyTimer !== null) clearTimeout(bodyTimer);
    };

    // If the socket closes (client disconnect, server socket timeout, etc.)
    // we cannot send a response; just free the timer and bail out.
    req.on('close', () => {
      if (finished) return;
      finished = true;
      clearBodyTimer();
    });

    req.on('error', () => {
      if (finished) return;
      finished = true;
      clearBodyTimer();
    });

    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        finished = true;
        clearBodyTimer();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            error: { code: MCPErrorCodes.INVALID_REQUEST, message: 'Request body too large' },
          }));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (finished) return;
      finished = true;
      clearBodyTimer();
      const body = Buffer.concat(chunks).toString('utf-8');

      if (!body.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: MCPErrorCodes.PARSE_ERROR, message: 'Empty request body' },
        }));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: MCPErrorCodes.PARSE_ERROR,
            message: error instanceof Error ? error.message : 'Parse error',
          },
        }));
        return;
      }

      // The per-socket idle timeout is meant to protect header/body receive and
      // truly idle keepalive sockets. Once the full request body has been read,
      // valid MCP tool calls may legitimately run longer than that idle window,
      // so disable the request-level socket timer and let tool deadlines govern
      // execution. keepAliveTimeout still applies after the response finishes.
      req.setTimeout(0);

      // Session tracking via Mcp-Session-Id header
      let sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (!this.messageHandler) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: MCPErrorCodes.INTERNAL_ERROR, message: 'No message handler registered' },
        }));
        return;
      }

      // Correlation ID for this HTTP request — propagate into handler(s).
      const requestId = (req as http.IncomingMessage & { requestId?: string }).requestId
        || resolveRequestId(req.headers[REQUEST_ID_HEADER_LOWER]);
      const principal = requestPrincipals.get(req);

      // Handle JSON-RPC batch (array of requests)
      if (Array.isArray(parsed)) {
        const results = await runWithRequestContext(
          {
            requestId,
            tenantId: principal && (principal.mode === 'api-key' || principal.mode === 'jwt')
              ? principal.tenantId
              : tenantId,
            keyId: principal?.mode === 'api-key' ? principal.keyId : undefined,
          },
          () => this.processBatch(parsed, sessionId, tenantId, signal, principal),
        );
        // Filter out null results (notifications don't produce responses)
        const responses = results.filter((r): r is MCPResponse => r !== null);

        if (sessionId) {
          res.setHeader('Mcp-Session-Id', sessionId);
        }

        if (responses.length === 0) {
          // All were notifications — respond with 202 Accepted
          res.writeHead(202);
          res.end();
        } else if (responses.length === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responses[0]));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responses));
        }
        return;
      }

      // Single request/notification
      const msg = parsed as Record<string, unknown>;

      // Check if this is an initialize request — assign session ID
      if (msg.method === 'initialize' && !sessionId) {
        sessionId = crypto.randomUUID();
        this.sessions.add(sessionId);
        this.sessionTenants.set(sessionId, tenantId);
      }

      // Strip any client-provided `__principal` (defense-in-depth: this field
      // is a legacy string name; the trusted channel is the non-forgeable
      // PRINCIPAL_SYM Symbol below, but we still scrub the string key so a
      // malicious body cannot survive to downstream JSON serialization).
      if ('__principal' in (msg as Record<string, unknown>)) {
        delete (msg as Record<string, unknown>).__principal;
      }
      if (principal) {
        (msg as Record<PropertyKey, unknown>)[PRINCIPAL_SYM] = principal;
      }

      try {
        const response = await runWithRequestContext(
          {
            requestId,
            tenantId: principal && (principal.mode === 'api-key' || principal.mode === 'jwt')
              ? principal.tenantId
              : tenantId,
            keyId: principal?.mode === 'api-key' ? principal.keyId : undefined,
          },
          () => this.messageHandler!(msg, signal),
        );

        if (sessionId) {
          res.setHeader('Mcp-Session-Id', sessionId);
        }

        if (response === null) {
          // Notification — no response body
          res.writeHead(202);
          res.end();
        } else if (acceptSSE) {
          // Streamable HTTP: return response as SSE stream (single-response mode)
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          res.write(`data: ${JSON.stringify(response)}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        }
      } catch (error) {
        const id = (msg.id as string | number) ?? 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: MCPErrorCodes.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : 'Internal error',
          },
        }));
      }
    });

    req.on('error', (err) => {
      console.error('[HTTPTransport] Request read error:', err);
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: MCPErrorCodes.PARSE_ERROR, message: 'Request read error' },
        }));
      }
    });
  }

  /**
   * GET /mcp or GET /mcp/sse - Server-Sent Events for server-initiated notifications
   */
  private handleSSE(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _tenantId: TenantId,
  ): void {
    const sessionId = req.headers['mcp-session-id'] as string || 'anonymous';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial keepalive
    res.write(': keepalive\n\n');

    const conn: SSEConnection = { res, sessionId };
    this.sseConnections.push(conn);

    // Clean up on disconnect
    req.on('close', () => {
      const idx = this.sseConnections.indexOf(conn);
      if (idx !== -1) {
        this.sseConnections.splice(idx, 1);
      }
      console.error(`[HTTPTransport] SSE client disconnected (session: ${sessionId})`);
    });
  }

  /**
   * DELETE /mcp - Session termination
   */
  private handleDelete(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      this.sessionTenants.delete(sessionId);

      // Notify session-delete listeners (e.g. rate-limiter cleanup)
      if (this.sessionDeleteHandler) {
        this.sessionDeleteHandler(sessionId);
      }

      // Close any SSE connections for this session
      this.sseConnections = this.sseConnections.filter((conn) => {
        if (conn.sessionId === sessionId) {
          try {
            conn.res.end();
          } catch {
            // Already closed
          }
          return false;
        }
        return true;
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'session terminated' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
  }

  /**
   * Process a batch of JSON-RPC messages
   */
  private async processBatch(
    messages: unknown[],
    sessionId: string | undefined,
    tenantId: TenantId,
    signal?: AbortSignal,
    principal?: Principal,
  ): Promise<(MCPResponse | null)[]> {
    const handler = this.messageHandler!;

    if (messages.length > HTTP_JSON_RPC_BATCH_MAX_SIZE) {
      // Reject the whole batch with a single protocol-level error rather than
      // fabricating one response per element. Per JSON-RPC 2.0 §4.1, a server
      // must not respond to notifications — the previous per-item map invented
      // `id: 0` responses for notification entries, which a spec-conformant
      // client would correlate to an unrelated in-flight request. handlePost
      // unwraps a single-element array into one response object on the wire.
      return [this.createBatchTooLargeError()];
    }

    // Assign sessionId once before concurrent processing to avoid data race
    // when multiple initialize requests appear in the same batch.
    if (!sessionId) {
      const hasInitialize = messages.some(
        (msg) => typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).method === 'initialize',
      );
      if (hasInitialize) {
        sessionId = crypto.randomUUID();
        this.sessions.add(sessionId);
        this.sessionTenants.set(sessionId, tenantId);
      }
    }

    return this.mapBatchWithConcurrency(messages, HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY, async (msg) => {
      // Wrap the entire per-element body in try/catch. mapBatchWithConcurrency
      // shares one results array across workers, so a synchronous throw from
      // any branch (e.g., a frozen `record` rejecting __principal scrubbing)
      // would unwind that worker mid-loop and leave the unfilled slots as
      // `undefined`, corrupting later responses' index → request mapping.
      const record = (typeof msg === 'object' && msg !== null)
        ? (msg as Record<string, unknown>)
        : null;
      try {
        if (record === null) {
          return {
            jsonrpc: '2.0' as const,
            id: 0,
            error: {
              code: MCPErrorCodes.INVALID_REQUEST,
              message: 'Invalid batch element: not an object',
            },
          } as MCPResponse;
        }

        // Same defense-in-depth as the single-message path: scrub any
        // client-provided `__principal` and attach the trusted one via Symbol.
        if ('__principal' in record) {
          delete record.__principal;
        }
        if (principal) {
          (record as Record<PropertyKey, unknown>)[PRINCIPAL_SYM] = principal;
        }

        return await handler(record, signal);
      } catch (error) {
        const id = record !== null
          ? ((record.id as string | number | undefined) ?? 0)
          : 0;
        return {
          jsonrpc: '2.0' as const,
          id,
          error: {
            code: MCPErrorCodes.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : 'Internal error',
          },
        } as MCPResponse;
      }
    });
  }

  private createBatchTooLargeError(): MCPResponse {
    // id: null is the JSON-RPC 2.0 §5.1 sentinel for errors detected before a
    // request id can be parsed (or, here, any meaningful per-element id can be
    // chosen). It also avoids colliding with an active client-request id.
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: MCPErrorCodes.INVALID_REQUEST,
        message: `JSON-RPC batch size exceeds maximum of ${HTTP_JSON_RPC_BATCH_MAX_SIZE}`,
      },
    };
  }

  private async mapBatchWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const workerCount = Math.min(concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await fn(items[currentIndex]);
      }
    });

    await Promise.all(workers);
    return results;
  }
}
