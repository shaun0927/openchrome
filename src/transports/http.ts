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
import { ClientDisconnectError } from '../errors/abort';
import { MCPTransport, TransportMessageContext } from './index';
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
import {
  HTTP_BODY_TIMEOUT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_JSON_RPC_BATCH_MAX_CONCURRENCY,
  HTTP_JSON_RPC_BATCH_MAX_SIZE,
  HTTP_KEEPALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  HTTP_SOCKET_TIMEOUT_MS,
  MAX_BODY_BYTES,
  SSE_KEEPALIVE_INTERVAL_MS,
} from './http/config';
import { applyCors, formatServerOriginHost, parseCorsOrigins } from './http/cors';
import {
  envFlag,
  resolveAuthMode,
  validateUnauthenticatedHttpPolicy,
} from './http/auth';
import { createBatchTooLargeError, mapBatchWithConcurrency } from './http/batch';
import {
  handleDashboardMetrics,
  handleDashboardPrometheusMetrics,
  handleDashboardScreenshot,
  handleDashboardSessions,
  handleDashboardToolCalls,
} from './http/dashboard-routes';

export { HTTP_TIMEOUTS } from './http/config';

/** Active SSE connections for server-initiated notifications */
interface SSEConnection {
  res: http.ServerResponse;
  sessionId: string;
}

export interface HTTPTransportOptions {
  apiKeyStore?: ApiKeyStore;
  jwt?: JwtConfig;
  /**
   * Explicit opt-in for unauthenticated loopback-only HTTP development.
   * Production/daemon HTTP mode must configure auth instead of silently
   * receiving admin-scoped disabled auth.
   */
  allowUnauthenticatedHttp?: boolean;
  /** Explicit browser origins allowed to use MCP CORS. Defaults to env. */
  corsAllowedOrigins?: string[];
}

export class HTTPTransport implements MCPTransport {
  private server: http.Server | null = null;
  private messageHandler:
    | ((msg: Record<string, unknown>, signal?: AbortSignal, context?: TransportMessageContext) => Promise<MCPResponse | null>)
    | null = null;
  private port: number;
  private host: string;
  private authToken: string | undefined;
  private authMode: AuthMode;
  private readonly corsAllowedOrigins: Set<string>;
  private readonly serverOriginHost: string;
  private sessions: Set<string> = new Set();
  private sseConnections: SSEConnection[] = [];
  private sessionDeleteHandler: ((sessionId: string) => void) | null = null;
  private sessionCloseHandler: ((sessionId: string) => void) | null = null;
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
    this.authMode = resolveAuthMode(authToken, options.apiKeyStore, verifier);
    const allowUnauthenticatedHttp = options.allowUnauthenticatedHttp ?? envFlag('OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP');
    validateUnauthenticatedHttpPolicy(this.authMode, this.host, allowUnauthenticatedHttp);
    this.corsAllowedOrigins = new Set([
      ...parseCorsOrigins(process.env.OPENCHROME_HTTP_CORS_ORIGINS),
      ...(options.corsAllowedOrigins || []),
    ]);
    this.serverOriginHost = formatServerOriginHost(this.host, this.port);
  }

  /**
   * Resolve the runtime auth mode from env + ctor args.
   * Kept as a public facade for callers/tests while the implementation lives
   * in `transports/http/auth` for issue #687's facade-preserving split.
   */
  static resolveAuthMode(
    authToken: string | undefined,
    store: ApiKeyStore | undefined,
    verifier?: JwtVerifier,
  ): AuthMode {
    return resolveAuthMode(authToken, store, verifier);
  }

  private applyCors(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    return applyCors(req, res, pathname, this.corsAllowedOrigins, this.serverOriginHost);
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

  onSessionClose(handler: (sessionId: string) => void): void {
    this.sessionCloseHandler = handler;
  }

  /**
   * Set the session manager so dashboard API endpoints can access session/tab data.
   */
  setSessionManager(sm: SessionManager): void {
    this.sessionManager = sm;
  }

  onMessage(
    handler: (msg: Record<string, unknown>, signal?: AbortSignal, context?: TransportMessageContext) => Promise<MCPResponse | null>,
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

  sendToSession(sessionId: string, response: MCPResponse): boolean {
    let sent = false;
    for (const conn of this.sseConnections) {
      if (conn.sessionId !== sessionId) continue;
      try {
        conn.res.write(`data: ${JSON.stringify(response)}\n\n`);
        sent = true;
      } catch {
        // Connection may have been closed
      }
    }
    return sent;
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

    // CORS is explicit allowlist-only for browser-origin MCP requests. Non-browser
    // clients that do not send Origin continue through normal authentication.
    if (!this.applyCors(req, res, pathname)) {
      return;
    }

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
      this.handleScreenshot(req, url, res);
      return;
    }
    if (pathname === '/api/sessions' && req.method === 'GET') {
      this.handleSessions(req, res);
      return;
    }
    if (pathname === '/api/tool-calls' && req.method === 'GET') {
      this.handleToolCalls(req, url, res);
      return;
    }
    if (pathname === '/api/metrics' && req.method === 'GET') {
      this.handleMetrics(req, res);
      return;
    }
    // Prometheus text exposition format (#839). Auth-required via the same
    // bearer/api-key flow as /api/metrics. Hand-rolled — no prom-client
    // dependency per P5.
    if (pathname === '/metrics' && req.method === 'GET') {
      this.handlePrometheusMetrics(req, res);
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
  private handleScreenshot(req: http.IncomingMessage, url: URL, res: http.ServerResponse): void {
    handleDashboardScreenshot(req, url, res, this.sessionManager);
  }

  /**
   * GET /api/sessions - return connected sessions with tab counts
   */
  private handleSessions(req: http.IncomingMessage, res: http.ServerResponse): void {
    handleDashboardSessions(req, res, this.sessionManager);
  }

  /**
   * GET /api/tool-calls - return recent tool calls from dashboard state
   */
  private handleToolCalls(req: http.IncomingMessage, url: URL, res: http.ServerResponse): void {
    handleDashboardToolCalls(req, url, res, this.sessionManager);
  }

  /**
   * GET /api/metrics - return server metrics
   */
  private handleMetrics(req: http.IncomingMessage, res: http.ServerResponse): void {
    handleDashboardMetrics(req, res, this.sessionManager);
  }

  /**
   * GET /metrics — Prometheus text exposition format (#839).
   */
  private handlePrometheusMetrics(req: http.IncomingMessage, res: http.ServerResponse): void {
    handleDashboardPrometheusMetrics(req, res, this.sessionManager);
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
      // so disable both request and socket timers and let tool deadlines govern
      // execution. keepAliveTimeout still applies after the response finishes.
      req.setTimeout(0);
      req.socket.setTimeout(0);

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
            mcpSessionId: sessionId,
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
            mcpSessionId: sessionId,
          },
          () => this.messageHandler!(msg, signal, { mcpSessionId: sessionId, tenantId }),
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
      if (this.sessionCloseHandler) {
        this.sessionCloseHandler(sessionId);
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
      if (this.sessionCloseHandler) {
        this.sessionCloseHandler(sessionId);
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

        return await handler(record, signal, { mcpSessionId: sessionId, tenantId });
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
    return createBatchTooLargeError(HTTP_JSON_RPC_BATCH_MAX_SIZE);
  }

  private async mapBatchWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    return mapBatchWithConcurrency(items, concurrency, fn);
  }
}
