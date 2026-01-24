#!/usr/bin/env node
/**
 * CLI Entry Point for claude-chrome-parallel
 * MCP Server for parallel Claude Code browser sessions
 *
 * Architecture:
 * - Master mode: Holds Chrome connection, manages all sessions centrally
 * - Worker mode: MCP server for Claude Code, connects to Master via IPC
 */

import { Command } from 'commander';
import { getMCPServer } from './mcp-server';
import { registerAllTools } from './tools';
import { startMaster } from './master';
import { startWorker } from './worker';
import { WorkerMCPServer } from './worker/worker-mcp-server';
import { registerWorkerTools } from './worker/tools';
import { isMasterRunning } from './worker/auto-master';

const program = new Command();

program
  .name('claude-chrome-parallel')
  .description('MCP server for parallel Claude Code browser sessions')
  .version('2.0.0');

program
  .command('serve')
  .description('Start the MCP server')
  .option('-p, --port <port>', 'Chrome remote debugging port', '9222')
  .option('--master', 'Run as master process (holds Chrome connection)')
  .option('--standalone', 'Run in standalone mode (no master/worker, direct Chrome connection)')
  .action(async (options) => {
    const port = parseInt(options.port, 10);

    if (options.master) {
      // Master mode - manages Chrome connection and all sessions
      console.error(`[claude-chrome-parallel] Starting as MASTER process`);
      console.error(`[claude-chrome-parallel] Chrome debugging port: ${port}`);
      await startMaster(port);
    } else if (options.standalone) {
      // Standalone mode - original behavior, direct Chrome connection
      console.error(`[claude-chrome-parallel] Starting in STANDALONE mode`);
      console.error(`[claude-chrome-parallel] Chrome debugging port: ${port}`);

      const server = getMCPServer();
      registerAllTools(server);
      server.start();
    } else {
      // Worker mode - connects to Master, default behavior
      console.error(`[claude-chrome-parallel] Starting as WORKER process`);

      try {
        // Start worker and connect to master
        const sessionManager = await startWorker();

        // Create Worker MCP Server with remote session manager
        const workerServer = new WorkerMCPServer(sessionManager);
        registerWorkerTools(workerServer);
        workerServer.start();
      } catch (error) {
        console.error(`[claude-chrome-parallel] Failed to start worker:`, error);
        console.error(`[claude-chrome-parallel] Falling back to standalone mode...`);

        // Fallback to standalone mode
        const server = getMCPServer();
        registerAllTools(server);
        server.start();
      }
    }
  });

program
  .command('master')
  .description('Start master process only')
  .option('-p, --port <port>', 'Chrome remote debugging port', '9222')
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    console.error(`[claude-chrome-parallel] Starting MASTER process`);
    console.error(`[claude-chrome-parallel] Chrome debugging port: ${port}`);
    await startMaster(port);
  });

program
  .command('check')
  .description('Check Chrome and Master status')
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

    // Check Master
    const masterRunning = await isMasterRunning();
    console.log(`\nMaster process: ${masterRunning ? '✓ Running' : '✗ Not running'}`);

    console.log('\n=== Instructions ===\n');

    if (!chromeConnected) {
      console.log('1. Start Chrome with debugging enabled:');
      console.log(`   chrome --remote-debugging-port=${port}\n`);
    }

    if (!masterRunning) {
      console.log('2. (Optional) Start the Master process:');
      console.log('   claude-chrome-parallel serve --master');
      console.log('   Note: Workers will auto-start Master if needed.\n');
    }

    if (chromeConnected) {
      console.log('You can now use claude-chrome-parallel as an MCP server.');
      console.log('\nAdd to your Claude Code MCP config:');
      console.log(JSON.stringify({
        "mcpServers": {
          "chrome-parallel": {
            "command": "npx",
            "args": ["claude-chrome-parallel", "serve"]
          }
        }
      }, null, 2));
    }

    process.exit(chromeConnected ? 0 : 1);
  });

program
  .command('info')
  .description('Show architecture information')
  .action(() => {
    console.log(`
=== Claude Chrome Parallel Architecture ===

This MCP server enables parallel Claude Code browser sessions without
"Detached" errors by using a Master-Worker architecture.

MODES:

1. Worker Mode (default):
   claude-chrome-parallel serve

   - Connects to Master process via IPC
   - Auto-starts Master if not running
   - Recommended for Claude Code integration

2. Master Mode:
   claude-chrome-parallel serve --master

   - Holds the single Chrome CDP connection
   - Manages all sessions centrally
   - Runs in background, workers connect to it

3. Standalone Mode:
   claude-chrome-parallel serve --standalone

   - Original behavior, direct Chrome connection
   - No Master/Worker, simpler but no parallelism
   - Use if Master/Worker has issues

ARCHITECTURE:

  ┌─────────────────────────────────────────┐
  │           Master Process                 │
  │  ┌─────────┐  ┌──────────────────┐      │
  │  │CDPClient│  │ SessionRegistry  │      │
  │  └─────────┘  └──────────────────┘      │
  │           IPC Server                     │
  └─────────────────┬───────────────────────┘
                    │ IPC (Named Pipe)
         ┌──────────┼──────────┐
         │          │          │
      Worker A   Worker B   Worker C
      (Claude 1) (Claude 2) (Claude 3)

USAGE:

  # Check status
  claude-chrome-parallel check

  # Start Master (optional, workers auto-start)
  claude-chrome-parallel serve --master

  # Configure Claude Code (uses Worker mode)
  Add to MCP config:
  {
    "chrome-parallel": {
      "command": "npx",
      "args": ["claude-chrome-parallel", "serve"]
    }
  }
`);
  });

program.parse();
