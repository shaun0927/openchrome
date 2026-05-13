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
  ToolContext,
  ToolProgress,
  ToolRegistry,
  MCPErrorCodes,
} from './types/mcp';
import { MCPTransport, createTransport } from './transports/index';
import { SessionManager, getSessionManager } from './session-manager';
import { Dashboard, getDashboard, ActivityTracker, getActivityTracker, OperationController } from './dashboard/index.js';
import { usageGuideResource, getUsageGuideContent, MCPResourceDefinition } from './resources/usage-guide';
import {
  skillGraphResourceTemplate,
  SKILL_GRAPH_RESOURCE_PREFIX,
  parseDomainFromUri,
  readSkillGraphResource,
} from './resources/skill-graph';
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
import { createBudget, isLegacyBudgetMode } from './utils/budget';
import { SessionInitBudgetExhausted } from './cdp/errors';
import { getGlobalEventLoopMonitor } from './watchdog/event-loop-monitor';
import { getIdleState } from './utils/idle-state';
import { SessionRateLimiter } from './utils/rate-limiter';
import { getGlobalConfig } from './config/global';
import { getToolTier, ToolTier } from './config/tool-tiers';
import { getMetricsCollector, withTenantLabel } from './metrics/collector';
import { logAuditEntry } from './security/audit-logger';
import { isClientDisconnect } from './errors/abort';
import { setLogSender, type LogLevel, logLevelSetErrorOrNull } from './utils/log';
import { isAllowed, requiredScope } from './auth/scope-policy';
import type { Principal } from './auth/api-key-types';
import { PRINCIPAL_SYM } from './middleware/auth';
import { getVersion } from './version';
import { isTimeoutError } from './errors/timeout';
import { OpenChromeConnectionError } from './errors/connection';
import { getTaskJournal } from './journal/task-journal';
import { getDashboardState } from './desktop/dashboard-state';
import { getActionRecorder } from './recording/action-recorder';
import {
  substituteSecrets,
  redactSecrets,
  MissingSecretError,
  getSecretStore,
} from './core/secrets';
import { currentRequestContext } from './observability/request-id';
import type { TransportMessageContext } from './transports';
import { RecoveryTrajectoryLedger, scoreFromToolResult, summarizeResult, type RecoveryResultStatus } from './recovery';

/** Recording tools excluded from session recording to prevent infinite loops */
const SKIP_RECORDING_TOOLS = new Set([
  'oc_recording_start',
  'oc_recording_stop',
  'oc_recording_list',
  'oc_recording_export',
]);

/**
 * Detect if an error is a Chrome/CDP connection error that may be recoverable
 * by reconnecting to the browser.
 */
export function isConnectionError(error: unknown): boolean {
  if (error instanceof OpenChromeConnectionError) return true;
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
 *  sleep/wake). Skip session initialization so recovery handlers can always run. */
const SKIP_SESSION_INIT_TOOLS = new Set(['oc_stop', 'oc_reap_orphans', 'oc_profile_status', 'oc_session_snapshot', 'oc_session_resume', 'oc_journal']);

/** Tools that may legitimately block the event loop longer than the normal fatal threshold. */
const HEAVY_TOOLS = new Set(['computer', 'read_page', 'query_dom', 'cookies', 'javascript_tool']);

// State-stable tools called at high frequency — skip session/profile decorators
// to save ~50 tokens per call. These tools either don't mutate session/page
// state, or any mutation is implicit in the user's next call (so resumability
// metadata isn't load-bearing here). javascript_tool is intentionally excluded:
// it executes arbitrary JS and can mutate state in ways the agent needs the
// session/profile context to recover from.
const STATE_STABLE_HIGH_FREQ_TOOLS = new Set([
  'read_page',
  'query_dom',
  'find',
  'inspect',
  'wait_for',
  'page_content',
  'tabs_context',
]);

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

/**
 * Secrets substitution whitelist (#834).
 *
 * Single chokepoint for `${SECRET:NAME}` → real-value substitution. Each
 * entry below describes a tool argument path that legitimately needs the
 * raw secret value (typing it into the page, setting it as a cookie, etc.).
 * Every other argument is passed through unchanged so secrets never leak
 * into ad-hoc fields a tool might log or echo.
 *
 * Adding a site is intentionally hand-rolled (not config-driven): a new
 * whitelist entry must be justified against the P3 contract in review.
 */
