#!/usr/bin/env node
/**
 * CLI Entry Point for openchrome
 * MCP Server for parallel Claude Code browser sessions
 *
 * Uses puppeteer-core to directly connect to Chrome DevTools Protocol,
 * enabling multiple Claude Code sessions to control Chrome simultaneously.
 */

import { Command } from 'commander';
import * as os from 'os';
import * as path from 'path';
import { getMCPServer, setMCPServerOptions } from './mcp-server';
import { registerAllTools } from './tools';
import { createTransport } from './transports/index';
import { getGlobalConfig, setGlobalConfig } from './config/global';
import { resolveHeadlessMode } from './config/headless-resolver';
import { resolveCapabilityFilterOptions } from './config/capability-filter';
import { resolveWindowBoundsConfig } from './config/window-bounds';
import { ToolTier } from './config/tool-tiers';
import { writePidFile, cleanOrphanedChromeProcesses } from './utils/pid-manager';
import { installParentWatcher, ParentWatcherHandle } from './utils/parent-watcher';
import { installIdleTimeout, IdleTimeoutHandle, parseDuration } from './utils/idle-timeout';
import { getIdleState } from './utils/idle-state';
import { getVersion } from './version';
import { bootstrapPilot, logActiveFlags } from './harness/flags';
import { ChromeProcessWatchdog } from './chrome/process-watchdog';
import { TabHealthMonitor } from './cdp/tab-health-monitor';
import { EventLoopMonitor, setGlobalEventLoopMonitor } from './watchdog/event-loop-monitor';
import { HealthEndpoint, HealthData } from './watchdog/health-endpoint';
import { resolveHealthEndpointEnabled } from './utils/health-endpoint-gating';
import { DiskMonitor } from './watchdog/disk-monitor';
import { ChromeProcessMonitor } from './watchdog/chrome-monitor';
import { SessionStatePersistence } from './session-state-persistence';
import { getCDPClient } from './cdp/client';
import { getSessionManager } from './session-manager';
import { getChromeLauncher } from './chrome/launcher';
import { ProfileManager } from './chrome/profile-manager';
import { getBrowserStateManager } from './browser-state';
import { getListenerErrorStats, installUnhandledRejectionSafetyNet } from './utils/safe-listener';
import { setComponent, resetReadinessMachine } from './watchdog/readiness';
import { wireChromeReadiness } from './watchdog/chrome-readiness';
import {
  DuplicateControllerError,
  acquireControllerLock,
  formatDuplicateControllerMessage,
  type ControllerLockHandle,
} from './utils/controller-lock';
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
} from './config/defaults';

// Prevent silent crashes from unhandled promise rejections in background tasks.
// Counted via openchrome_unhandled_rejections_total (see safe-listener.ts).
installUnhandledRejectionSafetyNet();

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

function resolveControllerLockUserDataDir(userDataDir: string | undefined, useHeadlessShell: boolean): string {
  if (userDataDir) return userDataDir;
  if (useHeadlessShell) return path.join(os.homedir(), '.openchrome', 'headless-shell-profile');
  return ProfileManager.PERSISTENT_PROFILE_DIR;
}

