/**
 * Programmatic API for openchrome — steel-browser adoption A2 (#859).
 *
 * `createOpenChromeServer(opts)` returns a start/stop handle that embeds the
 * full MCP server in-process. The CLI (`src/index.ts`) continues to work
 * unchanged; it merely calls this factory and drives `start()`.
 *
 * Design constraints from the issue spec:
 *  - One server per process (existing singletons are reused).
 *  - A second call before `stop()` throws with a clear message.
 *  - `stop()` resets the per-process init flag so a fresh call works afterwards.
 *  - `start()` is idempotent (second call is a no-op).
 *  - `stop()` is idempotent (second call is a no-op).
 *  - HTTP `port: 0` selects an ephemeral port; resolved URL returned from `start()`.
 *  - `events` exposes the process-wide lifecycle bus when A1 is present.
 */

import * as net from 'net';
import { getMCPServer, setMCPServerOptions, _resetMCPServerForTesting } from '../mcp-server';
import { registerAllTools } from '../tools';
import { createTransport } from '../transports/index';
import { getGlobalConfig, setGlobalConfig } from '../config/global';
import { resolveHeadlessMode } from '../config/headless-resolver';
import { resolveWindowBoundsConfig } from '../config/window-bounds';
import { ToolTier } from '../config/tool-tiers';
import { bootstrapPilot, logActiveFlags, stopPilotBootstrap } from '../harness/flags';
import { getChromeLauncher, _resetChromeLauncherForTesting } from '../chrome/launcher';
import { getSessionManager, _resetSessionManagerForTesting } from '../session-manager';
import { resetChromePool } from '../chrome/pool';
import { getCDPClient, _resetCDPClientForTesting, _resetCDPClientFactoryForTesting } from '../cdp/client';
import { getBrowserStateManager } from '../browser-state';
import { HTTPTransport } from '../transports/http';
import { ChromeProcessWatchdog } from '../chrome/process-watchdog';
import { TabHealthMonitor } from '../cdp/tab-health-monitor';
import { EventLoopMonitor, setGlobalEventLoopMonitor } from '../watchdog/event-loop-monitor';
import { HealthEndpoint } from '../watchdog/health-endpoint';
import { resolveHealthEndpointEnabled } from '../utils/health-endpoint-gating';
import { DiskMonitor } from '../watchdog/disk-monitor';
import { ChromeProcessMonitor } from '../watchdog/chrome-monitor';
import { SessionStatePersistence } from '../session-state-persistence';
import { getLifecycleBus, type LifecycleEventBus } from './lifecycle';
import { writePidFile, cleanOrphanedChromeProcesses } from '../utils/pid-manager';
import { installParentWatcher } from '../utils/parent-watcher';
import { installIdleTimeout } from '../utils/idle-timeout';
import { getIdleState } from '../utils/idle-state';
import { getListenerErrorStats } from '../utils/safe-listener';
import type { MCPServer } from '../mcp-server';
import {
  DEFAULT_PROCESS_WATCHDOG_INTERVAL_MS,
  DEFAULT_TAB_HEALTH_PROBE_INTERVAL_MS,
  DEFAULT_TAB_HEALTH_PROBE_TIMEOUT_MS,
  DEFAULT_TAB_UNHEALTHY_THRESHOLD,
  DEFAULT_TAB_EVICTION_THRESHOLD,
  DEFAULT_EVENT_LOOP_CHECK_INTERVAL_MS,
  DEFAULT_EVENT_LOOP_WARN_THRESHOLD_MS,
  DEFAULT_EVENT_LOOP_FATAL_MS,
  DEFAULT_HEALTH_ENDPOINT_PORT,
  DEFAULT_CHROME_MONITOR_INTERVAL_MS,
  DEFAULT_CHROME_MEMORY_WARN_BYTES,
  DEFAULT_CHROME_MEMORY_CRITICAL_BYTES,
} from '../config/defaults';

// ---------------------------------------------------------------------------
// Public types (matches issue contract verbatim)
// ---------------------------------------------------------------------------

export interface CreateServerOptions {
  transport:
    | 'stdio'
    | { http: { port: number; host?: string; authToken?: string; allowUnauthenticated?: boolean } }
    | { both: { httpPort: number; httpHost?: string; authToken?: string; allowUnauthenticated?: boolean } }
    | 'both';

