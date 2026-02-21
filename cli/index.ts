#!/usr/bin/env node
/**
 * CLI for Claude Chrome Parallel
 *
 * Commands:
 * - install: Install extension and native messaging host
 * - uninstall: Remove extension and native messaging host
 * - serve: Start MCP server for Claude Code
 * - sessions: List or clear sessions
 * - launch: Start Claude Code with isolated config
 * - doctor: Check installation status
 * - recover: Recover corrupted .claude.json
 */

import { Command } from 'commander';
// Legacy imports - kept for backward compatibility but deprecated
// import { install, installNativeHost } from './install';
// import { uninstall } from './uninstall';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { checkForUpdates } from './update-check';

const program = new Command();

// Package info - from dist/cli/ go up two levels to root
const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
let version = '0.1.0';
try {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  version = packageJson.version;
} catch {
  // Use default version
}

program
  .name('openchrome')
  .description('MCP server for parallel Claude Code browser sessions via CDP')
  .version(version);

program
  .command('install')
  .description('[DEPRECATED] Extension install is no longer needed. Use CDP mode instead.')
  .option('-f, --force', 'Force reinstall even if already installed')
  .option('--extension-id <id>', 'Chrome extension ID (for native host configuration)')
  .action(async () => {
    console.log('⚠️  DEPRECATED: Extension installation is no longer needed.\n');
    console.log('Claude Chrome Parallel now uses CDP (Chrome DevTools Protocol) mode,');
    console.log('which does not require a Chrome extension.\n');
    console.log('Quick Start:');
    console.log('  1. Start Chrome with debugging port:');
    console.log('     chrome --remote-debugging-port=9222\n');
    console.log('  2. Add to ~/.claude.json:');
    console.log('     {');
    console.log('       "mcpServers": {');
    console.log('         "openchrome": {');
    console.log('           "command": "oc",');
    console.log('           "args": ["serve"]');
    console.log('         }');
    console.log('       }');
    console.log('     }\n');
    console.log('  3. Restart Claude Code\n');
    console.log('Run "oc doctor" to verify your setup.');
  });

program
  .command('uninstall')
  .description('[DEPRECATED] No longer needed - CDP mode has no extension to uninstall')
  .action(async () => {
    console.log('⚠️  DEPRECATED: Uninstall is no longer needed.\n');
    console.log('Claude Chrome Parallel now uses CDP mode, which has no extension to uninstall.');
    console.log('Simply remove the MCP server config from ~/.claude.json if you want to disable it.');
  });

program
  .command('setup')
  .description('Automatically configure MCP server for Claude Code')
  .option('--dashboard', 'Enable terminal dashboard')
  .option('--auto-launch', 'Auto-launch Chrome if not running (default: true)')
  .option('-s, --scope <scope>', 'Installation scope: "user" (global, default) or "project" (current project only)', 'user')
  .action(async (options: { dashboard?: boolean; autoLaunch?: boolean; scope?: string }) => {
    const { execSync, spawnSync } = require('child_process');

    console.log('Setting up Claude Chrome Parallel for Claude Code...\n');

    // Check if claude CLI is available
    try {
      execSync('claude --version', { stdio: 'pipe' });
    } catch {
      console.error('❌ Claude Code CLI not found.');
      console.error('   Please install Claude Code first: https://claude.ai/code');
      process.exit(1);
    }

    // Validate scope
    const scope = options.scope || 'user';
    if (scope !== 'user' && scope !== 'project') {
      console.error('❌ Invalid scope. Use "user" (global) or "project" (current project only).');
      process.exit(1);
    }

    // Build the serve arguments
    const serveArgs = ['serve', '--auto-launch'];
    if (options.dashboard) {
      serveArgs.push('--dashboard');
    }

    // Remove existing configuration first (if any)
    try {
      execSync('claude mcp remove openchrome 2>/dev/null', { stdio: 'pipe' });
    } catch {
      // Ignore if not exists
    }

    // Use npx for auto-updates: every server start fetches the latest version
    const fullCommand = `claude mcp add openchrome -s ${scope} -- npx -y openchrome ${serveArgs.join(' ')}`;

    console.log(`Running: claude mcp add openchrome (scope: ${scope})...`);

    try {
      execSync(fullCommand, { stdio: 'inherit' });
      console.log('\n✅ MCP server configured successfully!\n');
      console.log(`Scope: ${scope === 'user' ? 'Global (all projects)' : 'Project (this directory only)'}\n`);
      console.log('Auto-updates: enabled (via npx)\n');
      console.log('Next steps:');
      console.log('  1. Restart Claude Code');
      console.log('  2. Just say "oc" — that\'s it.\n');
      console.log('Examples:');
      console.log('  "oc screenshot my Gmail"');
      console.log('  "use oc to check AWS billing"');
      console.log('  "oc search on naver.com"\n');
    } catch (error) {
      console.error('\n❌ Failed to configure MCP server.');
      console.error('   You can manually add to ~/.claude.json:');
      console.error('   {');
      console.error('     "mcpServers": {');
      console.error('       "openchrome": {');
      console.error('         "command": "npx",');
      console.error(`         "args": ["-y", "openchrome", ${serveArgs.map(a => `"${a}"`).join(', ')}]`);
      console.error('       }');
      console.error('     }');
      console.error('   }');
      process.exit(1);
    }

  });

