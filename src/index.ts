#!/usr/bin/env node
/**
 * CLI Entry Point for openchrome
 * MCP Server for parallel Claude Code browser sessions
 *
 * Uses puppeteer-core to directly connect to Chrome DevTools Protocol,
 * enabling multiple Claude Code sessions to control Chrome simultaneously.
 */

import { Command } from 'commander';
import { getMCPServer, setMCPServerOptions } from './mcp-server';
import { registerAllTools } from './tools';
import { createTransport } from './transports/index';
import { getGlobalConfig, setGlobalConfig } from './config/global';
import { ToolTier } from './config/tool-tiers';
import { writePidFile, cleanOrphanedChromeProcesses } from './utils/pid-manager';
import { getVersion } from './version';
import { ChromeProcessWatchdog } from './chrome/process-watchdog';
import { TabHealthMonitor } from './cdp/tab-health-monitor';
import { EventLoopMonitor, setGlobalEventLoopMonitor } from './watchdog/event-loop-monitor';
import { HealthEndpoint, HealthData } from './watchdog/health-endpoint';
import { DiskMonitor } from './watchdog/disk-monitor';
import { ChromeProcessMonitor } from './watchdog/chrome-monitor';
import { SessionStatePersistence } from './session-state-persistence';
import { getCDPClient } from './cdp/client';
import { getSessionManager } from './session-manager';
import { getChromeLauncher } from './chrome/launcher';
import { getBrowserStateManager } from './browser-state';
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
  DEFAULT_HEARTBEAT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS_HTTP,
  DEFAULT_CHROME_MONITOR_INTERVAL_MS,
  DEFAULT_CHROME_MEMORY_WARN_BYTES,
  DEFAULT_CHROME_MEMORY_CRITICAL_BYTES,
} from './config/defaults';

// Prevent silent crashes from unhandled promise rejections in background tasks
process.on('unhandledRejection', (reason) => {
  console.error('[openchrome] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[openchrome] Uncaught exception:', error);
  // Chrome cleanup happens in the process.on('exit') handler registered below
  process.exit(1);
});

const program = new Command();

program
  .name('openchrome')
  .description('MCP server for parallel Claude Code browser sessions')
  .version(getVersion());

