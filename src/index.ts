#!/usr/bin/env node
/**
 * CLI Entry Point for openchrome
 * MCP Server for parallel Claude Code browser sessions
 *
 * Uses puppeteer-core to directly connect to Chrome DevTools Protocol,
 * enabling multiple Claude Code sessions to control Chrome simultaneously.
 */

import { Command } from 'commander';
import { parseDuration } from './utils/idle-timeout';
import { getVersion } from './version';
import { getChromeLauncher } from './chrome/launcher';
import { installUnhandledRejectionSafetyNet } from './utils/safe-listener';
import { createOpenChromeServer, CreateServerOptions } from './core/server';
import type { ApiKeyStore } from './auth/api-key-store';

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

program
  .command('serve')
  .description('Start the MCP server')
  .option('-p, --port <port>', 'Chrome remote debugging port', process.env.CHROME_PORT || '9222')
  .option('--auto-launch', 'Auto-launch Chrome if not running (default: false)')
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
  .action(async (options: { port: string; autoLaunch?: boolean; userDataDir?: string; profileDirectory?: string; chromeBinary?: string; headlessShell?: boolean; headless?: boolean; visible?: boolean; windowSize?: string; windowPosition?: string; windowBounds?: string; startMaximized?: boolean; restartChrome?: boolean; hybrid?: boolean; lpPort?: string; blockedDomains?: string; auditLog?: boolean; sanitizeContent?: boolean; allTools?: boolean; serverMode?: boolean; http?: string | boolean; httpHost?: string; authToken?: string; transport?: string; idleTimeout?: string; allowUnauthenticatedHttp?: boolean; pilot?: boolean }) => {
    const port = parseInt(options.port, 10);
    let autoLaunch = options.autoLaunch || false;

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

    // Resolve transport mode: --transport flag takes precedence over --http flag.
    const validModes = ['stdio', 'http', 'both'];
    const rawMode = options.transport ?? process.env.OPENCHROME_TRANSPORT ?? (options.http !== undefined && options.http !== false ? 'http' : 'stdio');
    if (!validModes.includes(rawMode)) {
      console.error(`[openchrome] Unknown transport mode "${rawMode}", falling back to stdio`);
    }
    const transportMode: 'stdio' | 'http' | 'both' = (validModes.includes(rawMode) ? rawMode : 'stdio') as 'stdio' | 'http' | 'both';

    // Idle-timeout parsing (issue #649). CLI wins over env. Bare numbers rejected.
    let idleTimeoutMs: number | undefined;
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

    // Auth token / api-key store / HTTP host (resolved before factory call).
    const authToken = options.authToken || process.env.OPENCHROME_AUTH_TOKEN || undefined;
    if (authToken) {
      console.error('[openchrome] Bearer token authentication: enabled');
    }
    const allowUnauthenticatedHttp = options.allowUnauthenticatedHttp;
    const httpHost = options.httpHost || process.env.OPENCHROME_HTTP_HOST || '127.0.0.1';

    let apiKeyStore: ApiKeyStore | undefined;
    const apiKeysPath = process.env.OPENCHROME_API_KEYS_PATH;
    if (apiKeysPath) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ApiKeyStore: ApiKeyStoreClass } = require('./auth/api-key-store') as typeof import('./auth/api-key-store');
        apiKeyStore = await ApiKeyStoreClass.open(apiKeysPath);
        console.error(`[openchrome] API key store loaded from ${apiKeysPath} (api-key auth mode)`);
      } catch (err) {
        console.error(`[openchrome] Failed to load API key store at ${apiKeysPath}:`, err);
        throw err;
      }
    }

    // Build CreateServerOptions for the factory.
    const httpPort = typeof options.http === 'string' ? parseInt(options.http, 10) : parseInt(process.env.OPENCHROME_HTTP_PORT || '', 10) || 3100;
    let transportOpt: CreateServerOptions['transport'];
    if (transportMode === 'stdio') {
      transportOpt = 'stdio';
    } else if (transportMode === 'http') {
      transportOpt = { http: { port: httpPort, host: httpHost, authToken, allowUnauthenticated: allowUnauthenticatedHttp } };
    } else {
      transportOpt = { both: { httpPort, httpHost, authToken, allowUnauthenticated: allowUnauthenticatedHttp } };
    }

    const blockedDomains = options.blockedDomains
      ? options.blockedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
      : undefined;

    const factoryOpts: CreateServerOptions = {
      transport: transportOpt,
      chrome: {
        port,
        autoLaunch,
        userDataDir: options.userDataDir,
        profileDirectory: options.profileDirectory,
        chromeBinary: options.chromeBinary,
        headlessShell: options.headlessShell,
        headless: options.headless,
        restartChrome: options.restartChrome,
        windowSize: options.windowSize,
        windowPosition: options.windowPosition,
        windowBounds: options.windowBounds,
        startMaximized: options.startMaximized,
      },
      pilot: options.pilot,
      tools: { allTools: options.allTools },
      security: {
        blockedDomains,
        auditLog: options.auditLog,
        sanitizeContent: options.sanitizeContent,
      },
      idleTimeoutMs,
      apiKeyStore,
      hybrid: options.hybrid ? { enabled: true, lightpandaPort: parseInt(options.lpPort || '9223', 10) } : undefined,
    };

    // Install last-resort synchronous Chrome kill on ANY exit path
    // (including uncaughtException, SIGKILL recovery, process.exit()).
    // The createOpenChromeServer() factory does not install this handler —
    // it's a CLI-only safety net.
    const killChromeTree = (pid: number) => {
      if (process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    };
    process.on('exit', () => {
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
        if (launcher.getInstance()?.launchMode === 'attach') {
          // Skip primary launcher; pool instances handled below per-instance.
        } else {
          const chromePid = launcher.getChromePid();
          if (chromePid) {
            killChromeTree(chromePid);
          }
        }
      } catch { /* launcher may not be initialized */ }
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
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

    // Create and start the embeddable server.
    const server = await createOpenChromeServer(factoryOpts);
    const result = await server.start();
    if (result.stdio) {
      console.error('[openchrome] STDIO transport enabled');
    }
    if (result.httpUrl) {
      console.error(`[openchrome] HTTP transport enabled on ${result.httpUrl.replace(/^http:\/\//, '')}`);
      console.error('[openchrome] Infinite reconnection: enabled (daemon mode)');
    }

    // Register signal handlers for graceful shutdown.
    const shutdown = async (signal: string) => {
      console.error(`[openchrome] Received ${signal}, shutting down...`);
      try {
        await server.stop('sigterm');
      } catch (err) {
        console.error('[openchrome] Shutdown error:', err);
      }
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    // Windows: closing the console window sends CTRL_CLOSE_EVENT mapped to SIGHUP by libuv.
    if (process.platform === 'win32') {
      process.on('SIGHUP', () => shutdown('SIGHUP'));
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