program
  .command('serve')
  .description('Start MCP server for Claude Code')
  .option('-p, --port <port>', 'Chrome remote debugging port', '9222')
  .option('--auto-launch', 'Auto-launch Chrome if not running (default: false)')
  .option('--dashboard', 'Enable terminal dashboard for real-time monitoring')
  .option('--hybrid', 'Enable hybrid mode (Lightpanda + Chrome routing)')
  .option('--lp-port <port>', 'Lightpanda debugging port (default: 9223)', '9223')
  .action(async (options: { port: string; autoLaunch?: boolean; dashboard?: boolean; hybrid?: boolean; lpPort?: string }) => {
    const port = parseInt(options.port, 10);
    const autoLaunch = options.autoLaunch || false;
    const dashboard = options.dashboard || false;

    // Non-blocking update check (fires in background)
    checkForUpdates(version).catch(() => {});

    console.error(`[openchrome] Starting MCP server`);
    console.error(`[openchrome] Chrome debugging port: ${port}`);
    console.error(`[openchrome] Auto-launch Chrome: ${autoLaunch}`);
    console.error(`[openchrome] Dashboard: ${dashboard}`);

    // Import from built dist/ files (relative to dist/cli/)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setGlobalConfig } = require('../config/global');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getMCPServer, setMCPServerOptions } = require('../mcp-server');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerAllTools } = require('../tools');

    // Set global config before initializing anything
    setGlobalConfig({ port, autoLaunch });

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

    // Set MCP server options (including dashboard)
    setMCPServerOptions({ dashboard });

    const server = getMCPServer();
    registerAllTools(server);

    // Initialize hybrid routing if enabled
    if (hybrid) {
      const { getSessionManager } = require('../session-manager');
      const sm = getSessionManager();
      await sm.initHybrid({
        enabled: true,
        lightpandaPort: lpPort,
        circuitBreaker: { maxFailures: 3, cooldownMs: 60000 },
        cookieSync: { intervalMs: 5000 },
      });
    }

    server.start();
  });

program
  .command('sessions')
  .description('List or clear sessions')
  .option('--clear', 'Clear all inactive sessions')
  .action(async (options) => {
    console.log('Session management requires the extension to be running.');
    if (options.clear) {
      console.log('To clear sessions, use the extension popup.');
    } else {
      console.log('To view sessions, check the extension popup in Chrome.');
    }
  });