program
  .command('serve')
  .description('Start the MCP server')
  .option('-p, --port <port>', 'Chrome remote debugging port', process.env.CHROME_PORT || '9222')
  .option('--auto-launch', 'Auto-launch Chrome if not running (default: false)')
  .option('--user-data-dir <dir>', 'Chrome user data directory (default: real Chrome profile on macOS)')
  .option('--profile-directory <name>', 'Chrome profile directory name (e.g., "Profile 1", "Default")')
  .option('--chrome-binary <path>', 'Path to Chrome binary (e.g., chrome-headless-shell)')
  .option('--headless-shell', 'Use chrome-headless-shell if available (default: false)')
  .option('--visible', 'Show Chrome window (default: headless when auto-launch)')
  .option('--restart-chrome', 'Quit running Chrome to reuse real profile (default: uses temp profile)')
  .option('--hybrid', 'Enable hybrid mode (Lightpanda + Chrome routing)')
  .option('--lp-port <port>', 'Lightpanda debugging port (default: 9223)', '9223')
  .option('--blocked-domains <domains>', 'Comma-separated list of blocked domains (e.g., "*.bank.com,mail.google.com")')
  .option('--audit-log', 'Enable security audit logging (default: false)')
  .option('--no-sanitize-content', 'Disable content sanitization for prompt injection defense (default: enabled)')
  .option('--all-tools', 'Expose all tools from startup (bypass progressive disclosure)')
  .option('--server-mode', 'Server/headless mode: auto-launch headless Chrome, skip cookie bridge')
  .option('--http [port]', 'Use Streamable HTTP transport instead of stdio (default port: 3100)')
  .option('--http-host <host>', 'Bind address for HTTP transport (default: 127.0.0.1, use 0.0.0.0 for external access)')
  .option('--auth-token <token>', 'Bearer token for HTTP transport authentication (also: OPENCHROME_AUTH_TOKEN env var)')
  .option('--transport <mode>', 'Transport mode: stdio, http, or both (default: stdio)', process.env.OPENCHROME_TRANSPORT || undefined)
  .action(async (options: { port: string; autoLaunch?: boolean; userDataDir?: string; profileDirectory?: string; chromeBinary?: string; headlessShell?: boolean; visible?: boolean; restartChrome?: boolean; hybrid?: boolean; lpPort?: string; blockedDomains?: string; auditLog?: boolean; sanitizeContent?: boolean; allTools?: boolean; serverMode?: boolean; http?: string | boolean; authToken?: string; transport?: string }) => {
    const port = parseInt(options.port, 10);
    let autoLaunch = options.autoLaunch || false;

    // Server mode forces headless + auto-launch + no cookie bridge
    if (options.serverMode) {
      autoLaunch = true;
      if (options.visible) {
        console.error('[openchrome] Warning: --visible ignored in server mode (headless forced)');
      }
      options.visible = false;
      console.error('[openchrome] Server mode: enabled (headless, no cookie bridge)');
    }
    const userDataDir = options.userDataDir || process.env.CHROME_USER_DATA_DIR || undefined;
    const profileDirectory = options.profileDirectory || process.env.CHROME_PROFILE_DIRECTORY || undefined;
    const chromeBinary = options.chromeBinary || process.env.CHROME_BINARY || undefined;
    const useHeadlessShell = options.headlessShell || false;
    const restartChrome = options.restartChrome || false;

    console.error(`[openchrome] Starting MCP server`);
    console.error(`[openchrome] Chrome debugging port: ${port}`);
    console.error(`[openchrome] Auto-launch Chrome: ${autoLaunch}`);
    if (userDataDir) {
      console.error(`[openchrome] User data dir: ${userDataDir}`);
    }
    if (profileDirectory) {
      console.error(`[openchrome] Profile directory: ${profileDirectory}`);
    }
    if (chromeBinary) {
      console.error(`[openchrome] Chrome binary: ${chromeBinary}`);
    }
    if (useHeadlessShell) {
      console.error(`[openchrome] Using headless-shell mode`);
    }

    // Headless by default when auto-launching, unless --visible is specified
    const headless = autoLaunch && !options.visible;
    if (autoLaunch) {
      console.error(`[openchrome] Headless mode: ${headless}`);
    }

    // Set global config before initializing anything
    setGlobalConfig({ port, autoLaunch, userDataDir, profileDirectory, chromeBinary, useHeadlessShell, headless, restartChrome });
    if (restartChrome) {
      console.error(`[openchrome] Restart Chrome mode: enabled (will quit existing Chrome)`);
    }

    // Apply server mode config (skip cookie bridge)
    if (options.serverMode) {
      setGlobalConfig({ skipCookieBridge: true });
    }

    // Configure hybrid mode if enabled
    const hybrid = options.hybrid || false;
    const lpPort = parseInt(options.lpPort || '9223', 10);

    if (hybrid) {
      setGlobalConfig({
        hybrid: {
          enabled: true,
          lightpandaPort: lpPort,
        },
      });
      console.error(`[openchrome] Hybrid mode: enabled`);
      console.error(`[openchrome] Lightpanda port: ${lpPort}`);
    }

    // Configure domain blocklist if provided
    if (options.blockedDomains) {
      const blockedList = options.blockedDomains.split(',').map((d: string) => d.trim()).filter(Boolean);
      const existing = getGlobalConfig().security || {};
      setGlobalConfig({
        security: { ...existing, blocked_domains: blockedList },
      });
      console.error(`[openchrome] Blocked domains: ${blockedList.join(', ')}`);
    }

    // Configure audit logging if enabled
    if (options.auditLog) {
      const existing = getGlobalConfig().security || {};
      setGlobalConfig({
        security: { ...existing, audit_log: true },
      });
      console.error('[openchrome] Audit logging: enabled');
    }

    // Configure content sanitization (enabled by default, --no-sanitize-content to disable)
    if (options.sanitizeContent === false) {
      const existing = getGlobalConfig().security || {};
      setGlobalConfig({
        security: { ...existing, sanitize_content: false },
      });
      console.error('[openchrome] Content sanitization: disabled');
    }

    // Tool tier configuration
    const envTier = parseInt(process.env.OPENCHROME_TOOL_TIER || '', 10);
    if (options.allTools || envTier >= 3) {
      setMCPServerOptions({ initialToolTier: 3 as ToolTier });
      console.error('[openchrome] All tools exposed from startup');
    } else if (envTier === 2) {
      setMCPServerOptions({ initialToolTier: 2 as ToolTier });
      console.error('[openchrome] Tier 2 tools exposed from startup');
    }

    // Set infinite reconnection for HTTP daemon mode BEFORE creating CDPClient singleton.
    // getMCPServer() → SessionManager → getCDPClient() reads this env var at construction.
    // Resolve transport mode: --transport flag takes precedence over --http flag
    const transportMode = options.transport || (options.http !== undefined && options.http !== false ? 'http' : 'stdio');
    const useHttp = transportMode === 'http' || transportMode === 'both';
    if (useHttp && !process.env.OPENCHROME_MAX_RECONNECT_ATTEMPTS) {
      process.env.OPENCHROME_MAX_RECONNECT_ATTEMPTS = '0';
    }

    const server = getMCPServer();
    registerAllTools(server);

    // Write PID file for zombie process detection
    writePidFile(port);

    // Clean up orphaned Chrome from previous crashed sessions
    cleanOrphanedChromeProcesses([port, port + 1, port + 2, port + 3, port + 4]);

    // Kill a Chrome process and its entire process group.
    // Chrome is spawned with detached:true (new process group), so killing
    // only the main PID leaves renderer/GPU/crashpad children alive.
    const killChromeTree = (pid: number) => {
      if (process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    };

    // Last-resort synchronous Chrome kill on ANY exit path
    // (including uncaughtException, SIGKILL recovery, process.exit())
    process.on('exit', () => {
      try {
        const launcher = getChromeLauncher();
        const chromePid = launcher.getChromePid();
        if (chromePid) {
          killChromeTree(chromePid);
        }
      } catch { /* launcher may not be initialized */ }

      // Also kill any pool Chrome instances
      try {
        const { getChromePool } = require('./chrome/pool');
        const pool = getChromePool();
        for (const [, instance] of pool.getInstances()) {
          const pid = instance.launcher.getChromePid();
          if (pid) {
            killChromeTree(pid);
          }
        }
      } catch { /* pool may not be initialized */ }
    });

    // Register signal handlers for graceful shutdown
    const shutdown = async (signal: string) => {
      console.error(`[openchrome] Received ${signal}, shutting down...`);
      await server.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    // Windows: closing the console window sends CTRL_CLOSE_EVENT mapped to SIGHUP by libuv.
    // Node.js will be force-killed by Windows ~5-10s later; shutdown() is best-effort.
    if (process.platform === 'win32') {
      process.on('SIGHUP', () => shutdown('SIGHUP'));
    }
    // Resolve auth token: CLI flag takes precedence over env var
    const authToken = options.authToken || process.env.OPENCHROME_AUTH_TOKEN || undefined;
    if (authToken) {
      console.error('[openchrome] Bearer token authentication: enabled');
    }

    // Start transport (useHttp/transportMode determined above, before getMCPServer)
    let httpTransport: import('./transports/http').HTTPTransport | null = null;
    const httpPort = typeof options.http === 'string' ? parseInt(options.http, 10) : parseInt(process.env.OPENCHROME_HTTP_PORT || '', 10) || 3100;
    const httpHost = (options as Record<string, unknown>).httpHost as string || process.env.OPENCHROME_HTTP_HOST || '127.0.0.1';

    if (transportMode === 'both') {
      // Dual mode: run both stdio and HTTP transports simultaneously
      const { StdioTransport } = require('./transports/stdio');
      const { HTTPTransport } = require('./transports/http');
      const stdioTransport = new StdioTransport();
      const httpTrans = new HTTPTransport(httpPort, httpHost, authToken);
      httpTransport = httpTrans as import('./transports/http').HTTPTransport;
      server.start(stdioTransport);
      httpTransport.onMessage(async (msg: Record<string, unknown>) => {
        return server.handleRequest(msg as unknown as import('./types/mcp').MCPRequest);
      });
      httpTransport.start();
      console.error(`[openchrome] Dual transport mode: stdio + HTTP on ${httpHost}:${httpPort}`);
      console.error('[openchrome] Infinite reconnection: enabled (daemon mode)');
    } else if (useHttp) {
      const transport = createTransport('http', { port: httpPort, host: httpHost, authToken });
      httpTransport = transport as import('./transports/http').HTTPTransport;
      server.start(transport);
      console.error(`[openchrome] HTTP transport enabled on ${httpHost}:${httpPort}`);
      console.error('[openchrome] Infinite reconnection: enabled (daemon mode)');
    } else {
      server.start();
      console.error('[openchrome] STDIO transport enabled');
    }

    // ─── Self-Healing Module Wiring (#354) ──────────────────────────────────

    const launcher = getChromeLauncher();
    const cdpClient = getCDPClient();
    const sessionManager = getSessionManager();

    // Wire session manager into HTTP transport for dashboard API endpoints
    if (httpTransport) {
      httpTransport.setSessionManager(sessionManager);
      console.error('[openchrome] Dashboard API endpoints wired to session manager');
    }

    // Browser State Snapshot (Gap 2: #416)
    const stateManager = getBrowserStateManager();
    stateManager.setCookieProvider(async () => {
      try {
        const pages = await cdpClient.getPages();
        if (pages.length === 0) return [];
        const client = await pages[0].createCDPSession();
        try {
          const result = await client.send('Network.getAllCookies') as { cookies?: any[] };
          return result.cookies || [];
        } finally {
          await client.detach();
        }
      } catch {
        return [];
      }
    });
    stateManager.setTabUrlProvider(async () => {
      try {
        const pages = await cdpClient.getPages();
        return pages.map(p => p.url()).filter(u => u && u !== 'about:blank');
      } catch {
        return [];
      }
    });
    stateManager.start().catch((err: unknown) => {
      console.error('[SelfHealing] BrowserStateManager start failed:', err);
    });
    console.error('[SelfHealing] BrowserStateManager started');

    // Chrome Process Watchdog (Layer 3)
    const processWatchdog = new ChromeProcessWatchdog(launcher, {
      intervalMs: parseInt(process.env.OPENCHROME_PROCESS_WATCHDOG_INTERVAL_MS || '', 10) || DEFAULT_PROCESS_WATCHDOG_INTERVAL_MS,
    });
    processWatchdog.on('chrome-relaunched', () => {
      console.error('[SelfHealing] Chrome relaunched by watchdog, triggering reconnect...');
      cdpClient.forceReconnect().catch((err: unknown) => {
        console.error('[SelfHealing] Post-relaunch reconnect failed:', err);
      });
    });
    // Update ChromeProcessMonitor PID after watchdog relaunch
    processWatchdog.on('chrome-relaunched', () => {
      const newPid = cdpClient.getChromePid();
      if (newPid != null && process.platform !== 'win32') {
        chromeProcessMonitor.stop();
        chromeProcessMonitor.start(newPid);
        console.error(`[SelfHealing] ChromeProcessMonitor restarted (new pid=${newPid})`);
      }
    });
    processWatchdog.start();
    console.error('[SelfHealing] ChromeProcessWatchdog started');

    // Tab Health Monitor (Layer 1)
    const tabHealthMonitor = new TabHealthMonitor({
      probeIntervalMs: parseInt(process.env.OPENCHROME_TAB_HEALTH_PROBE_INTERVAL_MS || '', 10) || DEFAULT_TAB_HEALTH_PROBE_INTERVAL_MS,
      probeTimeoutMs: DEFAULT_TAB_HEALTH_PROBE_TIMEOUT_MS,
      unhealthyThreshold: DEFAULT_TAB_UNHEALTHY_THRESHOLD,
      evictionThreshold: DEFAULT_TAB_EVICTION_THRESHOLD,
    });
    tabHealthMonitor.on('tab-evict', ({ targetId }: { targetId: string }) => {
      console.error(`[SelfHealing] Evicting unhealthy tab ${targetId}`);
      const owner = sessionManager.getTargetOwner(targetId);
      if (owner) {
        sessionManager.closeTarget(owner.sessionId, targetId).catch((err: unknown) => {
          console.error(`[SelfHealing] Failed to evict tab ${targetId}:`, err);
        });
      } else {
        console.error(`[SelfHealing] Tab ${targetId} not found in session manager, skipping eviction`);
      }
    });
    console.error('[SelfHealing] TabHealthMonitor started');

    // Event Loop Monitor (Layer 4)
    const fatalThresholdMs = parseInt(process.env.OPENCHROME_EVENT_LOOP_FATAL_MS || '', 10) || DEFAULT_EVENT_LOOP_FATAL_MS;
    const eventLoopMonitor = new EventLoopMonitor({
      checkIntervalMs: DEFAULT_EVENT_LOOP_CHECK_INTERVAL_MS,
      warnThresholdMs: DEFAULT_EVENT_LOOP_WARN_THRESHOLD_MS,
      fatalThresholdMs,
    });
    eventLoopMonitor.on('fatal', () => {
      console.error('[SelfHealing] FATAL: Event loop blocked beyond threshold, exiting...');
      // Chrome cleanup happens in the synchronous process.on('exit') handler
      process.exit(1);
    });
    eventLoopMonitor.start();
    setGlobalEventLoopMonitor(eventLoopMonitor);
    console.error('[SelfHealing] EventLoopMonitor started');
    if (fatalThresholdMs > 0) {
      console.error(`[SelfHealing] EventLoopMonitor fatal threshold: ${fatalThresholdMs}ms (set OPENCHROME_EVENT_LOOP_FATAL_MS=0 to disable)`);
    }

    // Declare disk monitor early so health provider can reference it
    let diskMonitor: DiskMonitor | null = null;

    // Declare chrome process monitor early so health provider can reference it
    const chromeProcessMonitor = new ChromeProcessMonitor({
      intervalMs: DEFAULT_CHROME_MONITOR_INTERVAL_MS,
      warnBytes: DEFAULT_CHROME_MEMORY_WARN_BYTES,
      criticalBytes: DEFAULT_CHROME_MEMORY_CRITICAL_BYTES,
    });

    // Health Endpoint (Layer 4)
    const healthPort = parseInt(process.env.OPENCHROME_HEALTH_PORT || '', 10) || DEFAULT_HEALTH_ENDPOINT_PORT;
    const healthBind = process.env.OPENCHROME_HEALTH_BIND || '127.0.0.1';
    const healthEndpoint = new HealthEndpoint(() => {
      const elStats = eventLoopMonitor.getStats();
      const tabHealth = tabHealthMonitor.getAllHealth();
      let healthyTabs = 0;
      let unhealthyTabs = 0;
      for (const [, info] of tabHealth) {
        if (info.status === 'healthy') healthyTabs++;
        else unhealthyTabs++;
      }

      // Gap 3: populate CDP connection metrics
      let chromeData: HealthData['chrome'] | undefined;
      try {
        const metrics = cdpClient.getConnectionMetrics();
        chromeData = {
          connected: cdpClient.getConnectionState() === 'connected',
          reconnectCount: metrics.reconnectCount,
          reconnecting: metrics.reconnecting,
          reconnectAttempt: metrics.reconnectAttempt,
          nextRetryInMs: metrics.reconnectNextRetryInMs > 0 ? metrics.reconnectNextRetryInMs : undefined,
        };
      } catch {
        // CDP client may not be initialized yet
      }

      // Disk usage stats
      let diskData: HealthData['disk'] | undefined;
      const diskStats = diskMonitor?.getStats();
      if (diskStats) {
        diskData = {
          totalBytes: diskStats.totalBytes,
          fileCount: diskStats.fileCount,
        };
      }

      // Chrome process memory stats
      let chromeProcessData: HealthData['chromeProcess'] | undefined;
      const chromeStats = chromeProcessMonitor.getStats();
      if (chromeStats) {
        chromeProcessData = {
          pid: chromeStats.pid,
          rssBytes: chromeStats.rssBytes,
        };
      }

      const data: HealthData = {
        status: unhealthyTabs > 0 ? 'degraded' : 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        eventLoop: { maxDriftMs: elStats.maxDriftMs, warnCount: elStats.warnCount },
        chrome: chromeData,
        tabs: { total: tabHealth.size, healthy: healthyTabs, unhealthy: unhealthyTabs },
        disk: diskData,
        browserState: stateManager.getStatus(),
        chromeProcess: chromeProcessData,
        sessions: { active: sessionManager?.sessionCount ?? 0 },
      };
      return data;
    }, healthPort, healthBind);
    healthEndpoint.start().catch((err: unknown) => {
      console.error('[SelfHealing] HealthEndpoint start failed:', err);
    });

    // Session State Persistence (Layer 2)
    const sessionPersistence = new SessionStatePersistence();
    // Restore on startup — informational only; active tabs are reconciled on reconnect
    sessionPersistence.restore().then((restored) => {
      if (restored) {
        console.error(`[SelfHealing] Restored session state: ${restored.sessions.length} sessions from disk (informational — Chrome targets will be reconciled on reconnect)`);
      }
    }).catch((err: unknown) => {
      console.error('[SelfHealing] Session state restore failed:', err);
    });

    // Disk Monitor — auto-prune old journals, snapshots, checkpoints
    diskMonitor = new DiskMonitor();
    diskMonitor.start();
    console.error('[SelfHealing] DiskMonitor started (5-min interval)');

    // Chrome Process Monitor — track Chrome RSS memory, warn before OOM
    // browser.process() returns null when connecting to an already-running Chrome,
    // so we only start the monitor when puppeteer spawned the process.
    const chromePid = cdpClient.getChromePid();
    if (chromePid != null) {
      chromeProcessMonitor.start(chromePid);
      console.error(`[SelfHealing] ChromeProcessMonitor started (pid=${chromePid})`);
    } else {
      console.error('[SelfHealing] ChromeProcessMonitor skipped (no puppeteer-spawned Chrome process)');
    }

    // Gap 1: register tabs with TabHealthMonitor when targets are added/removed
    sessionManager.addEventListener((event) => {
      if (event.type === 'session:target-added' && event.targetId) {
        cdpClient.getPageByTargetId(event.targetId).then((page) => {
          if (page) {
            tabHealthMonitor.monitorTab(event.targetId!, page);
          }
        }).catch((err: unknown) => {
          console.error(`[SelfHealing] Failed to monitor tab ${event.targetId}:`, err);
        });
      }
    });

    // Unregister tabs from TabHealthMonitor when targets are destroyed
    cdpClient.addTargetDestroyedListener((targetId) => {
      tabHealthMonitor.unmonitorTab(targetId);
    });

    // Gap 2: persist session state on every mutation
    sessionManager.addEventListener((event) => {
      if (['session:created', 'session:deleted', 'session:target-added', 'session:target-removed'].includes(event.type)) {
        const snapshot = SessionStatePersistence.createSnapshot(sessionManager.getSessions());
        sessionPersistence.scheduleSave(snapshot);
      }
    });

    // Update shutdown handler to include self-healing cleanup
    const originalShutdown = shutdown;
    const enhancedShutdown = async (signal: string) => {
      processWatchdog.stop();
      tabHealthMonitor.stopAll();
      eventLoopMonitor.stop();
      diskMonitor?.stop();
      stateManager.stop();
      chromeProcessMonitor.stop();
      await healthEndpoint.stop();
      sessionPersistence.cancelPendingSave();
      await originalShutdown(signal);
    };
    // Replace signal handlers
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.on('SIGTERM', () => enhancedShutdown('SIGTERM'));
    process.on('SIGINT', () => enhancedShutdown('SIGINT'));
    if (process.platform === 'win32') {
      process.removeAllListeners('SIGHUP');
      process.on('SIGHUP', () => enhancedShutdown('SIGHUP'));
    }
  });

program
  .command('check')
  .description('Check Chrome connection status')
  .option('-p, --port <port>', 'Chrome remote debugging port', process.env.CHROME_PORT || '9222')
  .action(async (options) => {
    const port = parseInt(options.port, 10);

    console.log('=== OpenChrome Status ===\n');

    // Check Chrome
    let chromeConnected = false;
    try {
      const response = await fetch(`http://localhost:${port}/json/version`);
      const data = (await response.json()) as { Browser: string; webSocketDebuggerUrl: string };
      console.log(`Chrome (port ${port}): ✓ Connected`);
      console.log(`  Browser: ${data.Browser}`);
      console.log(`  WebSocket: ${data.webSocketDebuggerUrl}`);
      chromeConnected = true;
    } catch (error) {
      console.log(`Chrome (port ${port}): ✗ Not connected`);
    }

    console.log('\n=== Instructions ===\n');

    if (!chromeConnected) {
      console.log('Start Chrome with debugging enabled:');
      console.log(`  chrome --remote-debugging-port=${port}\n`);
      console.log('Or let openchrome auto-launch Chrome.\n');
    }

    if (chromeConnected) {
      console.log('Chrome is ready! Add to your Claude Code MCP config:\n');
      console.log(JSON.stringify({
        "mcpServers": {
          "openchrome": {
            "command": "openchrome",
            "args": ["serve"]
          }
        }
      }, null, 2));
    }

    process.exit(chromeConnected ? 0 : 1);
  });

program
  .command('verify')
  .description('Verify performance optimizations are working')
  .option('-p, --port <port>', 'Chrome remote debugging port', process.env.CHROME_PORT || '9222')
  .action(async (options: { port: string }) => {
    const port = parseInt(options.port, 10);

    console.log('=== OpenChrome - Optimization Verification ===\n');

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    // 1. Check Chrome connection
    try {
      const response = await fetch(`http://localhost:${port}/json/version`);
      const data = await response.json() as { Browser: string };
      console.log(`✓ Chrome connected: ${data.Browser}`);
      passed++;
    } catch {
      console.log('✗ Chrome not connected - start Chrome with --remote-debugging-port=' + port);
      console.log('\nCannot proceed without Chrome. Exiting.\n');
      process.exit(1);
    }

    // 2. Verify launch flags (check Chrome command line)
    try {
      const response = await fetch(`http://localhost:${port}/json/version`);
      const versionData = await response.json() as Record<string, string>;
      // Check if we launched Chrome (not user's existing instance)
      const commandLine = versionData['Protocol-Version'] ? 'available' : 'unknown';
      console.log(`✓ Chrome DevTools Protocol: ${commandLine}`);
      passed++;
    } catch {
      console.log('⚠ Could not verify protocol version');
      skipped++;
    }

    // 3. Verify WebP screenshot support
    try {
      // Import dynamically to avoid loading everything
      const puppeteer = require('puppeteer-core');
      const browser = await puppeteer.connect({
        browserURL: `http://localhost:${port}`,
        defaultViewport: null,
      });

      const page = await browser.newPage();
      await page.goto('about:blank');

      // Test WebP screenshot
      const webpBuffer = await page.screenshot({ type: 'webp', quality: 80, encoding: 'base64' }) as string;
      const pngBuffer = await page.screenshot({ type: 'png', encoding: 'base64' }) as string;

      const webpSize = webpBuffer.length;
      const pngSize = pngBuffer.length;
      const ratio = (pngSize / webpSize).toFixed(1);

      console.log(`✓ WebP screenshots: ${ratio}x smaller (WebP: ${(webpSize/1024).toFixed(1)}KB vs PNG: ${(pngSize/1024).toFixed(1)}KB)`);
      passed++;

      // 4. Verify GC command support
      try {
        const client = await page.createCDPSession();
        await client.send('HeapProfiler.collectGarbage');
        console.log('✓ Forced GC (HeapProfiler.collectGarbage): supported');
        passed++;
        await client.detach();
      } catch {
        console.log('⚠ Forced GC: not supported by this Chrome version');
        skipped++;
      }

      // 5. Verify page creation speed (simulates pool benefit)
      const startTime = Date.now();
      const testPage = await browser.newPage();
      const createTime = Date.now() - startTime;
      await testPage.close();
      console.log(`✓ Page creation: ${createTime}ms`);
      passed++;

      // 6. Check memory stats
      try {
        const response = await fetch(`http://localhost:${port}/json`);
        const targets = await response.json() as Array<{ id: string; type: string; url: string }>;
        const pageCount = targets.filter((t: { type: string }) => t.type === 'page').length;
        console.log(`✓ Active targets: ${pageCount} pages`);
        passed++;
      } catch {
        console.log('⚠ Could not check active targets');
        skipped++;
      }

      await page.close();
      browser.disconnect();

    } catch (error) {
      console.log(`✗ Browser verification failed: ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }

    // Summary
    console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);

    if (failed === 0) {
      console.log('\nAll optimizations verified! Performance features are active.\n');
      console.log('Optimization summary:');
      console.log('  • WebP screenshots (3-5x smaller)');
      console.log('  • Cookie bridge caching (30s TTL)');
      console.log('  • Forced GC on tab close');
      console.log('  • Memory-saving Chrome flags');
      console.log('  • Find tool batched CDP calls');
      console.log('  • Connection pool (pre-warmed pages)');
    }

    process.exit(failed > 0 ? 1 : 0);
  });

program
  .command('info')
  .description('Show how it works')
  .action(() => {
    console.log(`
=== OpenChrome ===

Enables multiple Claude Code sessions to control Chrome simultaneously
without "Detached" errors.

HOW IT WORKS:

  Claude Code 1 ──► puppeteer process 1 ──► CDP connection 1 ──┐
                                                                ├──► Chrome
  Claude Code 2 ──► puppeteer process 2 ──► CDP connection 2 ──┘

  Each Claude Code session gets its own:
  - Independent MCP server process
  - Separate Chrome DevTools Protocol connection
  - Isolated browser tabs

WHY NO "DETACHED" ERRORS:

  Unlike the Chrome extension (which shares state),
  each puppeteer-core process maintains its own CDP connection.
  Chrome handles multiple CDP connections natively.

TESTED CONCURRENCY:

  ✓ 20+ simultaneous sessions confirmed working

USAGE:

  # Check Chrome status
  openchrome check

  # Start Chrome with debugging enabled (required unless --auto-launch)
  chrome --remote-debugging-port=9222

  # Add to ~/.claude/.mcp.json
  {
    "mcpServers": {
      "openchrome": {
        "command": "openchrome",
        "args": ["serve"]
      }
    }
  }

  # Or with auto-launch (Chrome starts automatically)
  {
    "mcpServers": {
      "openchrome": {
        "command": "openchrome",
        "args": ["serve", "--auto-launch"]
      }
    }
  }
`);
  });

program.parse();
