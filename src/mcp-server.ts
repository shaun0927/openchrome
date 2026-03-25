/**
 * MCP Server - Implements MCP protocol with pluggable transports (stdio, HTTP)
 */

import * as path from 'path';
import {
  MCPRequest,
  MCPResponse,
  MCPResult,
  MCPError,
  MCPToolDefinition,
  ToolHandler,
  ToolRegistry,
  MCPErrorCodes,
} from './types/mcp';
import { MCPTransport, createTransport } from './transports/index';
import { SessionManager, getSessionManager } from './session-manager';
import { Dashboard, getDashboard, ActivityTracker, getActivityTracker, OperationController } from './dashboard/index.js';
import { usageGuideResource, getUsageGuideContent, MCPResourceDefinition } from './resources/usage-guide';
import { HintEngine } from './hints';
import { validateToolSchema } from './utils/schema-validator';
import { formatAge } from './utils/format-age';
import { formatError } from './utils/format-error';
import { getCDPConnectionPool } from './cdp/connection-pool';
import { getCDPClient, ConnectionEvent } from './cdp/client';
import { getChromeLauncher } from './chrome/launcher';
import { getChromePool } from './chrome/pool';
import { ToolManifest, ToolEntry, ToolCategory } from './types/tool-manifest';
import { DEFAULT_TOOL_EXECUTION_TIMEOUT_MS, DEFAULT_SESSION_INIT_TIMEOUT_MS, DEFAULT_SESSION_INIT_TIMEOUT_AUTO_LAUNCH_MS, DEFAULT_RECONNECT_TIMEOUT_MS, DEFAULT_OPERATION_GATE_TIMEOUT_MS, DEFAULT_HEARTBEAT_IDLE_TIMEOUT_MS, DEFAULT_RATE_LIMIT_RPM } from './config/defaults';
import { getGlobalEventLoopMonitor } from './watchdog/event-loop-monitor';
import { SessionRateLimiter } from './utils/rate-limiter';
import { getGlobalConfig } from './config/global';
import { getToolTier, ToolTier } from './config/tool-tiers';
import { getMetricsCollector } from './metrics/collector';
import { logAuditEntry } from './security/audit-logger';
import { getVersion } from './version';
import { isTimeoutError } from './errors/timeout';
import { getTaskJournal } from './journal/task-journal';

/**
 * Detect if an error is a Chrome/CDP connection error that may be recoverable
 * by reconnecting to the browser.
 */
export function isConnectionError(error: unknown): boolean {
  const message = formatError(error);
  const patterns = [
    'not connected to chrome',
    'call connect() first',
    'connection closed',
    'protocol error',
    'target closed',
    'session closed',
    'websocket is not open',
    'websocket connection closed',
    'browser has disconnected',
    'browser disconnected',
    'execution context was destroyed',
    'cannot find context with specified id',
    'inspected target navigated or closed',
    'cdpsession connection closed',
    'puppeteer.connect() timed out',
    'session initialization timed out',
  ];
  const lowerMessage = message.toLowerCase();
  return patterns.some(pattern => lowerMessage.includes(pattern));
}

/** Lifecycle tools that must work even when the CDP connection is broken (e.g., after
 *  sleep/wake). Skip session initialization so oc_stop can always reach its handler. */
const SKIP_SESSION_INIT_TOOLS = new Set(['oc_stop', 'oc_profile_status', 'oc_session_snapshot', 'oc_session_resume', 'oc_journal']);

/** Tools that may legitimately block the event loop longer than the normal fatal threshold. */
const HEAVY_TOOLS = new Set(['computer', 'read_page', 'query_dom', 'cookies', 'javascript_tool']);

/**
 * Clients known to support notifications/tools/list_changed.
 * Progressive disclosure (tiered tools) is only enabled for these clients.
 * Unknown clients get all tools exposed immediately.
 */
const PROGRESSIVE_DISCLOSURE_CLIENTS = new Set([
  'claude-code',
  'claude',
  'cursor',
  'vscode',
  'windsurf',
  'cline',
  'zed',
  'continue',
]);

const RECONNECTION_GUIDANCE =
  '\n\nNote: The browser connection was lost and auto-reconnect was attempted. ' +
  'Simply retry your operation — Chrome will be re-launched automatically if needed. ' +
  'If the error persists, use tabs_context to get fresh tab IDs.';

export interface MCPServerOptions {
  dashboard?: boolean;
  dashboardRefreshInterval?: number;
  initialToolTier?: ToolTier;
}

export class MCPServer {
  private tools: Map<string, ToolRegistry> = new Map();
  private resources: Map<string, MCPResourceDefinition> = new Map();
  private manifestVersion: number = 1;
  private sessionManager: SessionManager;
  private transport: MCPTransport | null = null;
  private dashboard: Dashboard | null = null;
  private activityTracker: ActivityTracker | null = null;
  private operationController: OperationController | null = null;
  private hintEngine: HintEngine | null = null;
  private options: MCPServerOptions;
  private profileWarningShown = false;
  private exposedTier: ToolTier = 1;
  private clientSupportsListChanged = true;
  private clientDetected = false;
  private heartbeatIdleTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;
  private rateLimiter: SessionRateLimiter | null = null;