  chrome?: {
    port?: number;
    userDataDir?: string;
    profileDirectory?: string;
    chromeBinary?: string;
    launchMode?: 'auto' | 'attach' | 'isolated';
    autoLaunch?: boolean;
    headless?: boolean;
    headlessShell?: boolean;
    restartChrome?: boolean;
    windowSize?: string;
    windowPosition?: string;
    windowBounds?: string;
    startMaximized?: boolean;
  };

  pilot?: boolean;
  tools?: { allTools?: boolean };
  security?: { blockedDomains?: string[]; auditLog?: boolean; sanitizeContent?: boolean };
  idleTimeoutMs?: number;
  parentPid?: number;
  healthEndpointPort?: number;
  /** Optional pre-loaded API key store (CLI: OPENCHROME_API_KEYS_PATH). */
  apiKeyStore?: import('../auth/api-key-store').ApiKeyStore;
  /** Hybrid Lightpanda routing. */
  hybrid?: { enabled: true; lightpandaPort: number };
}

/** Returned by `server.start()`. */
export interface ServerStartResult {
  stdio?: true;
  httpUrl?: string;
}

/** Handle returned by `createOpenChromeServer()`. */
export interface OpenChromeServer {
  start(): Promise<ServerStartResult>;
  stop(reason?: 'sigterm' | 'idle' | 'caller'): Promise<void>;
  /** Process-wide browser lifecycle bus for embedders and in-tree subscribers. */
  readonly events: LifecycleEventBus;
  readonly mcp: MCPServer;
}

// ---------------------------------------------------------------------------
// Singleton guard
// ---------------------------------------------------------------------------

let _activeServer: OpenChromeServerImpl | null = null;

function _resetAllSingletons(): void {
  _resetMCPServerForTesting();
  _resetChromeLauncherForTesting();
  _resetSessionManagerForTesting();
  resetChromePool();
  _resetCDPClientForTesting();
  _resetCDPClientFactoryForTesting();
}

// ---------------------------------------------------------------------------
// Ephemeral-port helper
// ---------------------------------------------------------------------------