program
  .command('doctor')
  .description('Check installation status')
  .action(async () => {
    console.log('Checking installation status...\n');

    // Core checks (required for CDP mode)
    const coreChecks = {
      'Node.js version (>=18)': checkNodeVersion(),
      '.claude.json health': await checkClaudeConfigHealth(),
      'Chrome debugging port': await checkChromeDebugPort(),
    };

    console.log('Core Requirements:');
    for (const [name, passed] of Object.entries(coreChecks)) {
      const status = passed ? '✅' : '❌';
      console.log(`  ${status} ${name}`);
    }

    const allPassed = Object.values(coreChecks).every(Boolean);
    console.log();

    if (allPassed) {
      console.log('All checks passed! Ready to use with Claude Code.');
      console.log('\nUsage:');
      console.log('  1. Start Chrome with: chrome --remote-debugging-port=9222');
      console.log('  2. Add to ~/.claude.json:');
      console.log('     "mcpServers": { "openchrome": { "command": "oc", "args": ["serve"] } }');
      console.log('  3. Restart Claude Code');
    } else {
      if (!coreChecks['Chrome debugging port']) {
        console.log('Chrome is not running with debugging port.');
        console.log('Start Chrome with: chrome --remote-debugging-port=9222');
      }
      if (!coreChecks['.claude.json health']) {
        console.log('Run "openchrome recover" to fix .claude.json');
      }
    }
  });