  constructor(sessionManager?: SessionManager, options: MCPServerOptions = {}) {
    this.sessionManager = sessionManager || getSessionManager();
    this.options = options;

    if (options.initialToolTier) {
      this.exposedTier = options.initialToolTier;
    }

    // Register built-in resources
    this.registerResource(usageGuideResource);

    // Initialize dashboard if enabled
    if (options.dashboard) {
      this.initDashboard();
    }

    // Always-on activity tracking (uses singleton, shared with dashboard if enabled)
    if (!this.activityTracker) {
      this.activityTracker = getActivityTracker();
    }
    this.activityTracker.enableFileLogging(
      path.join(process.cwd(), '.openchrome', 'timeline')
    );

    // Initialize hint engine with logging and adaptive learning
    const hintsDir = path.join(process.cwd(), '.openchrome', 'hints');
    this.hintEngine = new HintEngine(this.activityTracker);
    this.hintEngine.enableLogging(hintsDir);
    this.hintEngine.enableLearning(hintsDir);

    // Initialize task journal
    getTaskJournal().init().catch((err: unknown) => {
      console.error('[MCPServer] Task journal init failed:', err);
    });

    // Initialize rate limiter if configured (0 = disabled)
    const rateLimitRpm = parseInt(process.env.OPENCHROME_RATE_LIMIT_RPM || '', 10) || DEFAULT_RATE_LIMIT_RPM;
    if (rateLimitRpm > 0) {
      this.rateLimiter = new SessionRateLimiter(rateLimitRpm);
      console.error(`[MCPServer] Rate limiter: ${rateLimitRpm} requests/min per session`);
    }
  }

  /**
   * Register a resource
   */
  registerResource(resource: MCPResourceDefinition): void {
    this.resources.set(resource.uri, resource);
  }

  /**
   * Initialize the dashboard
   */
  private initDashboard(): void {
    this.dashboard = getDashboard({
      enabled: true,
      refreshInterval: this.options.dashboardRefreshInterval || 100,
    });
    this.dashboard.setSessionManager(this.sessionManager);
    this.activityTracker = this.dashboard.getActivityTracker();
    this.operationController = this.dashboard.getOperationController();

    // Handle quit event
    this.dashboard.on('quit', () => {
      console.error('[MCPServer] Dashboard quit requested');
      this.stop().then(() => {
        process.exit(0);
      }).catch((err) => {
        console.error('[MCPServer] Shutdown error:', err);
        process.exit(1);
      });
    });

    // Handle delete session event
    this.dashboard.on('delete-session', async (sessionId: string) => {
      try {
        await this.sessionManager.deleteSession(sessionId);
        console.error(`[MCPServer] Session ${sessionId} deleted via dashboard`);
      } catch (error) {
        console.error(`[MCPServer] Failed to delete session: ${error}`);
      }
    });
  }

  /**
   * Register a tool
   */
  registerTool(
    name: string,
    handler: ToolHandler,
    definition: MCPToolDefinition,
    options?: { timeoutRecoverable?: boolean }
  ): void {
    validateToolSchema(name, definition.inputSchema);
    this.tools.set(name, { name, handler, definition, ...options });
    this.manifestVersion++;
  }

