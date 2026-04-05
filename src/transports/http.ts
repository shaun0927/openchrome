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
import { MCPTransport } from './index';
import { getDashboardState } from '../desktop/dashboard-state';
import type { SessionManager } from '../session-manager';

/** Maximum allowed HTTP request body size (10 MB) to prevent OOM from oversized requests */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Active SSE connections for server-initiated notifications */
interface SSEConnection {
  res: http.ServerResponse;
  sessionId: string;
}

export class HTTPTransport implements MCPTransport {
  private server: http.Server | null = null;
  private messageHandler: ((msg: Record<string, unknown>) => Promise<MCPResponse | null>) | null = null;
  private port: number;
  private host: string;
  private authToken: string | undefined;
  private sessions: Set<string> = new Set();
  private sseConnections: SSEConnection[] = [];
  private sessionDeleteHandler: ((sessionId: string) => void) | null = null;
  private sessionManager: SessionManager | null = null;
  private readonly serverStartTime: number = Date.now();

  constructor(port: number, host = '127.0.0.1', authToken?: string) {
    this.port = port;
    this.host = host;
    this.authToken = authToken;
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

  onMessage(handler: (msg: Record<string, unknown>) => Promise<MCPResponse | null>): void {
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

    this.server.listen(this.port, this.host, () => {
      console.error(`[HTTPTransport] Listening on ${this.host}:${this.port}`);
      console.error(`[HTTPTransport] MCP endpoint: http://${this.host}:${this.port}/mcp`);
    });

    this.server.on('error', (err) => {
      console.error(`[HTTPTransport] Server error:`, err);
    });
  }

  async close(): Promise<void> {
    // Close all SSE connections
    for (const conn of this.sseConnections) {
      try {
        conn.res.end();
      } catch {
        // Already closed
      }
    }
    this.sseConnections = [];

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

    // CORS headers for all responses — restrict origin when auth is enabled
    res.setHeader('Access-Control-Allow-Origin', this.authToken ? 'null' : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

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

    // Bearer token validation: reject requests without valid token when configured
    if (this.authToken) {
      const authHeader = req.headers['authorization'];
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const expected = Buffer.from(this.authToken);
      const provided = Buffer.from(token);
      if (provided.length !== expected.length || !crypto.timingSafeEqual(expected, provided)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

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

    if (pathname === '/mcp') {
      switch (req.method) {
        case 'POST':
          this.handlePost(req, res);
          return;
        case 'GET':
          this.handleSSE(req, res);
          return;
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
   */
  private handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    const acceptSSE = (req.headers['accept'] || '').includes('text/event-stream');

    const chunks: Buffer[] = [];
    let bodyBytes = 0;

    req.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: MCPErrorCodes.INVALID_REQUEST, message: 'Request body too large' },
        }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
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

      // Handle JSON-RPC batch (array of requests)
      if (Array.isArray(parsed)) {
        const results = await this.processBatch(parsed, sessionId);
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
      }

      try {
        const response = await this.messageHandler(msg);

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
   * GET /mcp - Server-Sent Events for server-initiated notifications
   */
  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
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
  ): Promise<(MCPResponse | null)[]> {
    const handler = this.messageHandler!;

    // Assign sessionId once before concurrent processing to avoid data race
    // when multiple initialize requests appear in the same batch.
    if (!sessionId) {
      const hasInitialize = messages.some(
        (msg) => typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).method === 'initialize',
      );
      if (hasInitialize) {
        sessionId = crypto.randomUUID();
        this.sessions.add(sessionId);
      }
    }

    const promises = messages.map(async (msg) => {
      if (typeof msg !== 'object' || msg === null) {
        return {
          jsonrpc: '2.0' as const,
          id: 0,
          error: {
            code: MCPErrorCodes.INVALID_REQUEST,
            message: 'Invalid batch element: not an object',
          },
        } as MCPResponse;
      }

      const record = msg as Record<string, unknown>;

      try {
        return await handler(record);
      } catch (error) {
        const id = (record.id as string | number) ?? 0;
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

    return Promise.all(promises);
  }
}