program
  .command('launch')
  .description('Start Claude Code with isolated config (prevents corruption)')
  .option('--sync-back', 'Sync config changes back to original after session')
  .option('--keep-session', 'Keep session directory after exit (for debugging)')
  .argument('[args...]', 'Arguments to pass to claude')
  .action(async (args: string[], options: { syncBack?: boolean; keepSession?: boolean }) => {
    const sessionId = generateSessionId();
    const sessionDir = path.join(getSessionsDir(), sessionId);

    console.log(`Creating isolated session: ${sessionId}`);

    // Create session directory
    fs.mkdirSync(sessionDir, { recursive: true });

    // Copy existing .claude.json if it exists
    const originalConfig = path.join(os.homedir(), '.claude.json');
    const sessionConfig = path.join(sessionDir, '.claude.json');

    if (fs.existsSync(originalConfig)) {
      // Validate before copying
      const content = fs.readFileSync(originalConfig, 'utf8');
      if (isValidJson(content)) {
        fs.copyFileSync(originalConfig, sessionConfig);
        console.log('Copied existing config to session');
      } else {
        console.warn('Warning: Original .claude.json is corrupted, starting fresh');
        fs.writeFileSync(sessionConfig, '{}');
      }
    } else {
      fs.writeFileSync(sessionConfig, '{}');
    }

    // Create session metadata
    const metadata = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      originalHome: os.homedir(),
    };
    fs.writeFileSync(
      path.join(sessionDir, '.session-metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    console.log('Starting Claude Code with isolated config...\n');

    // Set up environment with isolated HOME
    const env = {
      ...process.env,
      HOME: sessionDir,
      USERPROFILE: sessionDir,
      CLAUDE_CONFIG_DIR: sessionDir,
    };

    // Find claude command
    const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';

    // Spawn claude with isolated environment
    const child = spawn(claudeCmd, args, {
      env,
      stdio: 'inherit',
      shell: true,
    });

    // Handle exit
    child.on('close', async (code) => {
      console.log(`\nClaude Code exited with code ${code}`);

      // Sync back if requested
      if (options.syncBack && fs.existsSync(sessionConfig)) {
        console.log('Syncing config back to original location...');
        const sessionContent = fs.readFileSync(sessionConfig, 'utf8');
        if (isValidJson(sessionContent)) {
          // Backup original first
          if (fs.existsSync(originalConfig)) {
            await createBackupFile(originalConfig);
          }
          fs.writeFileSync(originalConfig, sessionContent);
          console.log('Config synced successfully');
        } else {
          console.error('Session config is corrupted, not syncing back');
        }
      }

      // Cleanup session
      if (!options.keepSession) {
        console.log('Cleaning up session directory...');
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log('Session cleaned up');
      } else {
        console.log(`Session kept at: ${sessionDir}`);
      }

      process.exit(code ?? 0);
    });

    // Forward signals
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  });

program
  .command('recover')
  .description('Recover corrupted .claude.json')
  .option('--backup <name>', 'Restore from specific backup')
  .option('--list-backups', 'List available backups')
  .option('--force-new', 'Create new empty config (loses all data)')
  .action(async (options: { backup?: string; listBackups?: boolean; forceNew?: boolean }) => {
    const configPath = path.join(os.homedir(), '.claude.json');
    const backupDir = path.join(os.homedir(), '.openchrome', 'backups');

    // List backups
    if (options.listBackups) {
      console.log('Available backups:\n');
      if (!fs.existsSync(backupDir)) {
        console.log('No backups found');
        return;
      }
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('.claude.json.'))
        .sort()
        .reverse();

      if (backups.length === 0) {
        console.log('No backups found');
        return;
      }

      for (const backup of backups) {
        const stats = fs.statSync(path.join(backupDir, backup));
        console.log(`  ${backup} (${formatBytes(stats.size)})`);
      }
      return;
    }

    // Force new config
    if (options.forceNew) {
      if (fs.existsSync(configPath)) {
        await createBackupFile(configPath);
      }
      fs.writeFileSync(configPath, '{}');
      console.log('Created new empty .claude.json');
      console.log('Warning: All previous settings have been lost (backup created)');
      return;
    }

    // Restore from specific backup
    if (options.backup) {
      const backupPath = path.join(backupDir, options.backup);
      if (!fs.existsSync(backupPath)) {
        console.error(`Backup not found: ${options.backup}`);
        process.exit(1);
      }

      const content = fs.readFileSync(backupPath, 'utf8');
      if (!isValidJson(content)) {
        console.error('Selected backup is also corrupted');
        process.exit(1);
      }

      if (fs.existsSync(configPath)) {
        await createBackupFile(configPath);
      }
      fs.writeFileSync(configPath, content);
      console.log(`Restored from backup: ${options.backup}`);
      return;
    }

    // Auto-recover
    console.log('Checking .claude.json...\n');

    if (!fs.existsSync(configPath)) {
      console.log('No .claude.json found - nothing to recover');
      return;
    }

    const content = fs.readFileSync(configPath, 'utf8');

    if (isValidJson(content)) {
      console.log('✅ .claude.json is valid - no recovery needed');
      return;
    }

    console.log('❌ .claude.json is corrupted');
    console.log('Attempting recovery...\n');

    // Create backup
    const backup = await createBackupFile(configPath);
    console.log(`Backup created: ${backup}`);

    // Try to extract valid JSON
    const recovered = attemptJsonRecovery(content);
    if (recovered) {
      fs.writeFileSync(configPath, JSON.stringify(recovered, null, 2));
      console.log('✅ Successfully recovered .claude.json');
      return;
    }

    // Try to restore from backup
    if (fs.existsSync(backupDir)) {
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('.claude.json.'))
        .sort()
        .reverse();

      for (const backupFile of backups) {
        const backupContent = fs.readFileSync(path.join(backupDir, backupFile), 'utf8');
        if (isValidJson(backupContent)) {
          fs.writeFileSync(configPath, backupContent);
          console.log(`✅ Restored from backup: ${backupFile}`);
          return;
        }
      }
    }

    // Last resort: create empty config
    fs.writeFileSync(configPath, '{}');
    console.log('⚠️ Could not recover - created new empty config');
    console.log('Your corrupted file has been backed up');
  });