function applySecretWhitelist(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // Short-circuit when --secrets is unset and no secrets are loaded. The
  // substituter still has to scan strings for unknown `${SECRET:NAME}`
  // tokens (MISSING_SECRET semantics survive even without a loaded store),
  // so we always at least probe.
  const store = getSecretStore();
  const out: Record<string, unknown> = { ...args };
  switch (toolName) {
    case 'form_input': {
      if (typeof out.value === 'string') {
        out.value = substituteSecrets(out.value as string, store);
      }
      break;
    }
    case 'fill_form': {
      const fields = out.fields;
      if (Array.isArray(fields)) {
        out.fields = fields.map((f) => {
          if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).value === 'string') {
            return {
              ...(f as Record<string, unknown>),
              value: substituteSecrets((f as Record<string, unknown>).value as string, store),
            };
          }
          return f;
        });
      }
      break;
    }
    case 'interact': {
      if (out.action === 'type' && typeof out.text === 'string') {
        out.text = substituteSecrets(out.text as string, store);
      }
      break;
    }
    case 'javascript_tool': {
      if (typeof out.expression === 'string') {
        out.expression = substituteSecrets(out.expression as string, store);
      }
      break;
    }
    case 'cookies': {
      // `cookies` is a multi-action tool; only the `set` action's value
      // payload is whitelisted.
      const action = out.action;
      if (action === 'set') {
        // Single cookie shape: { name, value, ... } at the top level.
        if (typeof out.value === 'string') {
          out.value = substituteSecrets(out.value as string, store);
        }
        // Batched cookies: { cookies: [{ name, value, ... }] }.
        const list = out.cookies;
        if (Array.isArray(list)) {
          out.cookies = list.map((c) => {
            if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).value === 'string') {
              return {
                ...(c as Record<string, unknown>),
                value: substituteSecrets((c as Record<string, unknown>).value as string, store),
              };
            }
            return c;
          });
        }
      }
      break;
    }
    case 'http_auth': {
      if (typeof out.password === 'string') {
        out.password = substituteSecrets(out.password as string, store);
      }
      break;
    }
    default:
      // Non-whitelisted tool: pass through unchanged. Secrets present in
      // those arguments would never reach the page anyway, but we also do
      // NOT scan them — that would surprise agents passing literal
      // `${SECRET:...}` strings into unrelated fields.
      break;
  }
  return out;
}

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
  private recoveryLedger: RecoveryTrajectoryLedger | null = null;
  private options: MCPServerOptions;
  private profileWarningShown = false;
  private exposedTier: ToolTier = 1;
  private clientSupportsListChanged = true;
  private clientDetected = false;
  private heartbeatIdleTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;
  private rateLimiter: SessionRateLimiter | null = null;
  /**
   * Per-session tenant binding for api-key mode. The first api-key principal
   * to touch a given sessionId "claims" the session; subsequent tools/call
   * requests that arrive with a different tenantId are rejected with a 403,
   * preventing a tenant with a valid API key from operating on a session
   * created by another tenant (cross-tenant session hijack via a guessed /
   * leaked sessionId). Cleared when the session is deleted (DELETE /mcp) via
   * the same hook that reclaims rate-limit buckets.
   *
   * Structural enforcement (binding at session-create time via TenantManager,
   * X-Tenant-Id header validation) lands in the tenant-propagation series
   * (B-1, PRs #30 / #31). This map is the minimum defense-in-depth so
   * PR 2/4 does not ship with a cross-tenant access path.
   */
  private sessionTenants: Map<string, string> = new Map();
  /**
   * Timer that periodically reclaims idle rate-limit buckets. Required because
   * tenant-keyed buckets (used in api-key mode) are shared across sessions, so
   * the per-session DELETE /mcp cleanup hook cannot be used to evict them —
   * without this sweep, the bucket map would grow unbounded with each new
   * tenant seen over process lifetime.
   */
  private rateLimiterSweepTimer: NodeJS.Timeout | null = null;

  /**
   * Pending server→client request resolvers, keyed by JSON-RPC id string
   * (#960). Populated by `requestFromClient`; drained by the response fork
   * at the top of `handleMessage` and by `rejectAllPendingS2cRequests` on
   * connection close.
   */
  private pendingClientRequests: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      signal?: AbortSignal;
      signalListener?: () => void;
      mcpSessionId?: string;
    }
  > = new Map();
  /** Monotonic counter — prefixed `oc-s2c-` cannot collide with client ids. */
  private nextS2cRequestId = 1;
  /**
   * Capabilities the client declared in `initialize` (#960). Downstream
   * features (roots #880, sampling #876, elicitation #877) check this cache
   * before issuing a server→client request and fall back when absent.
   */
  private clientCapabilities: { roots?: object; sampling?: object; elicitation?: object } = {};
  private clientCapabilitiesBySession: Map<string, { roots?: object; sampling?: object; elicitation?: object }> = new Map();

  constructor(sessionManager?: SessionManager, options: MCPServerOptions = {}) {
    this.sessionManager = sessionManager || getSessionManager();
    this.options = options;

    if (options.initialToolTier) {
      this.exposedTier = options.initialToolTier;
    }

    // Release the tenant binding as soon as the underlying session is
    // destroyed (tool-triggered cascade, cleanup-on-shutdown, etc.) rather
    // than waiting for the periodic sweep. This is the authoritative signal
    // — sessionTenants is always keyed by the same sessionId space that
    // sessionManager uses, unlike the transport's Mcp-Session-Id.
    if (typeof this.sessionManager.addEventListener === 'function') {
      this.sessionManager.addEventListener((event) => {
        if (event.type === 'session:deleted') {
          this.sessionTenants.delete(event.sessionId);
        }
      });
    }

    // Register built-in resources
    this.registerResource(usageGuideResource);
    this.registerResource(skillGraphResourceTemplate);

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

    // Initialize passive recovery trajectory ledger (#1017). Default-on with the
    // existing .openchrome harness logs; set OPENCHROME_RECOVERY_LEDGER=0 to disable.
    if (process.env.OPENCHROME_RECOVERY_LEDGER !== '0') {
      this.recoveryLedger = new RecoveryTrajectoryLedger({
        dirPath: path.join(process.cwd(), '.openchrome', 'recovery'),
      });
    }

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

    // Wire the structured-logging sender (#870). After this point, calls to
    // `log.info / log.warning / log.error / log.debug` from anywhere in the
    // codebase will emit `notifications/message` to connected clients (at or
    // above the active level) AND mirror error-level events to stderr.
    setLogSender((level: LogLevel, logger: string, data: Record<string, unknown>) => {
      this.sendNotification('notifications/message', { level, logger, data });
    });
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
   * Server→client request/response primitive (#960).
   *
   * Allocates a unique request id (prefixed `oc-s2c-` so it cannot collide
   * with client-allocated ids), serializes the request via the existing
   * `sendResponse` path, and registers a one-shot resolver. The transport
   * delivers the JSON-RPC envelope; the response is matched back to the
   * resolver in `handleMessage` (response fork) before the regular
   * client-request validation runs.
   *
   * Failure modes (rejection):
   *   - `timeoutMs` elapses → `Error('s2c_timeout:<method>')`.
   *   - `signal` fires → `Error('s2c_aborted')`.
   *   - Connection closes (`close()` / transport teardown) →
   *     `Error('s2c_aborted:connection_closed')`.
   *   - Client returns a JSON-RPC `error` → `Error(error.message)`.
   *
   * Concurrent in-flight requests are independent — no head-of-line blocking.
   */
  protected async requestFromClient<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const id = `oc-s2c-${this.nextS2cRequestId++}`;
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const mcpSessionId = currentRequestContext()?.mcpSessionId;
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        const entry = this.pendingClientRequests.get(id);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.signal && entry.signalListener) {
          entry.signal.removeEventListener('abort', entry.signalListener);
        }
        this.pendingClientRequests.delete(id);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`s2c_timeout:${method}`));
      }, timeoutMs);

      let signalListener: (() => void) | undefined;
      if (options?.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new Error('s2c_aborted'));
          return;
        }
        signalListener = (): void => {
          cleanup();
          reject(new Error('s2c_aborted'));
        };
        options.signal.addEventListener('abort', signalListener, { once: true });
      }

      this.pendingClientRequests.set(id, {
        resolve: (value: unknown) => {
          cleanup();
          resolve(value as T);
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
        timer,
        signal: options?.signal,
        signalListener,
        mcpSessionId,
      });

      const request = {
        jsonrpc: '2.0' as const,
        id,
        method,
        ...(params ? { params } : {}),
      };
      try {
        const transport = this.transport;
        if (mcpSessionId && transport && typeof transport.sendToSession === 'function') {
          const sent = transport.sendToSession(mcpSessionId, request as unknown as MCPResponse);
          if (!sent) {
            cleanup();
            reject(new Error('s2c_aborted:connection_closed'));
            return;
          }
        } else {
          this.sendResponse(request as unknown as MCPResponse);
        }
      } catch (sendErr) {
        cleanup();
        reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
      }
    });
  }

  /**
   * Reject every pending server→client request. Called when the transport
   * tears down (HTTP DELETE / stdio EOF) so callers don't hang forever.
   */
  private rejectAllPendingS2cRequests(reason: string): void {
    for (const [id, entry] of this.pendingClientRequests) {
      // Use entry.reject which also clears the timer / signal listener.
      try {
        entry.reject(new Error(reason));
      } catch {
        // best-effort
      }
      this.pendingClientRequests.delete(id);
    }
  }

  private rejectPendingS2cRequestsForSession(sessionId: string, reason: string): void {
    for (const [id, entry] of this.pendingClientRequests) {
      if (entry.mcpSessionId !== sessionId) continue;
      try {
        entry.reject(new Error(reason));
      } catch {
        // best-effort
      }
      this.pendingClientRequests.delete(id);
    }
  }

  /**
   * Build a coalescing progress-reporter for a single tools/call invocation.
   *
   * Returns `undefined` when the client did not supply `_meta.progressToken`,
   * giving downstream tools a cheap no-op semantic (`ctx.reportProgress?.(...)`).
   *
   * Coalescing window: 100 ms per progressToken. Updates within the window
   * are dropped except for the most recent one, which is delivered when the
   * window expires. The final update (highest progress) is always
   * delivered when `flush()` is called at the end of the tool call.
   *
   * Notification emission is best-effort — exceptions in the transport
   * layer are swallowed so a wedged SSE socket cannot break the parent
   * tool call. Monotonic non-decreasing `progress` is enforced (out-of-order
   * updates with lower progress are ignored).
   */
  private createProgressReporter(
    progressToken: string | number | null | undefined,
  ): { reporter?: (update: ToolProgress) => void; flush: () => void } {
    if (progressToken === undefined || progressToken === null) {
      return { reporter: undefined, flush: () => undefined };
    }
    const COALESCE_MS = 100;
    let lastEmittedAt = 0;
    let pending: ToolProgress | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let highestProgress = -Infinity;
    let closed = false;

    const send = (update: ToolProgress): void => {
      if (closed) return;
      try {
        this.sendNotification('notifications/progress', {
          progressToken,
          progress: update.progress,
          ...(update.total !== undefined ? { total: update.total } : {}),
          ...(update.message !== undefined ? { message: update.message } : {}),
        });
        lastEmittedAt = Date.now();
      } catch (err) {
        // Best-effort: a wedged transport must not break the parent tool call.
        console.error('[MCPServer] progress notification emit failed:', err);
      }
    };

    const reporter = (update: ToolProgress): void => {
      if (closed) return;
      // Enforce monotonic non-decreasing `progress`.
      if (update.progress < highestProgress) return;
      highestProgress = update.progress;
      const now = Date.now();
      const elapsed = now - lastEmittedAt;
      if (elapsed >= COALESCE_MS) {
        // Emit immediately and clear any pending coalesced update.
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
          pending = null;
        }
        send(update);
      } else {
        // Buffer; schedule a single trailing emission.
        pending = update;
        if (!pendingTimer) {
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            if (!closed && pending) {
              const p = pending;
              pending = null;
              send(p);
            }
          }, COALESCE_MS - elapsed);
        }
      }
    };

    const flush = (): void => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (pending) {
        const p = pending;
        pending = null;
        send(p);
      }
      closed = true;
    };

    return { reporter, flush };
  }

  /**
   * Wire rate-limiter session cleanup into the given transport so that
   * bucket memory is freed immediately when a client sends DELETE /mcp.
   *
   * Note: this only reclaims session-keyed buckets (legacy / disabled auth
   * modes and stdio callers). Tenant-keyed buckets used in api-key mode
   * are shared across sessions, so they cannot be evicted on a per-session
   * DELETE — those rely on the periodic `rateLimiterSweepTimer` scheduled
   * in start().
   */
  wireRateLimiterCleanup(transport: MCPTransport): void {
    const hasHook = typeof (transport as unknown as { onSessionDelete?: unknown }).onSessionDelete === 'function';
    if (!hasHook) return;
    (transport as unknown as { onSessionDelete: (cb: (id: string) => void) => void }).onSessionDelete(
      (sessionId: string) => {
        if (this.rateLimiter) {
          this.rateLimiter.removeSession(sessionId);
        }
        // Intentionally NOT clearing sessionTenants here: the transport
        // callback receives the HTTP `Mcp-Session-Id` (a UUID assigned at
        // initialize), whereas tenant claims are keyed by the tool-call
        // sessionId (client-supplied via params/toolArgs, defaulting to
        // 'default'). Those two spaces don't match, so deleting by this id
        // would usually be a no-op, and on an unlucky collision would drop
        // someone else's binding. sessionTenants is instead reclaimed by
        // (a) the MCP `sessions/delete` handler and (b) the periodic
        // `sweepSessionTenants()` tick scheduled in start().
        this.rejectPendingS2cRequestsForSession(sessionId, 's2c_aborted:connection_closed');
        this.clientCapabilitiesBySession.delete(sessionId);
      },
    );
  }

  /**
   * Remove `sessionTenants` entries whose underlying session no longer
   * exists in sessionManager. Called on the same interval as the
   * rate-limiter sweep so stale bindings don't accumulate when a tenant
   * abandons a session without calling `sessions/delete` explicitly.
   */
  private sweepSessionTenants(): number {
    if (this.sessionTenants.size === 0) return 0;
    let live: Set<string>;
    try {
      live = new Set(this.sessionManager.getAllSessionInfos().map((s) => s.id));
    } catch {
      return 0;
    }
    let removed = 0;
    for (const id of this.sessionTenants.keys()) {
      if (!live.has(id)) {
        this.sessionTenants.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Handle a raw parsed message: validate the JSON-RPC 2.0 envelope, log
   * notifications, and route requests through handleRequest().
   * This is the single source of truth for protocol-level validation used by
   * all transports (stdio and HTTP in dual mode).
   */
  async handleMessage(
    parsed: Record<string, unknown>,
    signal?: AbortSignal,
    transportContext?: TransportMessageContext,
  ): Promise<MCPResponse | null> {
    // Record activity — every inbound MCP request flows through this method
    // (stdio and HTTP transports both route here; see start()). By wiring at
    // the single dispatch point we guarantee acceptance criterion 8 (issue
    // #649) without having to touch every registerTool() call site.
    getIdleState().notifyActive();

    // #960 — Server→client response fork. If this message has an id and
    // (result | error) but no method, it is a response to a request the server
    // sent earlier via `requestFromClient`. Route it to the pending resolver
    // and short-circuit BEFORE the regular client-request validation (which
    // would otherwise reject the response as "missing method field").
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      parsed.jsonrpc === '2.0' &&
      parsed.id !== undefined &&
      parsed.id !== null &&
      typeof parsed.method !== 'string' &&
      ('result' in parsed || 'error' in parsed)
    ) {
      const idKey = String(parsed.id);
      const entry = this.pendingClientRequests.get(idKey);
      if (entry) {
        if (entry.mcpSessionId && transportContext?.mcpSessionId !== entry.mcpSessionId) {
          console.error(`[MCPServer] dropping client response for id=${idKey} from non-owner session`);
          return null;
        }
        if ('error' in parsed) {
          const err = parsed.error as { message?: string; code?: number };
          entry.reject(new Error(err?.message ?? `s2c_error_code:${err?.code ?? 'unknown'}`));
        } else {
          entry.resolve(parsed.result);
        }
      } else {
        // Stray response (e.g. client echoed a stale id) — log and drop.
        console.error(`[MCPServer] dropping stray client response for id=${idKey}`);
      }
      return null;
    }

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

    // Read the transport-injected principal via the non-forgeable Symbol key
    // (see PRINCIPAL_SYM in src/middleware/auth.ts). JSON.parse cannot produce
    // symbol-keyed properties, so anything under PRINCIPAL_SYM was placed here
    // by the transport after authenticating the request — clients cannot
    // spoof a principal by including `"__principal": {...}` in their JSON body.
    const principal = (parsed as Record<PropertyKey, unknown>)[PRINCIPAL_SYM] as
      | Principal
      | undefined;
    // Scrub any string-named `__principal` that a malicious caller may have
    // embedded in the JSON. We don't read it, but deleting here prevents it
    // from echoing back out via JSON.stringify in later response paths.
    if ('__principal' in parsed) {
      delete (parsed as Record<string, unknown>).__principal;
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
      return await this.handleRequest(request, principal, signal);
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

    // Wire rate-limiter session cleanup into the transport
    this.wireRateLimiterCleanup(this.transport);

    // Schedule periodic sweep of idle rate-limit buckets. Per-session cleanup
    // (via DELETE /mcp) cannot reclaim tenant-keyed buckets (shared across
    // sessions in api-key mode), and also does not run for stdio callers, so
    // without this sweep the bucket map would grow without bound. Defaults
    // (sweep every 5 min, evict buckets idle > 15 min) are overridable via
    // env for operators with unusual tenant cardinality.
    if (this.rateLimiter) {
      const sweepIntervalMs =
        parseInt(process.env.OPENCHROME_RATE_LIMIT_SWEEP_INTERVAL_MS || '', 10) || 5 * 60_000;
      const maxIdleMs =
        parseInt(process.env.OPENCHROME_RATE_LIMIT_IDLE_MS || '', 10) || 15 * 60_000;
      this.rateLimiterSweepTimer = setInterval(() => {
        try {
          const removed = this.rateLimiter!.sweep(maxIdleMs);
          if (removed > 0) {
            console.error(`[MCPServer] Rate-limiter sweep: reclaimed ${removed} idle bucket(s)`);
          }
        } catch (err) {
          console.error('[MCPServer] Rate-limiter sweep failed:', err);
        }
        // Piggyback: reclaim tenant-session bindings whose session no
        // longer exists. Cheap (a single set-diff) and closes the gap
        // that the transport onSessionDelete hook cannot cover — tool
        // sessionIds are a separate namespace from the transport's
        // Mcp-Session-Id UUIDs.
        try {
          const released = this.sweepSessionTenants();
          if (released > 0) {
            console.error(`[MCPServer] Tenant-binding sweep: released ${released} stale binding(s)`);
          }
        } catch (err) {
          console.error('[MCPServer] Tenant-binding sweep failed:', err);
        }
      }, sweepIntervalMs);
      this.rateLimiterSweepTimer.unref();
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
    this.transport.onMessage(async (parsed: Record<string, unknown>, signal?: AbortSignal, context?: TransportMessageContext) =>
      this.handleMessage(parsed, signal, context),
    );

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
  async handleRequest(
    request: MCPRequest,
    principal?: Principal,
    signal?: AbortSignal,
  ): Promise<MCPResponse> {
    const { id, method, params } = request;

    try {
      let result: MCPResult;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params);
          break;

        case 'tools/list':
          result = await this.handleToolsList(params);
          break;

        case 'tools/call':
          result = await this.handleToolsCall(params, id, principal, signal);
          break;

        case 'resources/list':
          result = await this.handleResourcesList();
          break;

        case 'resources/read':
          result = await this.handleResourcesRead(params);
          break;

        case 'sessions/list':
          result = await this.handleSessionsList(principal);
          break;

        case 'sessions/create':
          result = await this.handleSessionsCreate(params, principal);
          break;

        case 'sessions/delete':
          result = await this.handleSessionsDelete(params, principal);
          break;

        case 'logging/setLevel':
          // #870 — accept the client's level threshold for notifications/message.
          // Process-wide today; per-session level is a follow-up (acceptable for
          // stdio's one-client-per-process model).
          {
            const level = (params as { level?: unknown } | undefined)?.level;
            const err = logLevelSetErrorOrNull(level);
            if (err) {
              return this.errorResponse(id, err.code, err.message);
            }
            result = {};
          }
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
    // #960 — capture client capabilities for downstream consumers (roots,
    // sampling, elicitation). Downstream issues check
    // `this.clientCapabilities.<feature>` before issuing the server→client
    // request and fall back to a heuristic / error path when absent.
    const caps = params?.capabilities as { roots?: object; sampling?: object; elicitation?: object } | undefined;
    if (caps && typeof caps === 'object') {
      const captured = {
        ...(caps.roots !== undefined ? { roots: caps.roots } : {}),
        ...(caps.sampling !== undefined ? { sampling: caps.sampling } : {}),
        ...(caps.elicitation !== undefined ? { elicitation: caps.elicitation } : {}),
      };
      this.clientCapabilities = captured;
      const mcpSessionId = currentRequestContext()?.mcpSessionId;
      if (mcpSessionId) {
        this.clientCapabilitiesBySession.set(mcpSessionId, captured);
      }
    }

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
        // #870 — advertise structured-logging support. Empty object per MCP
        // spec means "supported, no sub-capabilities yet". Clients drive the
        // level via `logging/setLevel`; events flow as
        // `notifications/message`.
        logging: {},
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
  private async handleToolsList(params?: Record<string, unknown>): Promise<MCPResult> {
    // Signal the hint engine that this session has consumed tool descriptions,
    // so rules whose guidance is already embedded in description "When to
    // use / When NOT to use" blocks can suppress themselves without affecting
    // other browser sessions that have not requested tools/list yet.
    const sessionId = (params?.sessionId || 'default') as string;
    if (this.hintEngine) {
      this.hintEngine.markToolsListServed(sessionId);
    }

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

    // Skill-graph resources use a URI prefix with a variable domain segment.
    // Handle them before the exact-match lookup.
    if (uri.startsWith(SKILL_GRAPH_RESOURCE_PREFIX)) {
      const domain = parseDomainFromUri(uri);
      if (!domain) {
        throw new Error(`Invalid skill-graph resource URI: ${uri}`);
      }
      const content = readSkillGraphResource(domain);
      return {
        contents: [
          {
            uri,
            mimeType: skillGraphResourceTemplate.mimeType,
            text: content,
          },
        ],
      };
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
  private async handleToolsCall(
    params?: Record<string, unknown>,
    requestId?: number | string,
    principal?: Principal,
    signal?: AbortSignal,
  ): Promise<MCPResult> {
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

    // Session-tenant binding (api-key mode only): reject if the session was
    // already claimed by a different tenant. First api-key caller to COMPLETE
    // an authorized + validated call wins — the claim itself is deferred
    // until after scope / tool / args checks pass, so a denied or invalid
    // request cannot lock a sessionId and block other tenants.
    // Other auth modes (disabled/legacy) and stdio callers are not subject
    // to this check. Structural session-create binding lands in B-1
    // (#30/#31); this is the PR-2-scope defense-in-depth.
    if (principal && principal.mode === 'api-key') {
      const claimedBy = this.sessionTenants.get(sessionId);
      if (claimedBy !== undefined && claimedBy !== principal.tenantId) {
        console.error(
          `[MCPServer] tenant binding violation: session=${sessionId} claimedBy=${claimedBy} requestedBy=${principal.tenantId} tool=${toolName}`,
        );
        try {
          logAuditEntry(toolName, sessionId, toolArgs, undefined, {
            keyId: principal.keyId,
            tenantId: principal.tenantId,
            scopes: principal.scopes,
          });
        } catch {
          // best-effort
        }
        return {
          content: [
            {
              type: 'text',
              text: `Forbidden: session '${sessionId}' is owned by another tenant.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Scope gate: if a principal was provided by the transport, check it can
    // call this tool. Absent principal (e.g. stdio) is treated as full access
    // so there is no regression for non-HTTP users.
    if (principal && !isAllowed(toolName, principal.scopes)) {
      const needed = requiredScope(toolName);
      console.error(
        `[MCPServer] scope denied: tool=${toolName} tenant=${principal.tenantId} required=${needed} granted=${principal.scopes.join(',')}`,
      );
      try {
        logAuditEntry(
          toolName,
          sessionId,
          toolArgs,
          undefined,
          {
            keyId: principal.keyId,
            tenantId: principal.tenantId,
            scopes: principal.scopes,
          },
        );
      } catch {
        // best-effort
      }
      return {
        content: [
          {
            type: 'text',
            text: `Forbidden: tool '${toolName}' requires scope '${needed}'.`,
          },
        ],
        isError: true,
      };
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

    // Validate required arguments before session init (avoids Chrome launch on bad input)
    const requiredFields = (tool.definition.inputSchema as { required?: string[] }).required;
    if (requiredFields && requiredFields.length > 0) {
      const missing = requiredFields.filter((field) => !(field in toolArgs) || toolArgs[field] === undefined || toolArgs[field] === null);
      if (missing.length > 0) {
        return {
          content: [{ type: 'text', text: `Error: Missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        };
      }
    }

    // ─── Secrets substitution (#834) ──────────────────────────────────────
    // Replace `${SECRET:NAME}` tokens with real values at the whitelisted
    // argument paths only. The handler receives the literal secret value
    // for typing/network use, but the response/trace/skill record layers
    // re-redact it on the way out so secrets never reach LLM-visible
    // artifacts. A missing secret raises MissingSecretError → structured
    // MCP error result.
    let substitutedArgs: Record<string, unknown>;
    try {
      substitutedArgs = applySecretWhitelist(toolName, toolArgs);
    } catch (err) {
      if (err instanceof MissingSecretError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'MISSING_SECRET',
                code: 'MISSING_SECRET',
                name: err.secretName,
                message: `Secret "${err.secretName}" is referenced via \${SECRET:${err.secretName}} but was not loaded. Pass --secrets <path> at server startup.`,
              }),
            },
          ],
          isError: true,
        };
      }
      throw err;
    }

    // All static gates passed (scope, tool existence, required args). Only
    // now do we claim the session for the caller's tenant — a denied or
    // invalid call must NOT be able to lock a sessionId that would then
    // block other tenants. (Codex round-6 P1.)
    if (
      principal &&
      principal.mode === 'api-key' &&
      !this.sessionTenants.has(sessionId)
    ) {
      this.sessionTenants.set(sessionId, principal.tenantId);
    }

    // Auto-expand tier if a higher-tier tool is called directly
    // This handles the case where the AI learned about the tool from documentation
    const toolTier = getToolTier(toolName);
    if (toolTier > this.exposedTier) {
      this.expandToolTier(toolTier);
    }

    // Rate limit check — reject before doing any work.
    // Only switch to tenant-scoped keying in real api-key mode; disabled and
    // legacy modes synthesize a fixed principal ('anonymous' / 'legacy'), so
    // keying by their tenantId would collapse every HTTP session into one
    // bucket and let one noisy client throttle unrelated sessions. Fall back
    // to per-session keying for stdio callers (no principal) and for the
    // synthetic disabled/legacy principals.
    if (this.rateLimiter) {
      const rateLimitKey =
        principal && principal.mode === 'api-key'
          ? SessionRateLimiter.tenantKey(principal.tenantId)
          : sessionId;
      const rateResult = this.rateLimiter.check(rateLimitKey);
      if (!rateResult.allowed) {
        console.error(`[MCPServer] Rate limit exceeded for session ${sessionId}, retry after ${rateResult.retryAfterSec}s`);
        try { getMetricsCollector().inc('openchrome_rate_limit_rejections_total', withTenantLabel({ tool: toolName })); } catch { /* best-effort */ }
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
        try { getMetricsCollector().inc('openchrome_tool_calls_total', withTenantLabel({ tool: toolName, status: 'reconnecting_wait' })); } catch { /* best-effort */ }
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
    getDashboardState().recordToolStart(sessionId || 'default', toolName, toolArgs, callId);
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

        // A-3: Time-based budget propagation. In legacy mode, fall back to the
        // old Promise.race-with-setTimeout pattern so ops can revert instantly
        // via OPENCHROME_SESSION_INIT_BUDGET_MODE=legacy.
        if (isLegacyBudgetMode()) {
          let sessionInitTid: ReturnType<typeof setTimeout>;
          await Promise.race([
            this.sessionManager.getOrCreateSession(sessionId).finally(() => clearTimeout(sessionInitTid)),
            new Promise<never>((_, reject) => {
              sessionInitTid = setTimeout(() => reject(new Error(`Session initialization timed out after ${sessionInitTimeout}ms`)), sessionInitTimeout);
            }),
          ]);
        } else {
          const budget = createBudget(sessionInitTimeout, 'session-init');
          let sessionInitTid: ReturnType<typeof setTimeout>;
          try {
            await Promise.race([
              this.sessionManager.getOrCreateSession(sessionId, budget).finally(() => clearTimeout(sessionInitTid)),
              // Outer safety net — budget-aware code should always win this race,
              // but add a small slack (+2s) in case an un-budgeted code path hangs.
              new Promise<never>((_, reject) => {
                sessionInitTid = setTimeout(
                  () => reject(new Error(`Session initialization timed out after ${sessionInitTimeout + 2000}ms (budget outer safety)`)),
                  sessionInitTimeout + 2000,
                );
              }),
            ]);
          } catch (err) {
            if (err instanceof SessionInitBudgetExhausted) {
              try {
                getMetricsCollector().inc(
                  'openchrome_session_init_budget_exhausted_total',
                  { stage: err.stage },
                );
              } catch { /* best-effort */ }
              console.error(
                `[MCPServer] Session init budget exhausted: stage=${err.stage} elapsed=${err.elapsedMs}ms total=${err.totalMs}ms`,
              );
            }
            throw err;
          }
        }
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

      // MCP progress-notifications wiring (#869). When the client passed
      // `_meta.progressToken` on tools/call, build a per-call coalescing
      // reporter and thread it through every ToolContext invocation site
      // (initial, post-reconnect retry, swallowed-error retry). flushProgress
      // runs in the outer finally so a trailing coalesced update is always
      // delivered before tools/call returns.
      const progressToken = (
        params as { _meta?: { progressToken?: string | number | null } } | undefined
      )?._meta?.progressToken ?? undefined;
      const { reporter: reportProgress, flush: flushProgress } =
        this.createProgressReporter(progressToken);

      let result: MCPResult;
      try {
        const toolContext: ToolContext = {
          startTime: Date.now(),
          deadlineMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
          signal,
          reportProgress,
        };
        let tid: ReturnType<typeof setTimeout>;
        result = await Promise.race([
          Promise.resolve(tool.handler(sessionId, substitutedArgs, toolContext)).finally(() => clearTimeout(tid)),
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
            const retryToolContext: ToolContext = {
              startTime: Date.now(),
              deadlineMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
              signal,
              reportProgress,
            };
            let tid2: ReturnType<typeof setTimeout>;
            result = await Promise.race([
              Promise.resolve(tool.handler(sessionId, substitutedArgs, retryToolContext)).finally(() => clearTimeout(tid2)),
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
        // Deliver any trailing coalesced progress update (#869). Safe to call
        // when no progressToken was supplied — flush is a no-op then.
        flushProgress();
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
            const swallowedRetryContext: ToolContext = {
              startTime: Date.now(),
              deadlineMs: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
              signal,
              reportProgress,
            };
            result = await Promise.resolve(tool.handler(sessionId, substitutedArgs, swallowedRetryContext));
            console.error(`[MCPServer] Retry after swallowed connection error succeeded for "${toolName}"`);
          } catch (retryError) {
            console.error(`[MCPServer] Retry after swallowed connection error failed for "${toolName}":`, retryError);
            // Keep original error result
          }
        }
      }

      // Audit log successful invocation — correlation/timing fields come from
      // the active RequestContext + explicit meta, while auth context is added
      // when this request was authenticated.
      logAuditEntry(toolName, sessionId, toolArgs, undefined, {
        keyId: principal?.keyId,
        tenantId: principal?.tenantId,
        scopes: principal?.scopes,
        status: 'success',
        durationMs: Date.now() - toolStartTime,
      });

      // End activity tracking (success)
      this.activityTracker!.endCall(callId, 'success');
      this.recordRecoveryTrajectory(callId, toolName, sessionId, toolArgs, result.isError ? 'no_progress' : 'success', result);
      getDashboardState().recordToolEnd(callId, 'success');

      // Record Prometheus metrics
      try {
        const metrics = getMetricsCollector();
        const durationSec = (Date.now() - toolStartTime) / 1000;
        metrics.inc('openchrome_tool_calls_total', withTenantLabel({ tool: toolName, status: 'success' }));
        metrics.observe('openchrome_tool_duration_seconds', withTenantLabel({ tool: toolName }), durationSec);
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

      // Record to session recording (best-effort, skip recording tools themselves)
      try {
        const recorder = getActionRecorder();
        if (recorder.isRecording && !SKIP_RECORDING_TOOLS.has(toolName)) {
          const tabId = toolArgs['tabId'] as string | undefined;
          const summary = (result as Record<string, unknown>)?._summary as string | undefined;
          recorder.recordAction(toolName, toolArgs, Date.now() - toolStartTime, true, { tabId, summary }).catch(() => {});
        }
      } catch {
        // Best-effort recording
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
      if (verbosity !== 'compact' && !['oc_checkpoint', 'oc_connection_health'].includes(toolName) && !STATE_STABLE_HIGH_FREQ_TOOLS.has(toolName)) {
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
      if (verbosity !== 'compact' && !STATE_STABLE_HIGH_FREQ_TOOLS.has(toolName)) {
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

      // Inject proactive hint into _hint, _hintMeta, and content[].
      // _hint / _hintMeta are non-standard fields that not all MCP clients
      // surface, so pushing into content[] guarantees the hint reaches the
      // user. Mirrors the error-path injection below for consistency.
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

      // ─── Secrets redaction (#834) ─────────────────────────────────────
      // Last line of defense before the MCP envelope: replace any literal
      // secret value still present in the response (handler may have echoed
      // the substituted input, returned it inside a JSON blob, or surfaced
      // it via an error message) with `${SECRET:NAME}` placeholders. No-op
      // when --secrets was not passed.
      return redactSecrets(result);
    } catch (error) {
      const message = formatError(error);
      const abortReason = isClientDisconnect(error) ? 'client_disconnect' : null;
      const aborted = abortReason !== null;

      // End activity tracking (error)
      this.activityTracker!.endCall(callId, aborted ? 'aborted' : 'error', message);
      this.recordRecoveryTrajectory(callId, toolName, sessionId, toolArgs, aborted ? 'aborted' : 'error', undefined, message);
      getDashboardState().recordToolEnd(callId, aborted ? 'aborted' : 'error', message);

      // Audit log failed invocation — same correlation fields as success path.
      try {
        logAuditEntry(toolName, sessionId, toolArgs, undefined, {
          status: aborted ? 'aborted' : 'error',
          durationMs: Date.now() - toolStartTime,
          aborted,
          abortedAt: aborted ? new Date().toISOString() : undefined,
          abortReason: abortReason ?? undefined,
          errorMessage: message,
          billable: false,
        });
      } catch {
        // best-effort audit
      }

      // Record Prometheus metrics
      try {
        const metrics = getMetricsCollector();
        const durationSec = (Date.now() - toolStartTime) / 1000;
        metrics.inc('openchrome_tool_calls_total', withTenantLabel({ tool: toolName, status: aborted ? 'aborted' : 'error' }));
        if (aborted && abortReason) {
          metrics.inc('openchrome_tool_calls_aborted_total', withTenantLabel({ tool: toolName, reason: abortReason }));
        }
        metrics.observe('openchrome_tool_duration_seconds', withTenantLabel({ tool: toolName }), durationSec);
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

      // Record to session recording (best-effort, skip recording tools themselves)
      try {
        const recorder = getActionRecorder();
        if (recorder.isRecording && !SKIP_RECORDING_TOOLS.has(toolName)) {
          const tabId = toolArgs['tabId'] as string | undefined;
          const errMsg = message;
          recorder.recordAction(toolName, toolArgs, Date.now() - toolStartTime, false, { tabId, error: errMsg }).catch(() => {});
        }
      } catch {
        // Best-effort recording
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

      // Secrets redaction (#834) — see success path. Error messages can
      // include the literal value (e.g. "type ... failed for value X").
      return redactSecrets(errResult);
    }
  }

  /**
   * Scope implication check (admin > write > read) without using a tool id.
   * Used by session-management methods that are not registered tools.
   */
  private hasScope(principal: Principal, needed: 'read' | 'write' | 'admin'): boolean {
    if (principal.scopes.includes('admin')) return true;
    if (needed === 'admin') return false;
    if (principal.scopes.includes('write')) return true;
    if (needed === 'write') return false;
    return principal.scopes.includes('read');
  }

  /**
   * Return an MCP "Forbidden" error result; also emits an audit entry so
   * the rejection is observable in the existing audit stream.
   */
  private forbiddenResult(
    method: string,
    sessionId: string,
    principal: Principal,
    text: string,
  ): MCPResult {
    try {
      logAuditEntry(method, sessionId, {}, undefined, {
        keyId: principal.keyId,
        tenantId: principal.tenantId,
        scopes: principal.scopes,
      });
    } catch {
      // best-effort
    }
    return {
      content: [{ type: 'text', text: `Forbidden: ${text}` }],
      isError: true,
    };
  }

  /**
   * Handle sessions/list request. In api-key mode the result is filtered to
   * sessions claimed by the caller's tenant (see sessionTenants); other auth
   * modes and stdio callers see all sessions (no regression).
   */
  private async handleSessionsList(principal?: Principal): Promise<MCPResult> {
    if (principal && !this.hasScope(principal, 'read')) {
      return this.forbiddenResult('sessions/list', 'n/a', principal, `scope 'read' required`);
    }
    const all = this.sessionManager.getAllSessionInfos();
    const visible = principal && principal.mode === 'api-key'
      ? all.filter((s) => this.sessionTenants.get(s.id) === principal.tenantId)
      : all;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(visible, null, 2),
        },
      ],
    };
  }

  /**
   * Handle sessions/create request. Requires 'write' scope for authenticated
   * callers. In api-key mode, a requested sessionId that is already claimed
   * by a different tenant is rejected; on success the new session is bound
   * to the caller's tenantId in sessionTenants.
   */
  private async handleSessionsCreate(
    params?: Record<string, unknown>,
    principal?: Principal,
  ): Promise<MCPResult> {
    const sessionId = params?.sessionId as string | undefined;
    const name = params?.name as string | undefined;

    if (principal && !this.hasScope(principal, 'write')) {
      return this.forbiddenResult(
        'sessions/create',
        sessionId ?? 'n/a',
        principal,
        `scope 'write' required`,
      );
    }
    if (principal && principal.mode === 'api-key' && sessionId) {
      const owner = this.sessionTenants.get(sessionId);
      if (owner !== undefined && owner !== principal.tenantId) {
        return this.forbiddenResult(
          'sessions/create',
          sessionId,
          principal,
          `session '${sessionId}' is owned by another tenant`,
        );
      }
    }

    const session = await this.sessionManager.createSession({
      id: sessionId,
      name,
    });

    if (principal && principal.mode === 'api-key') {
      this.sessionTenants.set(session.id, principal.tenantId);
    }

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
   * Handle sessions/delete request. Requires 'write' scope and, in api-key
   * mode, matching tenant ownership of the session. On successful delete
   * the session-tenant binding is released so a later caller (possibly a
   * different tenant) can claim the same sessionId — this is the MCP-method
   * twin of the transport-level onSessionDelete hook wired in
   * wireRateLimiterCleanup(), closing the cleanup gap that otherwise
   * leaves stale bindings behind and produces spurious "owned by another
   * tenant" rejections after logical deletion.
   */
  private async handleSessionsDelete(
    params?: Record<string, unknown>,
    principal?: Principal,
  ): Promise<MCPResult> {
    const sessionId = params?.sessionId as string;
    if (!sessionId) {
      throw new Error('Missing sessionId');
    }

    if (principal && !this.hasScope(principal, 'write')) {
      return this.forbiddenResult(
        'sessions/delete',
        sessionId,
        principal,
        `scope 'write' required`,
      );
    }
    if (principal && principal.mode === 'api-key') {
      const owner = this.sessionTenants.get(sessionId);
      if (owner !== undefined && owner !== principal.tenantId) {
        return this.forbiddenResult(
          'sessions/delete',
          sessionId,
          principal,
          `session '${sessionId}' is owned by another tenant`,
        );
      }
    }

    await this.sessionManager.deleteSession(sessionId);
    // Release the binding so sessionId (notably 'default') can be reclaimed
    // by a subsequent tenant after MCP-level deletion.
    this.sessionTenants.delete(sessionId);

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

  private recordRecoveryTrajectory(
    callId: string,
    toolName: string,
    sessionId: string,
    toolArgs: Record<string, unknown>,
    resultStatus: RecoveryResultStatus,
    result?: MCPResult,
    error?: string,
  ): void {
    if (!this.recoveryLedger || !this.activityTracker) return;

    try {
      const recent = this.activityTracker.getRecentCalls(3, sessionId);
      const current = recent.find((call) => call.id === callId);
      const tabId = typeof toolArgs.tabId === 'string' ? toolArgs.tabId : undefined;
      const previousTrajectory = this.recoveryLedger.getLastNode(sessionId, tabId);
      const previousFailed =
        previousTrajectory?.resultStatus === 'error' ||
        previousTrajectory?.resultStatus === 'no_progress' ||
        previousTrajectory?.resultStatus === 'aborted';
      const recovered =
        resultStatus === 'success' &&
        previousTrajectory !== undefined &&
        previousFailed &&
        previousTrajectory.toolName !== toolName;
      const progressStatus =
        resultStatus === 'error' || resultStatus === 'no_progress' || current?.result === 'error'
          ? 'stuck'
          : 'unknown';
      const priorNoProgressCount =
        resultStatus === 'no_progress' &&
        previousTrajectory?.toolName === toolName &&
        previousTrajectory?.resultStatus === 'no_progress'
          ? 1
          : 0;
      const score = scoreFromToolResult({
        toolName,
        isError: resultStatus === 'error' || resultStatus === 'aborted' || result?.isError === true,
        resultText: summarizeResult(result),
        errorText: error,
        repeatedFailureCount: previousTrajectory?.resultStatus === 'error' ? 1 : 0,
        repeatedNoProgressCount: priorNoProgressCount,
        ...this.recoveryProgressEvidence(toolName, resultStatus, result),
      });

      this.recoveryLedger.record({
        sessionId,
        tabId,
        toolName,
        args: toolArgs,
        resultStatus: recovered ? 'recovered' : resultStatus,
        progressStatus,
        error,
        result,
        recoveryTool: recovered ? toolName : undefined,
        reward: score.score,
      });
    } catch {
      // Recovery telemetry is best-effort and must not affect tool behavior.
    }
  }

  private recoveryProgressEvidence(
    toolName: string,
    resultStatus: RecoveryResultStatus,
    result?: MCPResult,
  ): {
    urlChanged?: boolean;
    domChanged?: boolean;
    networkChanged?: boolean;
    dataItemsExtracted?: number;
    freshRefsDiscovered?: boolean;
    observationOnly?: boolean;
  } {
    if (resultStatus !== 'success' && resultStatus !== 'recovered') return {};
    const resultText = summarizeResult(result) ?? '';
    const hasRef = /\bref[_-]?[A-Za-z0-9]+|\[ref[^\]]+\]/.test(resultText);
    if (toolName === 'navigate' || toolName === 'tabs_create' || toolName === 'page_reload') {
      return { urlChanged: true, observationOnly: false };
    }
    if (toolName === 'act' || toolName === 'interact' || toolName === 'form_input' || toolName === 'fill_form') {
      return { domChanged: true, freshRefsDiscovered: hasRef, observationOnly: false };
    }
    if (toolName === 'extract_data') {
      const content = result?.content;
      return { dataItemsExtracted: Array.isArray(content) && content.length > 0 ? content.length : 1, observationOnly: false };
    }
    if (toolName === 'request_intercept' || toolName === 'network_capture') {
      return { networkChanged: true, observationOnly: false };
    }
    return { freshRefsDiscovered: hasRef };
  }

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
    if (['fill_form', 'wait_for'].includes(toolName)) return 'composite';
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
    // #960 — reject every in-flight server→client request before the
    // transport tears down so callers don't hang forever on Promises that
    // can never resolve.
    this.rejectAllPendingS2cRequests('s2c_aborted:connection_closed');

    // Stop dashboard
    if (this.dashboard) {
      this.dashboard.stop();
    }

    // Cancel the rate-limiter sweep timer (if running) so the process can
    // exit cleanly and tests don't leak timers across runs.
    if (this.rateLimiterSweepTimer) {
      clearInterval(this.rateLimiterSweepTimer);
      this.rateLimiterSweepTimer = null;
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

    let cleanupTimeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      this.cleanup(),
      new Promise<void>((resolve) => {
        cleanupTimeout = setTimeout(() => {
        console.error(`[MCPServer] Cleanup timed out after ${timeoutMs / 1000}s, forcing exit`);
        resolve();
        }, timeoutMs);
        cleanupTimeout.unref?.();
      }),
    ]);
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
    }
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

/** Reset the MCP server singleton — for testing and programmatic server lifecycle only. */
export function _resetMCPServerForTesting(): void {
  mcpServerInstance = null;
  mcpServerOptions = {};
}