/** Resolve port 0 → actual available port by binding then releasing. */
async function resolveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Could not resolve ephemeral port'));
        }
      });
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class OpenChromeServerImpl implements OpenChromeServer {
  readonly events: LifecycleEventBus;
  readonly mcp: MCPServer;

  private _startResult: ServerStartResult | null = null;
  private _stopPromise: Promise<void> | null = null;
  private _opts: CreateServerOptions;

  // Watchdog handles captured during start so stop() can tear them down
  private _processWatchdog: ChromeProcessWatchdog | null = null;
  private _tabHealthMonitor: TabHealthMonitor | null = null;
  private _eventLoopMonitor: EventLoopMonitor | null = null;
  private _diskMonitor: DiskMonitor | null = null;
  private _chromeProcessMonitor: ChromeProcessMonitor | null = null;
  private _healthEndpoint: HealthEndpoint | null = null;
  private _idleTimeoutHandle: ReturnType<typeof installIdleTimeout> | null = null;
  private _parentWatcherHandle: ReturnType<typeof installParentWatcher> | null = null;
  private _httpTransport: HTTPTransport | null = null;
  private _sessionPersistence: SessionStatePersistence | null = null;

  constructor(opts: CreateServerOptions) {
    this._opts = opts;
    this.events = getLifecycleBus();
    this.mcp = getMCPServer();
  }

  async start(): Promise<ServerStartResult> {
    // Idempotent
    if (this._startResult !== null) {
      return this._startResult;
    }

    const opts = this._opts;
    const chrome = opts.chrome ?? {};
    const port = chrome.port ?? 9222;
    const autoLaunch = chrome.autoLaunch ?? false;
    const userDataDir = chrome.userDataDir ?? process.env.CHROME_USER_DATA_DIR ?? undefined;
    const profileDirectory = chrome.profileDirectory ?? process.env.CHROME_PROFILE_DIRECTORY ?? undefined;
    const chromeBinary = chrome.chromeBinary ?? process.env.CHROME_BINARY ?? undefined;
    const useHeadlessShell = chrome.headlessShell ?? false;
    const restartChrome = chrome.restartChrome ?? false;

    console.error('[openchrome] Starting MCP server');
    logActiveFlags();
    if (opts.pilot || process.env.OPENCHROME_PILOT === '1') {
      await bootstrapPilot();
    }

    console.error(`[openchrome] Chrome debugging port: ${port}`);
    console.error(`[openchrome] Auto-launch Chrome: ${autoLaunch}`);

    // Headless resolution
    let headless: boolean;
    try {
      const mode = resolveHeadlessMode(
        { headless: chrome.headless, visible: undefined },
        { OPENCHROME_HEADLESS: process.env.OPENCHROME_HEADLESS },
        { headless: getGlobalConfig().headless },
      );
      headless = mode === 'headless';
    } catch (err) {
      throw new Error(`[openchrome] ${(err as Error).message}`);
    }

    // Window bounds
    let windowConfig;
    try {
      windowConfig = resolveWindowBoundsConfig(
        {
          windowSize: chrome.windowSize,
          windowPosition: chrome.windowPosition,
          windowBounds: chrome.windowBounds,
          startMaximized: chrome.startMaximized,
        },
        {
          OPENCHROME_WINDOW_SIZE: process.env.OPENCHROME_WINDOW_SIZE,
          OPENCHROME_WINDOW_POSITION: process.env.OPENCHROME_WINDOW_POSITION,
          OPENCHROME_WINDOW_BOUNDS: process.env.OPENCHROME_WINDOW_BOUNDS,
          OPENCHROME_START_MAXIMIZED: process.env.OPENCHROME_START_MAXIMIZED,
        },
      );
    } catch (err) {
      throw new Error(`[openchrome] ${(err as Error).message}`);
    }

    setGlobalConfig({ port, autoLaunch, userDataDir, profileDirectory, chromeBinary, useHeadlessShell, headless, restartChrome, ...windowConfig });

    // Security
    if (opts.security?.blockedDomains?.length) {
      const existing = getGlobalConfig().security || {};
      setGlobalConfig({ security: { ...existing, blocked_domains: opts.security.blockedDomains } });
    }
    if (opts.security?.auditLog) {
      const existing = getGlobalConfig().security || {};
      setGlobalConfig({ security: { ...existing, audit_log: true } });
    }
    if (opts.security?.sanitizeContent === false) {
      const existing = getGlobalConfig().security || {};
      setGlobalConfig({ security: { ...existing, sanitize_content: false } });
    }

    // Tool tiers
    const envTier = parseInt(process.env.OPENCHROME_TOOL_TIER || '', 10);
    if (opts.tools?.allTools || envTier >= 3) {
      setMCPServerOptions({ initialToolTier: 3 as ToolTier });
    } else if (envTier === 2) {
      setMCPServerOptions({ initialToolTier: 2 as ToolTier });
    }

    // Transport
    let transportMode: 'stdio' | 'http' | 'both';
    let httpPort: number | undefined;
    let httpHost: string | undefined;
    let authToken: string | undefined;
    let allowUnauthenticatedHttp: boolean | undefined;

    if (opts.transport === 'stdio' || opts.transport === 'both') {
      transportMode = opts.transport;
    } else if (typeof opts.transport === 'object' && 'http' in opts.transport) {
      transportMode = 'http';
      httpPort = opts.transport.http.port;
      httpHost = opts.transport.http.host ?? '127.0.0.1';
      authToken = opts.transport.http.authToken ?? process.env.OPENCHROME_AUTH_TOKEN;
      allowUnauthenticatedHttp = opts.transport.http.allowUnauthenticated;
    } else if (typeof opts.transport === 'object' && 'both' in opts.transport) {
      transportMode = 'both';
      httpPort = opts.transport.both.httpPort;
      httpHost = opts.transport.both.httpHost ?? '127.0.0.1';
      authToken = opts.transport.both.authToken ?? process.env.OPENCHROME_AUTH_TOKEN;
      allowUnauthenticatedHttp = opts.transport.both.allowUnauthenticated;
    } else {
      transportMode = 'stdio';
    }

    // Hybrid mode plumbing
    if (opts.hybrid?.enabled) {
      setGlobalConfig({
        hybrid: {
          enabled: true,
          lightpandaPort: opts.hybrid.lightpandaPort,
        },
      });
    }

    const useHttp = transportMode === 'http' || transportMode === 'both';
    if (useHttp && !process.env.OPENCHROME_MAX_RECONNECT_ATTEMPTS) {
      process.env.OPENCHROME_MAX_RECONNECT_ATTEMPTS = '0';
    }

    // Resolve port 0 → ephemeral port before constructing HTTPTransport
    if (useHttp && httpPort === 0) {
      httpPort = await resolveEphemeralPort();
    }

    const server = this.mcp;
    registerAllTools(server);

    writePidFile(port);
    cleanOrphanedChromeProcesses([port, port + 1, port + 2, port + 3, port + 4]);

    // Start transport
    let resolvedHttpUrl: string | undefined;

    if (transportMode === 'both') {
      const resolvedPort = httpPort ?? 3100;
      const resolvedHost = httpHost ?? '127.0.0.1';
      const httpTrans = new HTTPTransport(
        resolvedPort, resolvedHost, authToken,
        { ...(opts.apiKeyStore ? { apiKeyStore: opts.apiKeyStore } : {}), allowUnauthenticatedHttp },
      );
      this._httpTransport = httpTrans;
      server.start();
      httpTrans.onMessage(async (msg: Record<string, unknown>, signal?: AbortSignal) =>
        server.handleMessage(msg, signal),
      );
      server.wireRateLimiterCleanup(httpTrans);
      httpTrans.start();
      resolvedHttpUrl = `http://${resolvedHost}:${resolvedPort}`;
    } else if (useHttp) {
      const resolvedPort = httpPort ?? 3100;
      const resolvedHost = httpHost ?? '127.0.0.1';
      const transport = createTransport('http', {
        port: resolvedPort, host: resolvedHost, authToken,
        apiKeyStore: opts.apiKeyStore, allowUnauthenticatedHttp,
      });
      this._httpTransport = transport as HTTPTransport;
      server.start(transport);
      resolvedHttpUrl = `http://${resolvedHost}:${resolvedPort}`;
    } else {
      server.start();
    }

    // Idle timeout
    if (opts.idleTimeoutMs !== undefined && opts.idleTimeoutMs > 0) {
      const idleState = getIdleState();
      const sessionManager = getSessionManager();
      this._idleTimeoutHandle = installIdleTimeout({
        windowMs: opts.idleTimeoutMs,
        idleState,
        sessionCountFn: () => sessionManager.sessionCount,
        exitFn: () => {
          this.stop('idle').catch((err) => {
            console.error('[openchrome] idle-timeout stop failed:', err);
          });
        },
      });
    }

    // Parent watcher (stdio only)
    if (transportMode === 'stdio' && process.env.OPENCHROME_PPID_WATCH !== '0') {
      const parentPid = opts.parentPid ?? process.ppid;
      if (parentPid > 1) {
        this._parentWatcherHandle = installParentWatcher({ parentPid });
      }
    }

    // Self-healing monitors
    const launcher = getChromeLauncher(port);
    const cdpClient = getCDPClient();
    const sessionManager = getSessionManager();

    if (this._httpTransport) {
      this._httpTransport.setSessionManager(sessionManager);
    }

    const stateManager = getBrowserStateManager();
    stateManager.setCookieProvider(async () => {
      try {
        const pages = await cdpClient.getPages();
        if (pages.length === 0) return [];
        const client = await pages[0].createCDPSession();
        try {
          const result = await client.send('Network.getAllCookies') as { cookies?: unknown[] };
          return result.cookies || [];
        } finally {
          await client.detach();
        }
      } catch { return []; }
    });
    stateManager.setTabUrlProvider(async () => {
      try {
        const pages = await cdpClient.getPages();
        return pages.map(p => p.url()).filter(u => u && u !== 'about:blank');
      } catch { return []; }
    });
    stateManager.start().catch((err: unknown) => {
      console.error('[SelfHealing] BrowserStateManager start failed:', err);
    });

    const processWatchdog = new ChromeProcessWatchdog(launcher, {
      intervalMs: parseInt(process.env.OPENCHROME_PROCESS_WATCHDOG_INTERVAL_MS || '', 10) || DEFAULT_PROCESS_WATCHDOG_INTERVAL_MS,
    });
    this._processWatchdog = processWatchdog;

    const chromeProcessMonitor = new ChromeProcessMonitor({
      intervalMs: DEFAULT_CHROME_MONITOR_INTERVAL_MS,
      warnBytes: DEFAULT_CHROME_MEMORY_WARN_BYTES,
      criticalBytes: DEFAULT_CHROME_MEMORY_CRITICAL_BYTES,
    });
    this._chromeProcessMonitor = chromeProcessMonitor;

    processWatchdog.on('chrome-relaunched', () => {
      cdpClient.forceReconnect().catch((err: unknown) => {
        console.error('[SelfHealing] Post-relaunch reconnect failed:', err);
      });
    });
    processWatchdog.on('chrome-relaunched', () => {
      const newPid = cdpClient.getChromePid();
      if (newPid != null && process.platform !== 'win32') {
        chromeProcessMonitor.stop();
        chromeProcessMonitor.start(newPid);
      }
    });
    processWatchdog.start();

    const tabHealthMonitor = new TabHealthMonitor({
      probeIntervalMs: parseInt(process.env.OPENCHROME_TAB_HEALTH_PROBE_INTERVAL_MS || '', 10) || DEFAULT_TAB_HEALTH_PROBE_INTERVAL_MS,
      probeTimeoutMs: DEFAULT_TAB_HEALTH_PROBE_TIMEOUT_MS,
      unhealthyThreshold: DEFAULT_TAB_UNHEALTHY_THRESHOLD,
      evictionThreshold: DEFAULT_TAB_EVICTION_THRESHOLD,
    });
    this._tabHealthMonitor = tabHealthMonitor;
    tabHealthMonitor.on('tab-evict', ({ targetId }: { targetId: string }) => {
      const owner = sessionManager.getTargetOwner(targetId);
      if (owner) {
        sessionManager.closeTarget(owner.sessionId, targetId).catch((err: unknown) => {
          console.error(`[SelfHealing] Failed to evict tab ${targetId}:`, err);
        });
      }
    });

    const fatalThresholdMs = parseInt(process.env.OPENCHROME_EVENT_LOOP_FATAL_MS || '', 10) || DEFAULT_EVENT_LOOP_FATAL_MS;
    const eventLoopMonitor = new EventLoopMonitor({
      checkIntervalMs: DEFAULT_EVENT_LOOP_CHECK_INTERVAL_MS,
      warnThresholdMs: DEFAULT_EVENT_LOOP_WARN_THRESHOLD_MS,
      fatalThresholdMs,
    });
    this._eventLoopMonitor = eventLoopMonitor;
    eventLoopMonitor.on('fatal', () => {
      console.error('[SelfHealing] FATAL: Event loop blocked beyond threshold, exiting...');
      process.exit(1);
    });
    eventLoopMonitor.start();
    setGlobalEventLoopMonitor(eventLoopMonitor);

    // Health endpoint
    const healthPort = opts.healthEndpointPort ?? (parseInt(process.env.OPENCHROME_HEALTH_PORT || '', 10) || DEFAULT_HEALTH_ENDPOINT_PORT);
    const healthBind = process.env.OPENCHROME_HEALTH_BIND || '127.0.0.1';
    const healthEndpointOverride = process.env.OPENCHROME_HEALTH_ENDPOINT;
    const healthEndpointEnabled = resolveHealthEndpointEnabled(transportMode, healthEndpointOverride);
    if (healthEndpointEnabled) {
      const diskMonitor = new DiskMonitor();
      this._diskMonitor = diskMonitor;
      diskMonitor.start();

      const healthEndpoint = new HealthEndpoint(() => {
        const elStats = eventLoopMonitor.getStats();
        const tabHealth = tabHealthMonitor.getAllHealth();
        let healthyTabs = 0;
        let unhealthyTabs = 0;
        for (const [, info] of tabHealth) {
          if (info.status === 'healthy') healthyTabs++;
          else unhealthyTabs++;
        }
        return {
          status: unhealthyTabs > 0 ? 'degraded' : 'ok',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          eventLoop: { maxDriftMs: elStats.maxDriftMs, warnCount: elStats.warnCount },
          tabs: { total: tabHealth.size, healthy: healthyTabs, unhealthy: unhealthyTabs },
          sessions: { active: sessionManager?.sessionCount ?? 0 },
          tenants: { activeContexts: sessionManager?.tenantContextCount ?? 0 },
          listeners: getListenerErrorStats(),
        };
      }, healthPort, healthBind);
      this._healthEndpoint = healthEndpoint;
      healthEndpoint.start().catch((err: unknown) => {
        console.error('[SelfHealing] HealthEndpoint start failed:', err);
      });
    } else {
      this._diskMonitor = new DiskMonitor();
      this._diskMonitor.start();
    }

    // Session persistence
    const sessionPersistence = new SessionStatePersistence();
    this._sessionPersistence = sessionPersistence;
    sessionPersistence.restore().catch((err: unknown) => {
      console.error('[SelfHealing] Session state restore failed:', err);
    });

    // Chrome process monitor
    const chromePid = cdpClient.getChromePid();
    if (chromePid != null) {
      chromeProcessMonitor.start(chromePid);
    }

    // Event wiring
    sessionManager.addEventListener((event) => {
      if (event.type === 'session:target-added' && event.targetId) {
        cdpClient.getPageByTargetId(event.targetId).then((page) => {
          if (page) tabHealthMonitor.monitorTab(event.targetId!, page);
        }).catch(() => { /* best-effort */ });
      }
    });
    cdpClient.addTargetDestroyedListener((targetId) => {
      tabHealthMonitor.unmonitorTab(targetId);
    });
    sessionManager.addEventListener((event) => {
      if (['session:created', 'session:deleted', 'session:target-added', 'session:target-removed'].includes(event.type)) {
        const snapshot = SessionStatePersistence.createSnapshot(sessionManager.getSessions());
        sessionPersistence.scheduleSave(snapshot);
      }
    });

    const result: ServerStartResult = {};
    if (transportMode === 'stdio' || transportMode === 'both') {
      result.stdio = true;
    }
    if (resolvedHttpUrl) {
      result.httpUrl = resolvedHttpUrl;
    }

    this._startResult = result;
    return result;
  }

  async stop(reason?: 'sigterm' | 'idle' | 'caller'): Promise<void> {
    // Idempotent
    if (this._stopPromise !== null) {
      return this._stopPromise;
    }
    this._stopPromise = this._stopInternal(reason);
    return this._stopPromise;
  }

  private async _stopInternal(_reason?: string): Promise<void> {
    console.error('[openchrome] OpenChromeServer stopping...');

    // Stop pilot-tier side effects (auto-extractor subscriptions, curator timers)
    // before resetting core singletons so createOpenChromeServer().start()/stop()
    // can be repeated in the same process without duplicate background work.
    stopPilotBootstrap();

    // Stop watchdogs first
    this._idleTimeoutHandle?.stop();
    this._parentWatcherHandle?.stop();
    this._processWatchdog?.stop();
    this._tabHealthMonitor?.stopAll();
    this._eventLoopMonitor?.stop();
    this._diskMonitor?.stop();
    this._chromeProcessMonitor?.stop();
    await this._healthEndpoint?.stop();

    // Save storage state
    try {
      const sessionManager = getSessionManager();
      await Promise.race([
        sessionManager.saveAllStorageState(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (err) {
      console.error(`[openchrome] Storage state save on stop failed (non-fatal): ${err}`);
    }

    try {
      getBrowserStateManager().stop();
    } catch { /* best-effort */ }

    this._sessionPersistence?.cancelPendingSave();

    // Stop MCP server (closes transport)
    await this.mcp.stop();

    // Reset all singletons so a fresh createOpenChromeServer() works
    _resetAllSingletons();
    _activeServer = null;

    console.error('[openchrome] OpenChromeServer stopped.');
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create and return an `OpenChromeServer` handle.
 *
 * Throws if a server is already active in this process (call `stop()` first).
 * Call `server.start()` to begin listening; call `server.stop()` to shut down
 * and clear the singleton so a fresh call can follow.
 */
export async function createOpenChromeServer(opts: CreateServerOptions): Promise<OpenChromeServer> {
  if (_activeServer !== null) {
    throw new Error(
      'openchrome: server already initialized — call stop() before re-creating',
    );
  }
  const impl = new OpenChromeServerImpl(opts);
  _activeServer = impl;
  return impl;
}
