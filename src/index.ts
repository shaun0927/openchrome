#!/usr/bin/env node
/**
 * CLI Entry Point for claude-chrome-parallel
 * MCP Server for parallel Claude Code browser sessions
 *
 * Uses puppeteer-core to directly connect to Chrome DevTools Protocol,
 * enabling multiple Claude Code sessions to control Chrome simultaneously.
 */

import { Command } from 'commander';
import { getMCPServer } from './mcp-server';
import { registerAllTools } from './tools';
import { setGlobalConfig } from './config/global';

const program = new Command();

program
  .name('claude-chrome-parallel')
  .description('MCP server for parallel Claude Code browser sessions')
  .version('2.0.0');

program
  .command('serve')
  .description('Start the MCP server')
  .option('-p, --port <port>', 'Chrome remote debugging port', '9222')
  .option('--auto-launch', 'Auto-launch Chrome if not running (default: false)')
  .action(async (options: { port: string; autoLaunch?: boolean }) => {
    const port = parseInt(options.port, 10);
    const autoLaunch = options.autoLaunch || false;

    console.error(`[claude-chrome-parallel] Starting MCP server`);
    console.error(`[claude-chrome-parallel] Chrome debugging port: ${port}`);
    console.error(`[claude-chrome-parallel] Auto-launch Chrome: ${autoLaunch}`);

    // Set global config before initializing anything
    setGlobalConfig({ port, autoLaunch });

    const server = getMCPServer();
    registerAllTools(server);
    server.start();
  });

program
  .command('check')
  .description('Check Chrome connection status')
  .option('-p, --port <port>', 'Chrome remote debugging port', '9222')
  .action(async (options) => {
    const port = parseInt(options.port, 10);

    console.log('=== Claude Chrome Parallel Status ===\n');

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
      console.log('Or let claude-chrome-parallel auto-launch Chrome.\n');
    }

    if (chromeConnected) {
      console.log('Chrome is ready! Add to your Claude Code MCP config:\n');
      console.log(JSON.stringify({
        "mcpServers": {
          "chrome-parallel": {
            "command": "claude-chrome-parallel",
            "args": ["serve"]
          }
        }
      }, null, 2));
    }

    process.exit(chromeConnected ? 0 : 1);
  });

program
  .command('info')
  .description('Show how it works')
  .action(() => {
    console.log(`
=== Claude Chrome Parallel ===

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
  claude-chrome-parallel check

  # Start Chrome with debugging enabled (required unless --auto-launch)
  chrome --remote-debugging-port=9222

  # Add to ~/.claude/.mcp.json
  {
    "mcpServers": {
      "chrome-parallel": {
        "command": "claude-chrome-parallel",
        "args": ["serve"]
      }
    }
  }

  # Or with auto-launch (Chrome starts automatically)
  {
    "mcpServers": {
      "chrome-parallel": {
        "command": "claude-chrome-parallel",
        "args": ["serve", "--auto-launch"]
      }
    }
  }
`);
  });

program.parse();