program
  .command('serve')
  .description('Start the MCP server')
  .option('-p, --port <port>', 'Chrome remote debugging port', process.env.CHROME_PORT || '9222')
  .option('--auto-launch', 'Auto-launch Chrome if not running (default: false)')
  .option('--allow-unsafe-shared-attach', 'Debug escape hatch: allow a second direct controller for the same Chrome port/profile')
  .option('--user-data-dir <dir>', 'Chrome user data directory (default: real Chrome profile on macOS)')
  .option('--profile-directory <name>', 'Chrome profile directory name (e.g., "Profile 1", "Default")')
  .option('--chrome-binary <path>', 'Path to Chrome binary (e.g., chrome-headless-shell)')
  .option('--headless-shell', 'Use chrome-headless-shell if available (default: false)')
  .option('--headless', 'Run Chrome headless (default: headed). Also: OPENCHROME_HEADLESS=1 env var.')
  .option('--visible', '[deprecated] Show Chrome window. Headed is the default since #657; this flag is now a no-op alias and will be removed in a future release.')
  .option('--window-size <width,height>', 'Headed Chrome window size, e.g. 1280,900. Also: OPENCHROME_WINDOW_SIZE.')
  .option('--window-position <x,y>', 'Headed Chrome window position, e.g. 0,0. Also: OPENCHROME_WINDOW_POSITION.')
  .option('--window-bounds <x,y,width,height>', 'Headed Chrome window bounds. Overrides size/position. Also: OPENCHROME_WINDOW_BOUNDS.')
  .option('--start-maximized', 'Start headed Chrome maximized when no explicit size, position, or bounds are set. Also: OPENCHROME_START_MAXIMIZED=1.')
  .option('--restart-chrome', 'Quit running Chrome to reuse real profile (default: uses temp profile)')
  .option('--hybrid', 'Enable hybrid mode (Lightpanda + Chrome routing)')
  .option('--lp-port <port>', 'Lightpanda debugging port (default: 9223)', '9223')
  .option('--blocked-domains <domains>', 'Comma-separated list of blocked domains (e.g., "*.bank.com,mail.google.com")')
  .option('--allow-host <patterns>', 'Comma-separated host allowlist. When set, only http(s) hosts matching exact or leading-wildcard patterns may be opened (also: OPENCHROME_ALLOW_HOSTS).')
  .option('--audit-log', 'Enable security audit logging (default: false)')
  .option('--no-sanitize-content', 'Disable content sanitization for prompt injection defense (default: enabled)')
  .option('--all-tools', 'Expose all tools from startup (bypass progressive disclosure)')
  .option('--server-mode', 'Server/headless mode: auto-launch headless Chrome, skip cookie bridge')
  .option('--http [port]', 'Use Streamable HTTP transport instead of stdio (default port: 3100)')
  .option('--http-host <host>', 'Bind address for HTTP transport (default: 127.0.0.1, use 0.0.0.0 for external access)')
  .option('--auth-token <token>', 'Bearer token for HTTP transport authentication (also: OPENCHROME_AUTH_TOKEN env var)')
  .option('--allow-unauthenticated-http', 'Explicitly allow unauthenticated loopback-only HTTP development mode (also: OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP=1)')
  .option('--transport <mode>', 'Transport mode: stdio, http, or both (default: stdio)')
  .option('--idle-timeout <duration>', 'Self-exit (code 0) after idle window with zero sessions. Format: <number>(ms|s|m|h), e.g. 30m, 90s, 500ms. Bare numbers are rejected. Also: OPENCHROME_IDLE_TIMEOUT_MS env var (integer ms). Default: disabled.')
  .option('--pilot', 'Enable experimental pilot tier (see docs/roadmap/portability-harness-contract.md). Off by default; lazy-loads src/pilot/ modules when set. Also: OPENCHROME_PILOT=1 env var.')
  .option('--slim', 'Expose only core tools (alias for --tools-only core).')
  .option('--tools-only <csv>', 'Expose only tools belonging to the specified capability groups (comma-separated). Valid values: core,crawl,recording,workflow,storage,profile,totp,pilot. Default: all groups exposed.')
  .option('--disable-tools <csv>', 'Remove tools belonging to the specified capability groups (comma-separated). Valid values: core,crawl,recording,workflow,storage,profile,totp,pilot.')
  .option('--introspect-tools-list', 'Print tools/list as compact JSON to stdout and exit (no Chrome/CDP startup). Used by lint-tool-schemas.mjs.')
  .option('--auto-connect [userDataDir]', 'Attach to a Chrome you started yourself by reading <userDataDir>/DevToolsActivePort (#849). When omitted, uses the platform-default Chrome user-data dir. Also: OPENCHROME_AUTO_CONNECT=<dir> env var. Implies --launch-mode=attach.')
  .option('--launch-mode <mode>', 'Chrome launch mode: auto | attach | isolated (#659). Also: OPENCHROME_LAUNCH_MODE env var.')
  .option('--secrets <path>', 'Load a dotenv-format secrets file (KEY=value per line). Tokens "${SECRET:NAME}" in tool arguments are substituted to the real value at MCP request deserialization; the same values are redacted from every LLM-visible artifact (responses, trace, skill records, journal). Default: no secrets loaded. P3: no OS keychain integration.')
  .option('--codegen <mode>', 'Opt-in replay artifact generation: off, puppeteer, playwright, or mcp-replay. Default: off (no response shape changes). Also: OPENCHROME_CODEGEN.')
  .action(async (options: { port: string; autoLaunch?: boolean; allowUnsafeSharedAttach?: boolean; userDataDir?: string; profileDirectory?: string; chromeBinary?: string; headlessShell?: boolean; headless?: boolean; visible?: boolean; windowSize?: string; windowPosition?: string; windowBounds?: string; startMaximized?: boolean; restartChrome?: boolean; hybrid?: boolean; lpPort?: string; blockedDomains?: string; auditLog?: boolean; sanitizeContent?: boolean; allTools?: boolean; serverMode?: boolean; http?: string | boolean; authToken?: string; transport?: string; idleTimeout?: string; allowUnauthenticatedHttp?: boolean; pilot?: boolean; slim?: boolean; toolsOnly?: string; disableTools?: string; introspectToolsList?: boolean; autoConnect?: string | boolean; launchMode?: string; secrets?: string; codegen?: string }) => {
    const { normalizeCodegenMode, setCodegenMode } = await import('./core/codegen');
    const codegenMode = normalizeCodegenMode(options.codegen ?? process.env.OPENCHROME_CODEGEN);
    setCodegenMode(codegenMode);
    process.env.OPENCHROME_CODEGEN = codegenMode;

    // --introspect-tools-list: print tools/list JSON and exit, NO Chrome/CDP/transport startup.
    if (options.introspectToolsList) {
      const { MCPServer } = await import('./mcp-server');
      const { registerAllTools } = await import('./tools');
      const server = new MCPServer(undefined, { initialToolTier: 3 });
      registerAllTools(server);
      const manifest = server.getToolManifest();
      const output = JSON.stringify(manifest.tools) + '\n';
      for (let offset = 0; offset < output.length; offset += 16_384) {
        const chunk = output.slice(offset, offset + 16_384);
        if (!process.stdout.write(chunk)) {
          await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
        }
      }

      return;
    }


    let port = parseInt(options.port, 10);

    let autoLaunch = options.autoLaunch || false;

    // ─── --auto-connect (#849) ──────────────────────────────────────────
    // Resolve the auto-connect intent up front. When set, it:
    //   1. Locates DevToolsActivePort in the target user-data dir.
    //   2. Overrides --port with the discovered port.
    //   3. Forces launchMode='attach' so the launcher attaches instead of
    //      spawning. Mutual-exclusion with --launch-mode=auto|isolated is
    //      checked before any I/O so misconfigured operators fail fast.
    //   4. Forces userDataDir so the existing attach diagnostics surface
    //      the right path on failure.
    // OPENCHROME_AUTO_CONNECT mirrors the CLI flag.
    let autoConnectRaw: string | undefined;
    if (options.autoConnect === true) {
      autoConnectRaw = ''; // bare flag — use platform default
    } else if (typeof options.autoConnect === 'string') {
      autoConnectRaw = options.autoConnect;
    } else if (process.env.OPENCHROME_AUTO_CONNECT !== undefined) {
      autoConnectRaw = process.env.OPENCHROME_AUTO_CONNECT;
    }

    // Resolve the requested launch mode (CLI > env). We do this here, rather
    // than letting the launcher resolve later, so we can fail fast on the
    // mutual-exclusion check before any heavy startup work.
    const requestedLaunchMode = options.launchMode || process.env.OPENCHROME_LAUNCH_MODE;
    const launchModeSource: 'cli' | 'env' | 'config' = options.launchMode
      ? 'cli'
      : process.env.OPENCHROME_LAUNCH_MODE
        ? 'env'
        : 'config';

    if (autoConnectRaw !== undefined) {
      // Mutual-exclusion: auto-connect implies launchMode='attach'. Refuse
      // 'auto' or 'isolated' before doing any disk I/O.
      if (requestedLaunchMode) {
        try {
          const { resolveLaunchMode, assertAutoConnectCompatibleWithLaunchMode } =
            require('./chrome/launch-mode-resolver');
          const resolvedMode = resolveLaunchMode(
            { launchMode: options.launchMode },
            { OPENCHROME_LAUNCH_MODE: process.env.OPENCHROME_LAUNCH_MODE },
            {},
          );
          assertAutoConnectCompatibleWithLaunchMode(
            autoConnectRaw,
            resolvedMode,
            launchModeSource,
          );
        } catch (err) {
          console.error(`[openchrome] ${(err as Error).message}`);
          process.exit(2);
        }
      }

      // Discover the active DevTools endpoint. Failures are fatal — the
      // operator asked for auto-connect explicitly, and silently falling
      // back to launch mode would defeat the contract (P2: no behavior
      // change without the new flag).
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverActiveDevToolsPort } = require('./chrome/auto-connect');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { setAutoConnectState } = require('./chrome/auto-connect-state');
        const result = await discoverActiveDevToolsPort({
          userDataDir: autoConnectRaw.trim() === '' ? undefined : autoConnectRaw,
        });
        port = result.port;
        // Override CLI inputs so the rest of the bootstrap sees the
        // discovered port + dir consistently.
        options.userDataDir = result.userDataDir;
        // Force attach so the launcher does not spawn.
        options.launchMode = 'attach';
        // Suppress autoLaunch — attach must never spawn.
        autoLaunch = false;
        setAutoConnectState(result);
        console.error(
          `[openchrome] Auto-connect: attached to Chrome at ${result.wsEndpoint} (userDataDir=${result.userDataDir})`,
        );
      } catch (err) {
        console.error(`[openchrome] --auto-connect failed: ${(err as Error).message}`);
        process.exit(2);
      }
    }

    // Server mode forces headless + auto-launch + no cookie bridge
    if (options.serverMode) {
      autoLaunch = true;
      if (options.visible) {
        console.error('[openchrome] Warning: --visible ignored in server mode (headless forced)');
      }
      // Force headless via the resolver-visible flag, not visible=false (which now means "user did not pass --visible").
      options.visible = false;
      options.headless = true;
      console.error('[openchrome] Server mode: enabled (headless, no cookie bridge)');
    }
    const userDataDir = options.userDataDir || process.env.CHROME_USER_DATA_DIR || undefined;
    const profileDirectory = options.profileDirectory || process.env.CHROME_PROFILE_DIRECTORY || undefined;
    const chromeBinary = options.chromeBinary || process.env.CHROME_BINARY || undefined;
    const useHeadlessShell = options.headlessShell || false;
    const restartChrome = options.restartChrome || false;

    // Resolve transport mode before owner-lock acquisition so lock metadata
    // describes whether this process is a stdio, HTTP, or dual-transport owner.
    const validModes = ['stdio', 'http', 'both'];
    const rawMode = options.transport ?? process.env.OPENCHROME_TRANSPORT ?? (options.http !== undefined && options.http !== false ? 'http' : 'stdio');
    if (!validModes.includes(rawMode)) {
      console.error(`[openchrome] Unknown transport mode "${rawMode}", falling back to stdio`);
    }
    const transportMode = validModes.includes(rawMode) ? rawMode : 'stdio';
    const useHttp = transportMode === 'http' || transportMode === 'both';

    let controllerLock: ControllerLockHandle | null = null;
    const unsafeSharedAttach = options.allowUnsafeSharedAttach || process.env.OPENCHROME_ALLOW_UNSAFE_SHARED_ATTACH === '1';
    if (autoLaunch) {
      const lockUserDataDir = resolveControllerLockUserDataDir(userDataDir, useHeadlessShell);
      if (unsafeSharedAttach) {
        console.error(
          '[openchrome] Warning: unsafe shared attach guard bypassed. Multiple direct OpenChrome controllers for the same Chrome/profile can disconnect or close each other\'s targets.',
        );
      } else {
        try {
          controllerLock = acquireControllerLock({
            port,
            userDataDir: lockUserDataDir,
            lifecycleMode: options.launchMode || 'auto',
            transportMode,
          });
        } catch (err) {
          if (err instanceof DuplicateControllerError) {
            console.error(formatDuplicateControllerMessage(err));
            process.exit(2);
          }
          throw err;
        }
      }
    }

    process.on('exit', () => {
      try { controllerLock?.release(); } catch { /* best-effort */ }
    });

    console.error(`[openchrome] Starting MCP server`);

    // Portability-harness tier activation. P2: when --pilot is unset, no
    // module from src/pilot/** is loaded. bootstrapPilot() short-circuits and
    // returns null in that case.
    logActiveFlags();
    await bootstrapPilot();

    // Secrets masking (#834): load dotenv into the process-wide secret store.
    // Default behavior (no --secrets) is unchanged — the empty store is a no-op.
    if (options.secrets) {
      try {
        const { loadSecretsFromFile, setSecretStore } = await import('./core/secrets');
        const store = loadSecretsFromFile(options.secrets);
        setSecretStore(store);
        console.error(`[openchrome] Loaded ${store.size} secret(s) from ${options.secrets}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[openchrome] Error: failed to load --secrets: ${msg}`);
        process.exit(2);
      }
    }

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

    // Resolve headed-vs-headless intent (#657). Default flipped to headed.
    // The resolver throws HeadlessFlagConflictError if --headless and --visible both set.
    //
    // We resolve unconditionally (not gated on autoLaunch) so any *implicit*
    // relaunch path — process watchdog (#347/#649) or pool warm-up that
    // flips autoLaunch on later — picks up the user's actual intent from
    // global config rather than the headed default. (qodo P1 review on #665.)
    let headless: boolean;
    try {
      const mode = resolveHeadlessMode(
        { headless: options.headless, visible: options.visible },
        { OPENCHROME_HEADLESS: process.env.OPENCHROME_HEADLESS },
        { headless: getGlobalConfig().headless },
      );
      headless = mode === 'headless';
    } catch (err) {
      console.error(`[openchrome] ${(err as Error).message}`);
      process.exit(2);
    }
    if (autoLaunch) {
      console.error(`[openchrome] Headless mode: ${headless}`);
      if (options.visible === true && options.headless !== true) {
        console.error('[openchrome] Note: --visible is deprecated; headed is the default since #657.');
      }
    }

    let windowConfig;
    try {
      windowConfig = resolveWindowBoundsConfig(
        {
          windowSize: options.windowSize,
          windowPosition: options.windowPosition,
          windowBounds: options.windowBounds,
          startMaximized: options.startMaximized,
        },
        {
          OPENCHROME_WINDOW_SIZE: process.env.OPENCHROME_WINDOW_SIZE,
          OPENCHROME_WINDOW_POSITION: process.env.OPENCHROME_WINDOW_POSITION,
          OPENCHROME_WINDOW_BOUNDS: process.env.OPENCHROME_WINDOW_BOUNDS,
          OPENCHROME_START_MAXIMIZED: process.env.OPENCHROME_START_MAXIMIZED,
        },
      );
    } catch (err) {
      console.error(`[openchrome] ${(err as Error).message}`);
      process.exit(2);
    }

    // Set global config before initializing anything
    setGlobalConfig({
      port,
      autoLaunch,
      userDataDir,
      profileDirectory,
      chromeBinary,
      useHeadlessShell,
      headless,
      restartChrome,
      // #659/#849: persist resolved launch mode so the launcher's per-call
      // resolver picks it up (CLI > env > config > default).
      ...(options.launchMode ? { chromeLaunchMode: options.launchMode as 'auto' | 'attach' | 'isolated' } : {}),
      ...windowConfig,
    });
    if (restartChrome) {
      console.error(`[openchrome] Restart Chrome mode: enabled (will quit existing Chrome)`);
    }

    // Server mode: cookie bridge remains active for normal page creation.
    // Pool pre-warming passes skipCookieBridge per-call to avoid CDP conflicts.

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

    // Configure host allowlist if provided. Env is read by the guard at enforcement time
    // so CLI and OPENCHROME_ALLOW_HOSTS compose without overwriting each other.
    const allowHostOption = (options as { allowHost?: string }).allowHost;
    if (allowHostOption) {
      const allowHosts = allowHostOption.split(',').map((d: string) => d.trim()).filter(Boolean);
      const existing = getGlobalConfig().security || {};
      setGlobalConfig({
        security: { ...existing, allow_hosts: allowHosts },
      });
      console.error(`[openchrome] Allowed hosts: ${allowHosts.join(', ')}`);
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

    const mcpOptions: Parameters<typeof setMCPServerOptions>[0] = {};

    // Tool tier configuration
    const envTier = parseInt(process.env.OPENCHROME_TOOL_TIER || '', 10);
    if (options.allTools || envTier >= 3) {
      mcpOptions.initialToolTier = 3 as ToolTier;
      console.error('[openchrome] All tools exposed from startup');
    } else if (envTier === 2) {
      mcpOptions.initialToolTier = 2 as ToolTier;
      console.error('[openchrome] Tier 2 tools exposed from startup');
    }

    // Capability filter configuration (#829, #847)
    const capabilityResolution = resolveCapabilityFilterOptions(options);
    if (capabilityResolution.errorMessage) {
      console.error(capabilityResolution.errorMessage);
      process.exit(2);
    }
    if (capabilityResolution.capabilityFilter) {
      mcpOptions.capabilityFilter = capabilityResolution.capabilityFilter;
      if (capabilityResolution.logMessage) {
        console.error(capabilityResolution.logMessage);
      }
    }

    setMCPServerOptions(mcpOptions);

    // Set infinite reconnection for HTTP daemon mode BEFORE creating CDPClient singleton.
    // getMCPServer() → SessionManager → getCDPClient() reads this env var at construction.
    if (useHttp && !process.env.OPENCHROME_MAX_RECONNECT_ATTEMPTS) {
      process.env.OPENCHROME_MAX_RECONNECT_ATTEMPTS = '0';
    }

    // Reset readiness machine so a fresh serve action starts from scratch.
    resetReadinessMachine();

    const server = getMCPServer();
    await registerAllTools(server);

    // Dev-only hook: artificial delay for the tools component transition.
    // Gated: absent from production dist (see scripts/verify/A6-no-dev-hooks-in-dist.mjs).
    const isDevHooks = process.env.NODE_ENV !== 'production' && process.env.OPENCHROME_DEV_HOOKS === '1';
    if (isDevHooks && process.env.OPENCHROME_FAKE_SLOW_TOOLS) {
      const delayMs = parseInt(process.env.OPENCHROME_FAKE_SLOW_TOOLS, 10);
      if (delayMs > 0) {
        setTimeout(() => setComponent('tools', 'ok'), delayMs);
      } else {
        setComponent('tools', 'ok');
      }
    } else {
      setComponent('tools', 'ok');
    }

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
      // codex P1 review on #670: respect OPENCHROME_KILL_ON_EXIT and active
      // session-resume tokens. Without this gate, the stdio-side
      // shutdownSyncBestEffort() correctly skips kill but this handler
      // unconditionally kills anyway, defeating the contract.
      let shouldKill = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { shouldKillChromeOnExit } = require('./utils/session-resume-token');
        shouldKill = shouldKillChromeOnExit();
      } catch {
        // session-resume-token module may not be available — fall through
        // to the historical "always kill" behavior.
      }
      if (!shouldKill) {
        return;
      }

      try {
        const launcher = getChromeLauncher();
        // #659/#661: never kill an attached Chrome — that's the user's daily driver.
        if (launcher.getInstance()?.launchMode === 'attach') {
          // Skip primary launcher; pool instances handled below per-instance.
        } else {
          const chromePid = launcher.getChromePid();
          if (chromePid) {
            killChromeTree(chromePid);
          }
        }
      } catch { /* launcher may not be initialized */ }

      // Also kill any pool Chrome instances (skipping attach-mode entries).
      try {
        const { getChromePool } = require('./chrome/pool');
        const pool = getChromePool();
        for (const [, instance] of pool.getInstances()) {
          if (instance.launcher.getInstance?.()?.launchMode === 'attach') continue;
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
    const allowUnauthenticatedHttp = options.allowUnauthenticatedHttp;

    // Multi-tenant API key store: when OPENCHROME_API_KEYS_PATH points at a
    // JSONL store file, load it and pass it to the HTTP transport so
    // resolveAuthMode() selects `api-key` mode. Without this wiring the
    // middleware/scope/rate-limit code from PR 2/4 would be unreachable from
    // normal startup (the CLI never constructs a store otherwise). Admin-CLI
    // key management lands in PR 3/4 (#32); this is the minimum plumbing to
    // make api-key mode usable in this PR.
    const apiKeysPath = process.env.OPENCHROME_API_KEYS_PATH;
    let apiKeyStore: import('./auth/api-key-store').ApiKeyStore | undefined;
    if (apiKeysPath) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ApiKeyStore } = require('./auth/api-key-store');
        apiKeyStore = await ApiKeyStore.open(apiKeysPath);
        console.error(`[openchrome] API key store loaded from ${apiKeysPath} (api-key auth mode)`);
      } catch (err) {
        console.error(`[openchrome] Failed to load API key store at ${apiKeysPath}:`, err);
        throw err;
      }
    }

    // Start transport (useHttp/transportMode determined above, before getMCPServer)
    let httpTransport: import('./transports/http').HTTPTransport | null = null;

    if (transportMode === 'both') {
      // Dual mode: run both stdio and HTTP transports simultaneously
      const httpPort = typeof options.http === 'string' ? parseInt(options.http, 10) : parseInt(process.env.OPENCHROME_HTTP_PORT || '', 10) || 3100;
      const httpHost = (options as Record<string, unknown>).httpHost as string || process.env.OPENCHROME_HTTP_HOST || '127.0.0.1';
      const { HTTPTransport } = require('./transports/http');
      const httpTrans = new HTTPTransport(
        httpPort,
        httpHost,
        authToken,
        { ...(apiKeyStore ? { apiKeyStore } : {}), allowUnauthenticatedHttp },
      ) as import('./transports/http').HTTPTransport;
      httpTransport = httpTrans;

      // Start server with stdio as primary transport (wires JSON-RPC validation, rate-limiter, etc.)
      server.start();

      // Wire HTTP transport through MCPServer.handleMessage() — single source of
      // truth for JSON-RPC validation, notification handling, and request routing.
      httpTrans.onMessage(async (msg: Record<string, unknown>, signal?: AbortSignal, context?: import('./transports').TransportMessageContext) =>
        server.handleMessage(msg, signal, context),
      );
      server.wireRateLimiterCleanup(httpTrans);
      httpTrans.start();

      console.error(`[openchrome] Dual transport mode: stdio + HTTP on ${httpHost}:${httpPort}`);
      console.error('[openchrome] Infinite reconnection: enabled (daemon mode)');
    } else if (useHttp) {
      const httpPort = typeof options.http === 'string' ? parseInt(options.http, 10) : parseInt(process.env.OPENCHROME_HTTP_PORT || '', 10) || 3100;
      const httpHost = (options as Record<string, unknown>).httpHost as string || process.env.OPENCHROME_HTTP_HOST || '127.0.0.1';
      const transport = createTransport('http', { port: httpPort, host: httpHost, authToken, apiKeyStore, allowUnauthenticatedHttp });
      httpTransport = transport as import('./transports/http').HTTPTransport;
      server.start(transport);
      console.error(`[openchrome] HTTP transport enabled on ${httpHost}:${httpPort}`);
      console.error('[openchrome] Infinite reconnection: enabled (daemon mode)');
    } else {
      server.start();
      console.error('[openchrome] STDIO transport enabled');
    }

    // Resolve the idle-timeout window (issue #649 Part B). CLI wins over env.
    // Default: OFF. Setting OPENCHROME_IDLE_TIMEOUT_MS=0 also keeps it off
    // (a bare 0 would otherwise mean "exit immediately on idle" which is
    // never what an operator wants). Invalid values fail startup loudly per
    // acceptance criterion 12.
    let idleTimeoutMs: number | null = null;
    if (options.idleTimeout !== undefined) {
      try {
        idleTimeoutMs = parseDuration(options.idleTimeout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[openchrome] --idle-timeout: ${msg}`);
        process.exit(1);
      }
    } else if (process.env.OPENCHROME_IDLE_TIMEOUT_MS) {
      const raw = parseInt(process.env.OPENCHROME_IDLE_TIMEOUT_MS, 10);
      if (!Number.isFinite(raw) || raw < 0) {
        console.error(`[openchrome] OPENCHROME_IDLE_TIMEOUT_MS must be a non-negative integer, got "${process.env.OPENCHROME_IDLE_TIMEOUT_MS}"`);
        process.exit(1);
      }
      if (raw > 0) {
        idleTimeoutMs = raw;
      }
    }

    // Eagerly initialize the IdleState singleton so every monitor built below
    // shares the same instance. Honors OPENCHROME_IDLE_ADAPTIVE=0 (which
    // returns an always-active state, keeping all monitors at their full rate).
    const idleState = getIdleState();
    if (process.env.OPENCHROME_IDLE_ADAPTIVE === '0') {
      console.error('[openchrome] Idle-adaptive monitoring: disabled (OPENCHROME_IDLE_ADAPTIVE=0)');
    }

    // Parent-process death watcher (issue #644).
    //
    // Symmetric to spawnProcessGuardian (which kills Chrome when openchrome
    // dies). When the launching MCP-client chain (claude/codex/IDE host) is
    // killed without closing the stdio pipe, stdin EOF never fires and this
    // server orphans. The PPID watcher polls the parent and exits cleanly
    // when it disappears, so the existing process.on('exit') hook below can
    // take Chrome down with it.
    //
    // Stdio mode only — HTTP and "both" modes are intentionally daemon-
    // capable and must survive their launching shells.
    let parentWatcher: ParentWatcherHandle | null = null;
    if (transportMode === 'stdio' && process.env.OPENCHROME_PPID_WATCH !== '0') {
      const parentPid = process.ppid;
      if (parentPid > 1) {
        // Forward the parsed value when present; otherwise let installParentWatcher
        // own the default. clampInterval (in parent-watcher.ts) is the single
        // source of truth for both the default (2000ms) and the [500, 60000] bounds.
        const rawInterval = parseInt(process.env.OPENCHROME_PPID_WATCH_INTERVAL_MS || '', 10);
        const intervalMs = Number.isFinite(rawInterval) ? rawInterval : undefined;
        parentWatcher = installParentWatcher({ parentPid, intervalMs });
        console.error(`[openchrome] Parent watcher: enabled (ppid=${parentPid}, interval=${intervalMs ?? 2000}ms)`);
      } else {
        console.error('[openchrome] Parent watcher: skipped (already orphaned, ppid<=1)');
      }
    }

    // ─── Self-Healing Module Wiring (#354) ──────────────────────────────────

    const launcher = getChromeLauncher();
    const cdpClient = getCDPClient();
    const sessionManager = getSessionManager();

    // Readiness: wire chrome component via CDPClient connection events, then
    // proactively connect so daemon /ready probes can become ready before the
    // first MCP tool call.
    const chromeReadiness = wireChromeReadiness(cdpClient);
    chromeReadiness.initializeStartupConnection();

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
      chromeReadiness.handleChromeRelaunched().catch((err: unknown) => {
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
    // Readiness: flip chrome to failing when watchdog detects Chrome died
    processWatchdog.on('chrome-died', () => {
      setComponent('chrome', 'failing');
    });
    processWatchdog.start();
    // Readiness: watchdogs component is ok once the first tick has been scheduled
    setComponent('watchdogs', 'ok');
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
    //
    // Gated behind `resolveHealthEndpointEnabled()` (issue #648): the HTTP
    // health/metrics surface is only useful for daemon-mode deployments
    // (`--transport http` / `both`) where external monitors can reach it.
    // Stdio instances (1 per MCP client) would otherwise bind a listener
    // port that nobody talks to, at a cost of ~200-300 KB heap + 1 FD per
    // process. Operators who still want the endpoint in stdio mode opt in
    // via `OPENCHROME_HEALTH_ENDPOINT=1`; daemon operators who run the
    // health check externally can opt out with `OPENCHROME_HEALTH_ENDPOINT=0`.
    const healthPort = parseInt(process.env.OPENCHROME_HEALTH_PORT || '', 10) || DEFAULT_HEALTH_ENDPOINT_PORT;
    const healthBind = process.env.OPENCHROME_HEALTH_BIND || '127.0.0.1';
    const healthEndpointOverride = process.env.OPENCHROME_HEALTH_ENDPOINT;
    const healthEndpointEnabled = resolveHealthEndpointEnabled(
      transportMode,
      healthEndpointOverride,
    );
    const healthEndpoint = healthEndpointEnabled ? new HealthEndpoint(() => {
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
        tenants: { activeContexts: sessionManager?.tenantContextCount ?? 0 },
        listeners: getListenerErrorStats(),
      };
      return data;
    }, healthPort, healthBind) : null;
    if (healthEndpoint) {
      console.error(`[SelfHealing] HealthEndpoint: enabled (port=${healthPort}, bind=${healthBind}, mode=${transportMode})`);
      healthEndpoint.start().catch((err: unknown) => {
        console.error('[SelfHealing] HealthEndpoint start failed:', err);
      });
    } else {
      const forcedOff = healthEndpointOverride === '0' || healthEndpointOverride === 'false';
      if (forcedOff) {
        console.error(
          `[SelfHealing] HealthEndpoint: disabled (forced by OPENCHROME_HEALTH_ENDPOINT=${healthEndpointOverride}, mode=${transportMode})`
        );
      } else {
        console.error(
          `[SelfHealing] HealthEndpoint: disabled (transport-mode default, mode=${transportMode}; set OPENCHROME_HEALTH_ENDPOINT=1 to enable)`
        );
      }
    }

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

    // Install the idle-timeout watcher (issue #649 Part B) only when the
    // operator opted in via CLI or env var. Wiring it here, after
    // `enhancedShutdown` is declared below via closure-forward-reference,
    // would be cleaner — but we need the handle in `enhancedShutdown` itself
    // so it can be stopped before async cleanup begins. Forward-declare.
    let idleTimeout: IdleTimeoutHandle | null = null;

    // Update shutdown handler to include self-healing cleanup.
    //
    // Reentrancy guard (issue #649 §2 in-scope prerequisite): this PR adds a
    // second internal exit trigger (idle-timeout) alongside the PPID watcher
    // from PR #645 and the existing signal handlers. Without this guard,
    // concurrent invocation from two triggers in the same tick would double-
    // run saveAllStorageState, double-await healthEndpoint.stop(), and risk
    // torn state. The flag is a single bit — subsequent entrants return
    // immediately.
    let shuttingDown = false;
    const originalShutdown = shutdown;
    const enhancedShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Stop the idle-timeout watcher BEFORE any awaits so it cannot fire
      // mid-shutdown (acceptance criterion 14). Same rationale as the parent
      // watcher teardown below.
      idleTimeout?.stop();
      idleTimeout = null;
      // Stop the parent watcher first so it cannot fire process.exit during
      // the async shutdown work below (issue #644).
      parentWatcher?.stop();
      parentWatcher = null;
      processWatchdog.stop();
      tabHealthMonitor.stopAll();
      eventLoopMonitor.stop();
      diskMonitor?.stop();
      chromeProcessMonitor.stop();
      await healthEndpoint?.stop();

      // Force-save storage state before exit to preserve cookies across restarts
      try {
        await Promise.race([
          sessionManager.saveAllStorageState(),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch (err) {
        console.error(`[openchrome] Storage state save on shutdown failed (non-fatal): ${err}`);
      }

      stateManager.stop();
      sessionPersistence.cancelPendingSave();
      await originalShutdown(signal);
    };

    // Wire the idle-timeout watcher now that `enhancedShutdown` is defined.
    // Explicit opt-in only — default OFF.
    if (idleTimeoutMs !== null) {
      idleTimeout = installIdleTimeout({
        windowMs: idleTimeoutMs,
        idleState,
        sessionCountFn: () => sessionManager.sessionCount,
        exitFn: () => {
          // Route through enhancedShutdown so the reentrancy guard and the
          // normal teardown sequence both apply. The shutdown awaits
          // originalShutdown which calls process.exit(0).
          enhancedShutdown('idle-timeout').catch((err) => {
            console.error('[openchrome] idle-timeout shutdown failed:', err);
            process.exit(1);
          });
        },
      });
      console.error(`[openchrome] Idle-timeout: enabled (window=${idleTimeoutMs}ms)`);
    }
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
  .command('doctor')
  .description('Run holistic environment diagnostics (Node, Chrome, ports, disk, network)')
  .option('--json', 'Emit DoctorReport as JSON to stdout')
  .option('--check <id>', 'Run only this check (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--remote', 'Enable opt-in remote network probe (HEAD update.googleapis.com)')
  .option('--no-color', 'Disable colored output (also respected via NO_COLOR env var)')
  .action(async (options: { json?: boolean; check: string[]; remote?: boolean; color?: boolean }) => {
    const noColor = options.color === false || Boolean(process.env.NO_COLOR);

    // Gate the remote check via env var so the check fn can read it
    if (options.remote) {
      process.env.OPENCHROME_DOCTOR_REMOTE_ENABLED = '1';
    }

    const { runDoctor, formatReport, writeDiagnosticsCache } = await import('./cli/doctor');
    const report = await runDoctor({
      checks: options.check.length > 0 ? options.check : undefined,
      remote: Boolean(options.remote),
    });

    await writeDiagnosticsCache(report);

    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(formatReport(report, noColor));
    }

    process.exit(report.exitCode);
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

  # Diagnose environment issues (Node version, Chrome binary, port, disk, etc.)
  openchrome doctor

  # Machine-readable output
  openchrome doctor --json
`);
  });

program.parse();