  /**
   * Expand tool exposure to include a higher tier.
   * Sends tools/list_changed notification so clients re-fetch the tool list.
   */
  public expandToolTier(tier: ToolTier): void {
    if (tier > this.exposedTier) {
      this.exposedTier = tier;
      // Only notify clients that support listChanged — unknown clients already have all tools
      if (this.clientSupportsListChanged) {
        this.sendNotification('notifications/tools/list_changed');
      }
    }
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected)
   */
  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      ...(params ? { params } : {}),
    };
    this.sendResponse(notification as unknown as MCPResponse);
  }

  /**
   * Start the MCP server with the given transport.
   * If no transport is provided, defaults to stdio (backward compatible).
   */
  start(transport?: MCPTransport): void {
    if (transport) {
      this.transport = transport;
    } else {
      this.transport = createTransport('stdio');
    }

    // Wire rate-limiter session cleanup into the HTTP transport so that
    // bucket memory is freed immediately when a client sends DELETE /mcp.
    if (this.rateLimiter && typeof (this.transport as unknown as { onSessionDelete?: unknown }).onSessionDelete === 'function') {
      (this.transport as unknown as { onSessionDelete: (cb: (id: string) => void) => void }).onSessionDelete(
        (sessionId: string) => this.rateLimiter!.removeSession(sessionId),
      );
    }

    console.error('[MCPServer] Starting server...');

    // Start dashboard if enabled
    if (this.dashboard) {
      const started = this.dashboard.start();
      if (started) {
        console.error('[MCPServer] Dashboard started');
      } else {
        console.error('[MCPServer] Dashboard could not start (non-TTY environment)');
      }
    }

    // Wire the transport message handler to MCPServer protocol logic
    this.transport.onMessage(async (parsed: Record<string, unknown>) => {
      // Validate JSON-RPC 2.0 envelope
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        parsed.jsonrpc !== '2.0' ||
        typeof parsed.method !== 'string'
      ) {
        return {
          jsonrpc: '2.0' as const,
          id: (parsed.id as string | number) ?? 0,
          error: {
            code: MCPErrorCodes.INVALID_REQUEST,
            message: 'Invalid JSON-RPC 2.0 request: missing jsonrpc or method field',
          },
        };
      }

      // Notifications have no `id` field — must NOT receive a response per JSON-RPC 2.0 spec
      if (parsed.id === undefined || parsed.id === null) {
        const method = parsed.method as string;
        if (method === 'notifications/initialized' || method === 'initialized') {
          console.error(`[MCPServer] Received notification: ${method}`);
        }
        // All notifications are silently ignored (no response sent)
        return null;
      }

      const request = parsed as unknown as MCPRequest;

      try {
        return await this.handleRequest(request);
      } catch (error) {
        return {
          jsonrpc: '2.0' as const,
          id: request.id,
          error: {
            code: MCPErrorCodes.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : 'Internal error',
          },
        };
      }
    });

    this.transport.start();

    console.error('[MCPServer] Ready, waiting for requests...');
  }

  /**
   * Send response via the active transport
   */
  private sendResponse(response: MCPResponse): void {
    if (this.transport) {
      this.transport.send(response);
    } else {
      // Fallback: should not happen after start(), but safe guard
      console.log(JSON.stringify(response));
    }
  }

  /**
   * Handle incoming MCP request
   */
  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    const requestReceivedAt = Date.now();
    const { id, method, params } = request;

    try {
      let result: MCPResult;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params);
          break;

        case 'tools/list':
          result = await this.handleToolsList();
          break;

        case 'tools/call':
          result = await this.handleToolsCall(params, id);
          break;

        case 'resources/list':
          result = await this.handleResourcesList();
          break;

        case 'resources/read':
          result = await this.handleResourcesRead(params);
          break;

        case 'sessions/list':
          result = await this.handleSessionsList();
          break;

        case 'sessions/create':
          result = await this.handleSessionsCreate(params);
          break;

        case 'sessions/delete':
          result = await this.handleSessionsDelete(params);
          break;

        default:
          return this.errorResponse(id, MCPErrorCodes.METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }

      return {
        jsonrpc: '2.0',
        id,
        result,
      };
    } catch (error) {
      const message = formatError(error);
      return this.errorResponse(id, MCPErrorCodes.INTERNAL_ERROR, message);
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(params?: Record<string, unknown>): Promise<MCPResult> {
    // Detect client identity for progressive disclosure decisions
    const clientInfo = params?.clientInfo as { name?: string; version?: string } | undefined;
    const rawName = clientInfo?.name ?? '';
    const nameLower = rawName.toLowerCase();

    // Idempotency: only detect client on first initialize (reconnects preserve state)
    if (!this.clientDetected) {
      this.clientDetected = true;

      if (this.options.initialToolTier) {
        console.error(`[openchrome] Tool tier override: initialToolTier=${this.options.initialToolTier}, skipping client detection`);
      } else {
        const isKnownClient = rawName !== '' && Array.from(PROGRESSIVE_DISCLOSURE_CLIENTS).some(known =>
          nameLower.includes(known)
        );

        if (!isKnownClient) {
          // Unknown or absent client: expose all tools immediately (no progressive disclosure)
          this.exposedTier = 3;
          this.clientSupportsListChanged = false;
          console.error(`[openchrome] Client "${rawName || '(no clientInfo)'}" — progressive disclosure disabled, exposing all tools`);
        } else {
          // Known client: keep progressive disclosure enabled
          console.error(`[openchrome] Client "${rawName}" supports tool list changes — progressive disclosure enabled`);
        }
      }
    }

    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: { listChanged: this.clientSupportsListChanged },
        resources: {},
      },
      serverInfo: {
        name: 'openchrome',
        version: getVersion(),
      },
    };
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(): Promise<MCPResult> {
    const tools: MCPToolDefinition[] = [];
    for (const registry of this.tools.values()) {
      const tier = getToolTier(registry.definition.name);
      if (tier <= this.exposedTier) {
        tools.push(registry.definition);
      }
    }

    // Add hint about additional tools when not fully expanded.
    // Only inject expand_tools if the client supports notifications/tools/list_changed —
    // otherwise there's no point since the client can't react to the notification.
    if (this.exposedTier < 3 && this.clientSupportsListChanged) {
      const hiddenCount = Array.from(this.tools.values()).filter(
        r => getToolTier(r.definition.name) > this.exposedTier
      ).length;
      if (hiddenCount > 0) {
        tools.push({
          name: 'expand_tools',
          description: `Show ${hiddenCount} additional specialist tools (network, emulation, PDF, orchestration, etc). Call with tier=2 for specialist tools, tier=3 for all tools including orchestration.`,
          inputSchema: {
            type: 'object',
            properties: {
              tier: {
                type: 'string',
                enum: Array.from({ length: 3 - this.exposedTier }, (_, i) => String(this.exposedTier + 1 + i)),
                description: 'Tool tier to expand to. 2=specialist, 3=all including orchestration',
              },
            },
            required: ['tier'],
          },
        });
      }
    }

    return { tools };
  }

  /**
   * Handle resources/list request
   */
  private async handleResourcesList(): Promise<MCPResult> {
    const resources: MCPResourceDefinition[] = [];
    for (const resource of this.resources.values()) {
      resources.push(resource);
    }
    return { resources };
  }

  /**
   * Handle resources/read request
   */
  private async handleResourcesRead(params?: Record<string, unknown>): Promise<MCPResult> {
    if (!params) {
      throw new Error('Missing params for resources/read');
    }

    const uri = params.uri as string;
    if (!uri) {
      throw new Error('Missing resource uri');
    }

    const resource = this.resources.get(uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    // Get content based on resource type
    let content: string;
    if (uri === 'openchrome://usage-guide') {
      content = getUsageGuideContent();
    } else {
      throw new Error(`No content handler for resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: content,
        },
      ],
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(params?: Record<string, unknown>, requestId?: number | string): Promise<MCPResult> {
    if (!params) {
      throw new Error('Missing params for tools/call');
    }

    const toolName = params.name as string;
    const toolArgs = (params.arguments || {}) as Record<string, unknown>;
    // Use 'default' session if no sessionId is provided
    const sessionId = (toolArgs.sessionId || params.sessionId || 'default') as string;

    if (!toolName) {
      throw new Error('Missing tool name');
    }

    // Handle the expand_tools meta-tool before normal tool lookup
    if (toolName === 'expand_tools') {
      const oldTier = this.exposedTier;
      const tier = parseInt(String(toolArgs?.tier ?? '2'), 10) || 2;
      this.expandToolTier(Math.min(tier, 3) as ToolTier);

      // Collect newly-exposed tool definitions for clients that don't support list_changed
      const newTools = Array.from(this.tools.values())
        .filter(r => {
          const t = getToolTier(r.definition.name);
          return t <= this.exposedTier && t > oldTier;
        })
        .map(r => r.definition);

      const toolCount = Array.from(this.tools.values()).filter(
        r => getToolTier(r.definition.name) <= this.exposedTier
      ).length;

      let text = `Tool tier expanded to ${this.exposedTier}. Now exposing ${toolCount} tools.`;
      if (newTools.length > 0) {
        text += `\n\nNewly available tools:\n${JSON.stringify(newTools, null, 2)}\n\nYou can now call these tools directly by name.`;
      }

      return {
        content: [{ type: 'text', text }],
      };
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Auto-expand tier if a higher-tier tool is called directly
    // This handles the case where the AI learned about the tool from documentation
    const toolTier = getToolTier(toolName);
    if (toolTier > this.exposedTier) {
      this.expandToolTier(toolTier);
    }

    // Rate limit check — reject before doing any work
    if (this.rateLimiter) {
      const rateResult = this.rateLimiter.check(sessionId);
      if (!rateResult.allowed) {
        console.error(`[MCPServer] Rate limit exceeded for session ${sessionId}, retry after ${rateResult.retryAfterSec}s`);
        try { getMetricsCollector().inc('openchrome_rate_limit_rejections_total', { tool: toolName }); } catch { /* best-effort */ }
        return {
          content: [
            {
              type: 'text',
              text: `Rate limit exceeded. Too many requests from this session. Please retry after ${rateResult.retryAfterSec} second(s). Current limit: ${process.env.OPENCHROME_RATE_LIMIT_RPM || DEFAULT_RATE_LIMIT_RPM} requests/minute.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Reconnection wait — if Chrome is reconnecting, wait for it to complete
    // instead of rejecting immediately. This is server-level resilience, not orchestration.
    // Allow lifecycle tools that must work during disconnection (oc_stop, oc_session_resume, etc.)
    if (!SKIP_SESSION_INIT_TOOLS.has(toolName)) try {
      const cdpClient = getCDPClient();
      if (cdpClient.isReconnecting()) {
        console.error(`[MCPServer] Tool call "${toolName}" arrived during reconnection, waiting...`);
        try { getMetricsCollector().inc('openchrome_tool_calls_total', { tool: toolName, status: 'reconnecting_wait' }); } catch { /* best-effort */ }
        const reconnectResult = await new Promise<'reconnected' | 'failed' | 'timeout'>((resolve) => {
          const timeout = setTimeout(() => {
            cdpClient.removeConnectionListener(listener);
            resolve('timeout');
          }, DEFAULT_SESSION_INIT_TIMEOUT_MS);

          const listener = (event: ConnectionEvent) => {
            if (event.type === 'reconnected' || event.type === 'connected') {
              clearTimeout(timeout);
              cdpClient.removeConnectionListener(listener);
              resolve('reconnected');
            } else if (event.type === 'reconnect_failed' || event.type === 'disconnected') {
              clearTimeout(timeout);
              cdpClient.removeConnectionListener(listener);
              resolve('failed');
            }
          };
          cdpClient.addConnectionListener(listener);

          // Check again in case reconnection completed between the if-check and listener registration
          if (!cdpClient.isReconnecting()) {
            clearTimeout(timeout);
            cdpClient.removeConnectionListener(listener);
            resolve('reconnected');
          }
        });

        if (reconnectResult !== 'reconnected') {
          return {
            content: [
              {
                type: 'text',
                text: `Chrome reconnection ${reconnectResult === 'timeout' ? 'timed out' : 'failed'}. The server could not re-establish the connection. Try again or check if Chrome is running.`,
              },
            ],
            isError: true,
          };
        }
        console.error(`[MCPServer] Reconnection complete, proceeding with "${toolName}"`);
      }
    } catch {
      // CDPClient may not be initialized — proceed with normal flow
    }

    // Start activity tracking
    const callId = this.activityTracker!.startCall(toolName, sessionId || 'default', toolArgs, requestId);
    const toolStartTime = Date.now();

    // Adaptive heartbeat: switch to heavy mode during tool execution
    try {
      const cdpClient = getCDPClient();
      if (cdpClient.setHeartbeatMode) {
        cdpClient.setHeartbeatMode('heavy');
      }
      if (this.heartbeatIdleTimer) {
        clearTimeout(this.heartbeatIdleTimer);
        this.heartbeatIdleTimer = null;
      }
    } catch {
      // CDP client may not be initialized yet
    }

    try {
      // Ensure session exists.
      // Use a longer timeout when autoLaunch is enabled because Chrome launch (up to 30s)
      // + puppeteer.connect (up to 15s) can exceed the default 30s session init timeout.
      if (sessionId && !SKIP_SESSION_INIT_TOOLS.has(toolName)) {
        const globalConfig = getGlobalConfig();
        const sessionInitTimeout = globalConfig.autoLaunch
          ? DEFAULT_SESSION_INIT_TIMEOUT_AUTO_LAUNCH_MS
          : DEFAULT_SESSION_INIT_TIMEOUT_MS;
        let sessionInitTid: ReturnType<typeof setTimeout>;
        await Promise.race([
          this.sessionManager.getOrCreateSession(sessionId).finally(() => clearTimeout(sessionInitTid)),
          new Promise<never>((_, reject) => {
            sessionInitTid = setTimeout(() => reject(new Error(`Session initialization timed out after ${sessionInitTimeout}ms`)), sessionInitTimeout);
          }),
        ]);
      }

      // Wait at gate if paused
      if (this.operationController) {
        let gateTid: ReturnType<typeof setTimeout>;
        await Promise.race([
          this.operationController.gate(callId).finally(() => clearTimeout(gateTid)),
          new Promise<never>((_, reject) => {
            gateTid = setTimeout(() => reject(new Error(`Operation gate timed out after ${DEFAULT_OPERATION_GATE_TIMEOUT_MS}ms`)), DEFAULT_OPERATION_GATE_TIMEOUT_MS);
          }),
        ]);
      }

      // Identify heavy tools that may block the event loop legitimately
      // (screenshot captures, full-page DOM reads, bulk cookie scans, arbitrary JS).
      const isHeavyTool = HEAVY_TOOLS.has(toolName);

      const eventLoopMonitor = getGlobalEventLoopMonitor();
      if (isHeavyTool && eventLoopMonitor) {
        eventLoopMonitor.beginHeavyOperation();
      }

      let result: MCPResult;
      try {
        let tid: ReturnType<typeof setTimeout>;
        result = await Promise.race([
          Promise.resolve(tool.handler(sessionId, toolArgs)).finally(() => clearTimeout(tid)),
          new Promise<never>((_, reject) => {
            tid = setTimeout(
              () => reject(new Error(`Tool '${toolName}' timed out after ${DEFAULT_TOOL_EXECUTION_TIMEOUT_MS}ms`)),
              DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (handlerError) {
        if (isConnectionError(handlerError)) {
          // Attempt internal reconnection before surfacing error to LLM
          console.error(`[MCPServer] Connection error during ${toolName}, attempting auto-reconnect...`);
          const cdpClient = getCDPClient();
          try {
            let reconnectTid: ReturnType<typeof setTimeout>;
            await Promise.race([
              cdpClient.forceReconnect().finally(() => clearTimeout(reconnectTid)),
              new Promise<never>((_, reject) => {
                reconnectTid = setTimeout(() => reject(new Error(`Reconnect timed out after ${DEFAULT_RECONNECT_TIMEOUT_MS}ms`)), DEFAULT_RECONNECT_TIMEOUT_MS);
              }),
            ]);
            console.error(`[MCPServer] Reconnected, retrying ${toolName}...`);
            // Wait for session state reconciliation before retrying
            try {
              await this.sessionManager.reconcileAfterReconnect();
            } catch (reconcileErr) {
              console.error('[MCPServer] Post-reconnect reconciliation failed, aborting retry:', reconcileErr);
              throw handlerError; // Abort retry — stale state would cause wrong-target errors
            }
            let tid2: ReturnType<typeof setTimeout>;
            result = await Promise.race([
              Promise.resolve(tool.handler(sessionId, toolArgs)).finally(() => clearTimeout(tid2)),
              new Promise<never>((_, reject) => {
                tid2 = setTimeout(
                  () => reject(new Error(`Tool '${toolName}' timed out after ${DEFAULT_TOOL_EXECUTION_TIMEOUT_MS}ms (retry)`)),
                  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
                );
              }),
            ]);
          } catch (retryError) {
            throw handlerError; // throw ORIGINAL error
          }
        } else {
          throw handlerError;
        }
      } finally {
        // Always restore normal threshold after heavy tool completes (success or error)
        if (isHeavyTool && eventLoopMonitor) {
          eventLoopMonitor.endHeavyOperation();
        }
      }

      // Check if the handler returned a connection error as MCPResult instead of throwing.
      // Tools like tabs_create and navigate catch connection errors internally and return
      // isError results, bypassing the thrown-error retry at the catch block above.
      if (result.isError && result.content?.[0]?.type === 'text') {
        const errorText = (result.content[0] as { text: string }).text;
        if (isConnectionError({ message: errorText })) {
          console.error(`[MCPServer] Detected swallowed connection error in "${toolName}" result, attempting reconnect + retry`);
          try {
            const cdpClientRetry = getCDPClient();
            await cdpClientRetry.forceReconnect();
            // Retry the tool call once
            result = await Promise.resolve(tool.handler(sessionId, toolArgs));
            console.error(`[MCPServer] Retry after swallowed connection error succeeded for "${toolName}"`);
          } catch (retryError) {
            console.error(`[MCPServer] Retry after swallowed connection error failed for "${toolName}":`, retryError);
            // Keep original error result
          }
        }
      }

      // Audit log successful invocation
      logAuditEntry(toolName, sessionId, toolArgs);

      // End activity tracking (success)
      this.activityTracker!.endCall(callId, 'success');

      // Record Prometheus metrics
      try {
        const metrics = getMetricsCollector();
        const durationSec = (Date.now() - toolStartTime) / 1000;
        metrics.inc('openchrome_tool_calls_total', { tool: toolName, status: 'success' });
        metrics.observe('openchrome_tool_duration_seconds', { tool: toolName }, durationSec);
      } catch {
        // Best-effort metrics
      }

      // Record to task journal
      try {
        const journal = getTaskJournal();
        const entry = journal.createEntry(toolName, sessionId, toolArgs, Date.now() - toolStartTime, true);
        journal.record(entry);
      } catch {
        // Best-effort journal recording
      }

      // Transition from heavy back to active after tool completes
      try {
        const cdpClient = getCDPClient();
        if (cdpClient.setHeartbeatMode) {
          cdpClient.setHeartbeatMode('active');
        }
      } catch {
        // CDP client may not be initialized
      }

      // Schedule heartbeat idle mode transition
      if (this.heartbeatIdleTimer) {
        clearTimeout(this.heartbeatIdleTimer);
      }
      this.heartbeatIdleTimer = setTimeout(() => {
        try {
          const cdpClient = getCDPClient();
          if (cdpClient.setHeartbeatMode) {
            cdpClient.setHeartbeatMode('idle');
          }
        } catch {
          // CDP client may be disconnected
        }
        this.heartbeatIdleTimer = null;
      }, DEFAULT_HEARTBEAT_IDLE_TIMEOUT_MS);
      if (this.heartbeatIdleTimer.unref) {
        this.heartbeatIdleTimer.unref();
      }

      const compressionConfig = getGlobalConfig().compression;
      const verbosity = compressionConfig?.verbosity ?? 'normal';

      if (callId) {
        const timing = this.activityTracker!.getCall(callId);
        if (timing?.duration !== undefined) {
          if (verbosity === 'verbose') {
            (result as Record<string, unknown>)._timing = {
              durationMs: timing.duration,
              startTime: timing.startTime,
              endTime: timing.endTime,
            };
          } else if (verbosity === 'normal') {
            (result as Record<string, unknown>)._timing = {
              durationMs: timing.duration,
            };
          }
          // compact: skip _timing entirely
        }
      }

      // Inject session context for AI agent continuity (#347 Phase 4)
      if (verbosity !== 'compact' && !['oc_checkpoint', 'oc_connection_health'].includes(toolName)) {
        try {
          const cdpClient = getCDPClient();
          const metrics = cdpClient.getConnectionMetrics();
          const stats = this.sessionManager.getStats();
          (result as Record<string, unknown>)._sessionContext = {
            uptime: Math.round(process.uptime()),
            tabCount: stats.totalTargets,
            heartbeatMode: metrics.heartbeatMode,
            reconnectsSinceStart: metrics.reconnectCount,
            checkpointAvailable: true,
          };
        } catch {
          // Best-effort — don't fail tool calls for context injection
        }
      }

      // Inject profile state
      if (verbosity !== 'compact') {
        const profileInfo = this.buildProfileInfo();
        if (profileInfo) {
          (result as Record<string, unknown>)._profile = profileInfo.profile;
          if (profileInfo.warning) {
            const content = (result as Record<string, unknown>).content;
            if (Array.isArray(content)) {
              content.unshift({ type: 'text', text: profileInfo.warning });
            }
          }
        }
      }

      // Inject proactive hint into both _hint (backward compat) and content[] (guaranteed MCP delivery)
      if (this.hintEngine) {
        const hintResult = this.hintEngine.getHint(toolName, result as Record<string, unknown>, false, sessionId);
        if (hintResult) {
          const injectHint =
            verbosity !== 'compact' ||
            hintResult.severity === 'critical';
          if (injectHint) {
            (result as Record<string, unknown>)._hint = hintResult.hint;
            (result as Record<string, unknown>)._hintMeta = {
              severity: hintResult.severity,
              rule: hintResult.rule,
              fireCount: hintResult.fireCount,
              ...(hintResult.suggestion && { suggestion: hintResult.suggestion }),
              ...(hintResult.context && { context: hintResult.context }),
            };
            const content = (result as Record<string, unknown>).content;
            if (Array.isArray(content)) {
              // Hint appended after tool result (may follow image blobs for verify:true tools)
              content.push({ type: 'text', text: `\n${hintResult.hint}` });
            }
          }
        }
      }

      if (compressionConfig?.enabled && compressionConfig?.trackSavings) {
        (result as Record<string, unknown>)._compression = {
          level: compressionConfig.level ?? 'light',
          verbosity,
        };
      }

      return result;
    } catch (error) {
      const message = formatError(error);

      // End activity tracking (error)
      this.activityTracker!.endCall(callId, 'error', message);

      // Record Prometheus metrics
      try {
        const metrics = getMetricsCollector();
        const durationSec = (Date.now() - toolStartTime) / 1000;
        metrics.inc('openchrome_tool_calls_total', { tool: toolName, status: 'error' });
        metrics.observe('openchrome_tool_duration_seconds', { tool: toolName }, durationSec);
      } catch {
        // Best-effort metrics
      }

      // Record to task journal
      try {
        const journal = getTaskJournal();
        const entry = journal.createEntry(toolName, sessionId, toolArgs, Date.now() - toolStartTime, false);
        journal.record(entry);
      } catch {
        // Best-effort journal recording
      }

      // Transition from heavy back to active after tool completes
      try {
        const cdpClient = getCDPClient();
        if (cdpClient.setHeartbeatMode) {
          cdpClient.setHeartbeatMode('active');
        }
      } catch {
        // CDP client may not be initialized
      }

      // Schedule heartbeat idle mode transition
      if (this.heartbeatIdleTimer) {
        clearTimeout(this.heartbeatIdleTimer);
      }
      this.heartbeatIdleTimer = setTimeout(() => {
        try {
          const cdpClient = getCDPClient();
          if (cdpClient.setHeartbeatMode) {
            cdpClient.setHeartbeatMode('idle');
          }
        } catch {
          // CDP client may be disconnected
        }
        this.heartbeatIdleTimer = null;
      }, DEFAULT_HEARTBEAT_IDLE_TIMEOUT_MS);
      if (this.heartbeatIdleTimer.unref) {
        this.heartbeatIdleTimer.unref();
      }

      // Append reconnection guidance for connection errors
      const displayMessage = isConnectionError(error)
        ? message + RECONNECTION_GUIDANCE
        : message;

      // Timeout errors on tools with timeoutRecoverable=true return isError:false
      // so the LLM can continue with partial state (e.g., partially loaded DOM).
      // NOTE: navigate.ts now handles timeout coherence itself (checking readyState/elementCount
      // to decide success-with-warning vs genuine error). This fallback is kept for backward
      // compatibility with any other tools that set timeoutRecoverable=true.
      const errorIsError = !(isTimeoutError(error) && tool.timeoutRecoverable);

      const errResult: MCPResult = {
        content: [{ type: 'text', text: `Error: ${displayMessage}` }],
        isError: errorIsError,
      };

      if (callId) {
        const timing = this.activityTracker!.getCall(callId);
        if (timing?.duration !== undefined) {
          const verbosityErr = getGlobalConfig().compression?.verbosity ?? 'normal';
          if (verbosityErr === 'verbose') {
            (errResult as Record<string, unknown>)._timing = {
              durationMs: timing.duration,
              startTime: timing.startTime,
              endTime: timing.endTime,
            };
          } else if (verbosityErr === 'normal') {
            (errResult as Record<string, unknown>)._timing = {
              durationMs: timing.duration,
            };
          }
          // compact: skip _timing entirely
        }
      }

      // Inject profile state (no warning on error responses)
      const verbosityErr = getGlobalConfig().compression?.verbosity ?? 'normal';
      if (verbosityErr !== 'compact') {
        const profileInfoErr = this.buildProfileInfo();
        if (profileInfoErr) {
          (errResult as Record<string, unknown>)._profile = profileInfoErr.profile;
        }
      }

      // Inject proactive hint for errors into both _hint and content[]
      if (this.hintEngine) {
        const hintResult = this.hintEngine.getHint(toolName, errResult as Record<string, unknown>, true, sessionId);
        if (hintResult) {
          (errResult as Record<string, unknown>)._hint = hintResult.hint;
          (errResult as Record<string, unknown>)._hintMeta = {
            severity: hintResult.severity,
            rule: hintResult.rule,
            fireCount: hintResult.fireCount,
            ...(hintResult.suggestion && { suggestion: hintResult.suggestion }),
            ...(hintResult.context && { context: hintResult.context }),
          };
          if (Array.isArray(errResult.content)) {
            errResult.content.push({ type: 'text', text: `\n${hintResult.hint}` });
          }
        }
      }

      return errResult;
    }
  }

  /**
   * Handle sessions/list request
   */
  private async handleSessionsList(): Promise<MCPResult> {
    const sessions = this.sessionManager.getAllSessionInfos();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(sessions, null, 2),
        },
      ],
    };
  }

  /**
   * Handle sessions/create request
   */
  private async handleSessionsCreate(params?: Record<string, unknown>): Promise<MCPResult> {
    const sessionId = params?.sessionId as string | undefined;
    const name = params?.name as string | undefined;

    const session = await this.sessionManager.createSession({
      id: sessionId,
      name,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              sessionId: session.id,
              name: session.name,
              targetCount: session.targets.size,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle sessions/delete request
   */
  private async handleSessionsDelete(params?: Record<string, unknown>): Promise<MCPResult> {
    const sessionId = params?.sessionId as string;
    if (!sessionId) {
      throw new Error('Missing sessionId');
    }

    await this.sessionManager.deleteSession(sessionId);

    return {
      content: [
        {
          type: 'text',
          text: `Session ${sessionId} deleted`,
        },
      ],
    };
  }

  /**
   * Create an error response
   */
  private errorResponse(
    id: number | string,
    code: number,
    message: string,
    data?: unknown
  ): MCPResponse {
    const error: MCPError = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    return {
      jsonrpc: '2.0',
      id,
      error,
    };
  }

  /**
   * Get the session manager
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get a tool handler by name (for internal server-side plan execution).
   * Returns null if the tool is not registered.
   */
  getToolHandler(toolName: string): ToolHandler | null {
    const registry = this.tools.get(toolName);
    return registry ? registry.handler : null;
  }

  /**
   * Get the full tool manifest with metadata
   */
  getToolManifest(): ToolManifest {
    const tools: ToolEntry[] = [];
    for (const registry of this.tools.values()) {
      tools.push({
        name: registry.definition.name,
        description: registry.definition.description,
        inputSchema: registry.definition.inputSchema,
        category: this.inferToolCategory(registry.definition.name),
      });
    }
    return {
      version: `${this.manifestVersion}`,
      generatedAt: Date.now(),
      tools,
      toolCount: tools.length,
    };
  }

  /**
   * Increment the manifest version (call when tools are dynamically added/removed)
   */
  incrementManifestVersion(): void {
    this.manifestVersion++;
  }

  /**
   * Infer the category of a tool from its name
   */
  private inferToolCategory(toolName: string): ToolCategory {
    if (['navigate', 'page_reload'].includes(toolName)) return 'navigation';
    if (['computer', 'form_input', 'drag_drop'].includes(toolName)) return 'interaction';
    if (['read_page', 'find', 'page_content', 'query_dom'].includes(toolName)) return 'content';
    if (toolName === 'javascript_tool') return 'javascript';
    if (['network', 'cookies', 'storage', 'request_intercept', 'http_auth'].includes(toolName)) return 'network';
    if (['tabs_context', 'tabs_create', 'tabs_close'].includes(toolName)) return 'tabs';
    if (['page_pdf', 'console_capture', 'performance_metrics', 'file_upload'].includes(toolName)) return 'media';
    if (['user_agent', 'geolocation', 'emulate_device'].includes(toolName)) return 'emulation';
    if (['workflow_init', 'workflow_status', 'workflow_collect', 'workflow_collect_partial', 'workflow_cleanup', 'execute_plan'].includes(toolName)) return 'orchestration';
    if (['worker', 'worker_update', 'worker_complete'].includes(toolName)) return 'worker';
    if (['click_element', 'fill_form', 'wait_and_click', 'wait_for'].includes(toolName)) return 'composite';
    if (['batch_execute', 'lightweight_scroll'].includes(toolName)) return 'performance';
    if (toolName === 'memory') return 'content';
    if (toolName === 'oc_stop' || toolName === 'oc_profile_status') return 'lifecycle';
    return 'interaction';
  }

  /**
   * Build the _profile metadata object and optional one-time warning.
   * Returns null if profile state cannot be determined (e.g., launcher not initialized).
   */
  private buildProfileInfo(): {
    profile: Record<string, unknown>;
    warning: string | null;
  } | null {
    try {
      const launcher = getChromeLauncher();
      const state = launcher.getProfileState();

      const profile: Record<string, unknown> = {
        type: state.type,
        extensions: state.extensionsAvailable,
      };

      if (state.cookieCopiedAt) {
        profile.cookieAge = formatAge(state.cookieCopiedAt);
      }

      let warning: string | null = null;
      if (!this.profileWarningShown && state.type !== 'real' && state.type !== 'explicit') {
        const parts: string[] = [];
        if (state.type === 'persistent') {
          parts.push('⚠️ Browser running with persistent OpenChrome profile (real Chrome profile is locked).');
          parts.push(`Available: synced cookies${state.cookieCopiedAt ? ` (${formatAge(state.cookieCopiedAt)})` : ''} — authentication may work`);
          parts.push('Not available: extensions, saved passwords, bookmarks');
          parts.push('Tip: If authentication fails, the cookie sync may be stale. Ask the user to close Chrome.');
        } else {
          parts.push('⚠️ Browser running with fresh temporary profile (no user data).');
          parts.push('Not available: cookies, extensions, saved passwords, localStorage, bookmarks');
          parts.push('Tip: The user will need to log in manually to any sites that require authentication.');
        }
        warning = parts.join('\n');
        this.profileWarningShown = true;
      }

      return { profile, warning };
    } catch {
      // Launcher may not be initialized yet
      return null;
    }
  }

  /**
   * Stop the server and clean up all Chrome resources
   */
  async stop(): Promise<void> {
    // Reentrancy guard: if stop() is already in progress, return the existing promise.
    // This prevents double-cleanup when SIGTERM and stdin-close fire simultaneously.
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this._stopInternal();
    return this.stopPromise;
  }

  private async _stopInternal(): Promise<void> {
    // Stop dashboard
    if (this.dashboard) {
      this.dashboard.stop();
    }

    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }

    // Scale timeout based on number of Chrome pool instances.
    // Each launcher.close() needs up to 5s for SIGTERM->SIGKILL escalation,
    // plus time for session/CDP cleanup before that.
    let poolInstanceCount = 0;
    try {
      const pool = getChromePool();
      poolInstanceCount = pool.getInstances().size;
    } catch { /* pool may not be initialized */ }

    // Base 5s for session/CDP cleanup + 6s per Chrome instance (5s kill + 1s buffer)
    const timeoutMs = Math.max(5000, 5000 + poolInstanceCount * 6000);

    await Promise.race([
      this.cleanup(),
      new Promise<void>((resolve) => setTimeout(() => {
        console.error(`[MCPServer] Cleanup timed out after ${timeoutMs / 1000}s, forcing exit`);
        resolve();
      }, timeoutMs)),
    ]);
  }

  /**
   * Clean up all Chrome resources: sessions, connection pool, CDP, and Chrome process
   */
  private async cleanup(): Promise<void> {
    try {
      await this.sessionManager.cleanupAllSessions();
    } catch (e) {
      console.error('[MCPServer] Session cleanup error:', e);
    }

    try {
      const pool = getCDPConnectionPool();
      await pool.shutdown();
    } catch {
      // Pool may not have been initialized
    }

    try {
      const cdpClient = getCDPClient();
      if (cdpClient.isConnected()) {
        await cdpClient.disconnect();
      }
    } catch {
      // Client may not have been initialized
    }

    try {
      const launcher = getChromeLauncher();
      if (launcher.isConnected()) {
        await launcher.close();
        console.error('[MCPServer] Chrome process terminated');
      }
    } catch {
      // Launcher may not have been initialized
    }
  }

  /**
   * Check if dashboard is enabled
   */
  isDashboardEnabled(): boolean {
    return this.dashboard !== null && this.dashboard.running;
  }

  /**
   * Get the dashboard instance
   */
  getDashboard(): Dashboard | null {
    return this.dashboard;
  }
}

// Singleton instance
let mcpServerInstance: MCPServer | null = null;
let mcpServerOptions: MCPServerOptions = {};

export function setMCPServerOptions(options: MCPServerOptions): void {
  mcpServerOptions = options;
}

export function getMCPServer(): MCPServer {
  if (!mcpServerInstance) {
    mcpServerInstance = new MCPServer(undefined, mcpServerOptions);
  }
  return mcpServerInstance;
}