program
  .command('status')
  .description('Show session manager status and statistics')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    const sessionsDir = getSessionsDir();
    const backupDir = path.join(os.homedir(), '.openchrome', 'backups');
    const configPath = path.join(os.homedir(), '.claude.json');

    // Gather statistics
    let activeSessions = 0;
    let totalSessionsSize = 0;
    const sessionDetails: { id: string; age: string; size: string }[] = [];

    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const sessionDir = path.join(sessionsDir, entry.name);
        const metadataPath = path.join(sessionDir, '.session-metadata.json');

        activeSessions++;
        const size = getDirSize(sessionDir);
        totalSessionsSize += size;

        let age = 'unknown';
        if (fs.existsSync(metadataPath)) {
          try {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            const createdAt = new Date(metadata.createdAt).getTime();
            age = formatDuration(now - createdAt);
          } catch {
            // ignore
          }
        }

        sessionDetails.push({
          id: entry.name,
          age,
          size: formatBytes(size),
        });
      }
    }

    // Count backups
    let backupCount = 0;
    let backupSize = 0;
    if (fs.existsSync(backupDir)) {
      const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('.claude.json.'));
      backupCount = backups.length;
      for (const backup of backups) {
        const stats = fs.statSync(path.join(backupDir, backup));
        backupSize += stats.size;
      }
    }

    // Check config health
    let configHealthy = true;
    let configError = '';
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      if (!isValidJson(content)) {
        configHealthy = false;
        configError = 'Invalid JSON (corrupted)';
      }
    }

    // Memory usage
    const memUsage = process.memoryUsage();

    const status = {
      sessions: {
        active: activeSessions,
        totalSize: formatBytes(totalSessionsSize),
        details: sessionDetails,
      },
      backups: {
        count: backupCount,
        totalSize: formatBytes(backupSize),
      },
      config: {
        healthy: configHealthy,
        error: configError || undefined,
      },
      memory: {
        heapUsed: formatBytes(memUsage.heapUsed),
        heapTotal: formatBytes(memUsage.heapTotal),
        rss: formatBytes(memUsage.rss),
      },
    };

    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    // Pretty print
    console.log('Claude Chrome Parallel Status');
    console.log('═'.repeat(40));
    console.log();

    // Sessions
    console.log('Sessions');
    console.log('─'.repeat(20));
    console.log(`  Active: ${activeSessions}`);
    console.log(`  Total Size: ${formatBytes(totalSessionsSize)}`);
    if (sessionDetails.length > 0) {
      console.log('  Details:');
      for (const s of sessionDetails) {
        console.log(`    - ${s.id} (${s.age}, ${s.size})`);
      }
    }
    console.log();

    // Backups
    console.log('Backups');
    console.log('─'.repeat(20));
    console.log(`  Count: ${backupCount}`);
    console.log(`  Total Size: ${formatBytes(backupSize)}`);
    console.log();

    // Config
    console.log('Config Health');
    console.log('─'.repeat(20));
    if (configHealthy) {
      console.log('  ✅ .claude.json is healthy');
    } else {
      console.log(`  ❌ .claude.json: ${configError}`);
      console.log('     Run: openchrome recover');
    }
    console.log();

    // Memory
    console.log('Memory');
    console.log('─'.repeat(20));
    console.log(`  Heap Used: ${formatBytes(memUsage.heapUsed)}`);
    console.log(`  Heap Total: ${formatBytes(memUsage.heapTotal)}`);
    console.log(`  RSS: ${formatBytes(memUsage.rss)}`);
  });

program
  .command('cleanup')
  .description('Clean up stale sessions and old backups')
  .option('--max-age <hours>', 'Max session age in hours (default: 24)', '24')
  .option('--keep-backups <count>', 'Number of backups to keep (default: 10)', '10')
  .action((options: { maxAge: string; keepBackups: string }) => {
    const maxAgeMs = parseInt(options.maxAge, 10) * 60 * 60 * 1000;
    const keepBackups = parseInt(options.keepBackups, 10);

    console.log('Cleaning up stale sessions...\n');

    // Clean up sessions
    const sessionsDir = getSessionsDir();
    let sessionsRemoved = 0;

    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const sessionDir = path.join(sessionsDir, entry.name);
        const metadataPath = path.join(sessionDir, '.session-metadata.json');

        let shouldDelete = false;

        if (fs.existsSync(metadataPath)) {
          try {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            const createdAt = new Date(metadata.createdAt).getTime();
            shouldDelete = (now - createdAt) > maxAgeMs;
          } catch {
            shouldDelete = true; // Invalid metadata
          }
        } else {
          shouldDelete = true; // No metadata
        }

        if (shouldDelete) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          sessionsRemoved++;
        }
      }
    }

    console.log(`Removed ${sessionsRemoved} stale session(s)`);

    // Clean up backups
    const backupDir = path.join(os.homedir(), '.openchrome', 'backups');
    let backupsRemoved = 0;

    if (fs.existsSync(backupDir)) {
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('.claude.json.'))
        .sort()
        .reverse();

      const toRemove = backups.slice(keepBackups);
      for (const backup of toRemove) {
        fs.unlinkSync(path.join(backupDir, backup));
        backupsRemoved++;
      }
    }

    console.log(`Removed ${backupsRemoved} old backup(s)`);
    console.log('\nCleanup complete!');
  });

/**
 * Get the extension installation path
 */
function getExtensionPath(): string {
  return path.join(os.homedir(), '.openchrome', 'extension');
}

/**
 * Check if native host manifest exists
 */
function checkNativeHostManifest(): boolean {
  const platform = os.platform();
  let manifestPath: string;

  switch (platform) {
    case 'win32':
      // Check registry or user data path
      manifestPath = path.join(
        os.homedir(),
        'AppData',
        'Local',
        'Google',
        'Chrome',
        'User Data',
        'NativeMessagingHosts',
        'com.anthropic.claude_chrome_parallel.json'
      );
      break;
    case 'darwin':
      manifestPath = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'NativeMessagingHosts',
        'com.anthropic.claude_chrome_parallel.json'
      );
      break;
    default:
      manifestPath = path.join(
        os.homedir(),
        '.config',
        'google-chrome',
        'NativeMessagingHosts',
        'com.anthropic.claude_chrome_parallel.json'
      );
  }

  return fs.existsSync(manifestPath);
}

/**
 * Check Node.js version
 */
function checkNodeVersion(): boolean {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  return major >= 18;
}

/**
 * Check if Chrome is running with debugging port
 */
async function checkChromeDebugPort(port: number = 9222): Promise<boolean> {
  try {
    const http = await import('http');
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/json/version`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

/**
 * Check .claude.json health
 */
async function checkClaudeConfigHealth(): Promise<boolean> {
  const configPath = path.join(os.homedir(), '.claude.json');

  if (!fs.existsSync(configPath)) {
    return true; // No config is fine
  }

  const content = fs.readFileSync(configPath, 'utf8');
  return isValidJson(content);
}

/**
 * Get sessions directory
 */
function getSessionsDir(): string {
  return path.join(os.homedir(), '.openchrome', 'sessions');
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Check if string is valid JSON
 */
function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a backup of a file
 */
async function createBackupFile(filePath: string): Promise<string> {
  const backupDir = path.join(os.homedir(), '.openchrome', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const basename = path.basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${basename}.${timestamp}.bak`;
  const backupPath = path.join(backupDir, backupName);

  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Format bytes as human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format duration in milliseconds as human readable string
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Get total size of a directory recursively
 */
function getDirSize(dirPath: string): number {
  let totalSize = 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += getDirSize(fullPath);
      } else if (entry.isFile()) {
        totalSize += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Permission denied or other errors
  }

  return totalSize;
}

/**
 * Attempt to recover valid JSON from corrupted content
 */
function attemptJsonRecovery(content: string): object | null {
  const trimmed = content.trim();

  // Try to extract first valid JSON object from concatenated content
  if (trimmed.includes('}{')) {
    // Find matching brace for first object
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          const firstObject = trimmed.substring(0, i + 1);
          try {
            return JSON.parse(firstObject);
          } catch {
            // Try second object
            const secondObject = trimmed.substring(i + 1);
            try {
              return JSON.parse(secondObject);
            } catch {
              break;
            }
          }
        }
      }
    }
  }

  return null;
}

program.parse();
