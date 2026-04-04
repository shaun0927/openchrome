#!/usr/bin/env node
/**
 * CLI for OpenChrome
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
import {
  formatMCPServerConfigSnippet,
  getClientLabel,
  getClaudeManualServerConfig,
  getClaudeSetupCommand,
  getCodexServerConfig,
  getSupportedMCPClients,
  isSupportedMCPClient,
  upsertMCPServerConfig,
} from './mcp-client-config';
import {
  addTotpSecret,
  generateTOTP,
  getTotpSecret,
  listTotpDomains,
  removeTotpSecret,
  totpSecondsRemaining,
  validateBase32,
} from './totp-store';

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
    console.log('OpenChrome now uses CDP (Chrome DevTools Protocol) mode,');
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
    console.log('OpenChrome now uses CDP mode, which has no extension to uninstall.');
    console.log('Simply remove the MCP server config from ~/.claude.json if you want to disable it.');
  });

program
  .command('setup')
  .description('Automatically configure MCP server for Claude Code or Codex CLI')
  .option('--client <client>', 'Client to configure: "claude" (default) or "codex"', 'claude')
  .option('--dashboard', 'Enable terminal dashboard')
  .option('--auto-launch', 'Auto-launch Chrome if not running (default: true)')
  .option('-s, --scope <scope>', 'Installation scope: "user" (global, default) or "project" (current project only)', 'user')
  .action(async (options: { client?: string; dashboard?: boolean; autoLaunch?: boolean; scope?: string }) => {
    const { execFileSync } = require('child_process');

    const requestedClient = options.client || 'claude';
    if (!isSupportedMCPClient(requestedClient)) {
      console.error(`❌ Invalid client. Use one of: ${getSupportedMCPClients().join(', ')}`);
      process.exit(1);
    }

    const client = requestedClient;
    console.log(`Setting up OpenChrome for ${getClientLabel(client)}...\n`);

    // Check if claude CLI is available
    const scope = options.scope || 'user';
    if (scope !== 'user' && scope !== 'project') {
      console.error('❌ Invalid scope. Use "user" (global) or "project" (current project only).');
      process.exit(1);
    }

    const serveArgOptions = { autoLaunch: options.autoLaunch, dashboard: options.dashboard };

    if (client === 'claude') {
      try {
        execFileSync('claude', ['--version'], { stdio: 'pipe' });
      } catch {
        console.error('❌ Claude Code CLI not found.');
        console.error('   Please install Claude Code first: https://claude.ai/code');
        process.exit(1);
      }

      // Remove existing configuration from ALL scopes to prevent duplicates.
      // Without explicit scope flags, `claude mcp remove` only targets one scope,
      // leaving the other intact and causing dual-registration conflicts.
      for (const removeScope of ['user', 'project'] as const) {
        try {
          execFileSync('claude', ['mcp', 'remove', 'openchrome', '-s', removeScope], { stdio: 'pipe' });
        } catch {
          // Ignore if not exists in this scope
        }
      }

      // Use npx @latest with --prefer-online for reliable auto-updates.
      // Without --prefer-online, npx caches a semver range (e.g. ^1.4.0) in ~/.npm/_npx/
      // and never re-checks the registry, so @latest effectively becomes @cached.
      const setupArgs = getClaudeSetupCommand(scope, serveArgOptions);

      console.log(`Running: claude mcp add openchrome (scope: ${scope})...`);

      try {
        execFileSync('claude', setupArgs, { stdio: 'inherit' });
        console.log('\n✅ MCP server configured successfully!\n');

        // Configure tool permissions in ~/.claude/settings.json
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        const permissionEntry = 'mcp__openchrome__*';
        try {
          let settings: Record<string, unknown> = {};
          if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          } else {
            // Ensure ~/.claude/ directory exists
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
          }

          // Ensure permissions.allow array exists
          if (!settings.permissions || typeof settings.permissions !== 'object') {
            settings.permissions = {};
          }
          const permissions = settings.permissions as Record<string, unknown>;
          if (!Array.isArray(permissions.allow)) {
            permissions.allow = [];
          }
          const allowList = permissions.allow as string[];

          if (allowList.includes(permissionEntry)) {
            console.log('✓ Tool permissions already configured (auto-approve OpenChrome tools)');
          } else {
            allowList.push(permissionEntry);
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
            console.log('✓ Tool permissions configured (auto-approve OpenChrome tools)');
          }
        } catch {
          console.warn('⚠️  Could not configure tool permissions automatically.');
          console.warn(`   Manually add "${permissionEntry}" to permissions.allow in ${settingsPath}`);
        }

        console.log(`\nScope: ${scope === 'user' ? 'Global (all projects)' : 'Project (this directory only)'}`);
        console.log('Auto-updates: enabled (via npx)\n');
        console.log('Next steps:');
        console.log('  1. Restart Claude Code');
        console.log('  2. Just say "oc" — that\'s it.\n');
        console.log('Examples:');
        console.log('  "oc screenshot my Gmail"');
        console.log('  "use oc to check AWS billing"');
        console.log('  "oc search on naver.com"\n');
      } catch {
        console.error('\n❌ Failed to configure MCP server.');
        console.error('   You can manually add to ~/.claude.json:');
        console.error(formatMCPServerConfigSnippet('openchrome', getClaudeManualServerConfig(serveArgOptions)));
        process.exit(1);
      }

      return;
    }

    if (scope !== 'user') {
      console.warn('⚠️  Scope is not used for Codex CLI; writing to ~/.codex/mcp.json.');
    }

    try {
      const codexConfigPath = path.join(os.homedir(), '.codex', 'mcp.json');
      fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });

      let config: Record<string, unknown> = {};
      if (fs.existsSync(codexConfigPath)) {
        config = JSON.parse(fs.readFileSync(codexConfigPath, 'utf8'));
      }

      const updatedConfig = upsertMCPServerConfig(config, 'openchrome', getCodexServerConfig(serveArgOptions));
      fs.writeFileSync(codexConfigPath, JSON.stringify(updatedConfig, null, 2) + '\n');

      console.log('\n✅ MCP server configured successfully!\n');
      console.log(`Config file: ${codexConfigPath}`);
      console.log('Auto-updates: enabled (via npm exec)\n');
      console.log('Next steps:');
      console.log('  1. Restart Codex CLI');
      console.log('  2. Verify the openchrome MCP server reconnects cleanly\n');
      console.log('Installed MCP snippet:');
      console.log(formatMCPServerConfigSnippet('openchrome', getCodexServerConfig(serveArgOptions)));
    } catch (error) {
      console.error('\n❌ Failed to configure MCP server for Codex CLI.');
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
      console.error('   You can manually add this to ~/.codex/mcp.json:');
      console.error(formatMCPServerConfigSnippet('openchrome', getCodexServerConfig(serveArgOptions)));
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Print MCP configuration for a supported client')
  .requiredOption('--client <client>', 'Client to generate config for: "claude" or "codex"')
  .option('--dashboard', 'Enable terminal dashboard')
  .option('--auto-launch', 'Auto-launch Chrome if not running (default: true)')
  .action((options: { client: string; dashboard?: boolean; autoLaunch?: boolean }) => {
    if (!isSupportedMCPClient(options.client)) {
      console.error(`❌ Invalid client. Use one of: ${getSupportedMCPClients().join(', ')}`);
      process.exit(1);
    }

    const serveArgOptions = { autoLaunch: options.autoLaunch, dashboard: options.dashboard };

    if (options.client === 'claude') {
      console.log(['claude', ...getClaudeSetupCommand('user', serveArgOptions)].join(' '));
      return;
    }

    console.log(formatMCPServerConfigSnippet('openchrome', getCodexServerConfig(serveArgOptions)));
  });

program
  .command('serve')
  .description('Start MCP server for Claude Code')
  .option('-p, --port <port>', 'Chrome remote debugging port', '9222')
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
  .option('--dashboard', 'Enable terminal dashboard for real-time monitoring')
  .option('--persist-storage', 'Enable browser state persistence (cookies + localStorage)')
  .option('--storage-dir <path>', 'Directory for storage state files (default: .openchrome/storage-state/)')
  .action(async () => {
    // Non-blocking update check (fires in background)
    checkForUpdates(version).catch(() => {});

    // Auto-migrate: patch ~/.claude.json to use @latest if still using bare package name.
    try {
      const claudeConfigPath = path.join(os.homedir(), '.claude.json');
      if (fs.existsSync(claudeConfigPath)) {
        const raw = fs.readFileSync(claudeConfigPath, 'utf8');
        if (raw.includes('openchrome-mcp') && !raw.includes('openchrome-mcp@')) {
          const patched = raw.replace(/openchrome-mcp(?!@)/g, 'openchrome-mcp@latest');
          if (patched !== raw) {
            fs.writeFileSync(claudeConfigPath, patched);
            console.error('[openchrome] Auto-migrated MCP config to use @latest for auto-updates');
          }
        }
      }
    } catch {
      // Best-effort migration
    }

    // Forward to the full-featured serve implementation in dist/index.js
    // This includes self-healing, HTTP transport, event loop monitor, disk monitor,
    // health endpoint, session persistence, and all reliability features.
    const serveEntry = path.join(__dirname, '..', 'index.js');
    const child = spawn(process.execPath, [serveEntry, ...process.argv.slice(2)], {
      stdio: 'inherit',
    });

    // Forward signals to child process
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    process.on('SIGTERM', () => forwardSignal('SIGTERM'));
    process.on('SIGINT', () => forwardSignal('SIGINT'));
    // Forward SIGHUP on all platforms — on Unix this fires when the
    // controlling terminal closes (e.g., MCP client session ends).
    process.on('SIGHUP', () => forwardSignal('SIGHUP'));

    // If the parent closes stdin, kill the child to prevent orphaning.
    process.stdin.on('end', () => {
      if (!child.killed) child.kill('SIGTERM');
    });

    child.on('exit', (code) => process.exit(code ?? 0));
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
    const portCheck = await checkChromeDebugPort();
    const coreChecks = {
      'Node.js version (>=18)': checkNodeVersion(),
      '.claude.json health': await checkClaudeConfigHealth(),
      'Chrome debugging port': portCheck.available,
    };

    console.log('Core Requirements:');
    for (const [name, passed] of Object.entries(coreChecks)) {
      const status = passed ? '✅' : '❌';
      console.log(`  ${status} ${name}`);
    }

    // Chrome binary detection
    console.log('\nChrome Detection:');
    const platform = os.platform();
    const chromePaths: string[] = [];
    if (platform === 'darwin') {
      chromePaths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else if (platform === 'win32') {
      const envProgramFiles = process.env['PROGRAMFILES'];
      const envLocalAppData = process.env['LOCALAPPDATA'];
      if (envProgramFiles) chromePaths.push(path.join(envProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      if (envLocalAppData) chromePaths.push(path.join(envLocalAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    } else {
      chromePaths.push('/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/snap/bin/chromium');
    }
    if (process.env.CHROME_PATH) {
      console.log(`  CHROME_PATH: ${process.env.CHROME_PATH} ${fs.existsSync(process.env.CHROME_PATH) ? '✅' : '❌ not found'}`);
    } else {
      let found = false;
      for (const p of chromePaths) {
        if (fs.existsSync(p)) {
          console.log(`  ✅ Found: ${p}`);
          found = true;
          break;
        }
      }
      if (!found) {
        console.log('  ❌ Chrome not found in standard locations');
        console.log('  Set CHROME_PATH environment variable to your Chrome binary');
      }
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
        console.log(`Chrome debugging port issue: ${portCheck.details || 'Unknown'}`);
        if (portCheck.details?.includes('Nothing is listening')) {
          console.log('Start Chrome with: chrome --remote-debugging-port=9222');
          console.log('Or enable auto-launch: set autoLaunch=true in openchrome config');
        }
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
  .option('--persist-storage', 'Enable browser state persistence (cookies + localStorage)')
  .argument('[args...]', 'Arguments to pass to claude')
  .action(async (args: string[], options: { syncBack?: boolean; keepSession?: boolean; persistStorage?: boolean }) => {
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
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: sessionDir,
      USERPROFILE: sessionDir,
      CLAUDE_CONFIG_DIR: sessionDir,
    };

    if (options.persistStorage) {
      env.OC_PERSIST_STORAGE = '1';
    }

    // Find claude command
    const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';

    // Spawn claude with isolated environment
    const child = spawn(claudeCmd, args, {
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
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
    console.log('OpenChrome Status');
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
        'com.anthropic.openchrome.json'
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
        'com.anthropic.openchrome.json'
      );
      break;
    default:
      manifestPath = path.join(
        os.homedir(),
        '.config',
        'google-chrome',
        'NativeMessagingHosts',
        'com.anthropic.openchrome.json'
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

interface PortCheckResult {
  available: boolean;
  details?: string;
}

/**
 * Check if Chrome is running with debugging port
 */
async function checkChromeDebugPort(port: number = 9222): Promise<PortCheckResult> {
  try {
    const http = await import('http');
    const net = await import('net');

    // First: check if anything is listening on the port
    const portInUse = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });

    if (!portInUse) {
      return { available: false, details: `Nothing is listening on port ${port}. Start Chrome with: chrome --remote-debugging-port=${port}` };
    }

    // Port is in use — check if it's Chrome DevTools
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        if (res.statusCode === 200) {
          let data = '';
          res.on('data', (chunk: string) => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve({
                available: true,
                details: `Chrome ${json.Browser || 'unknown'} responding on port ${port}`
              });
            } catch {
              resolve({ available: true, details: `Port ${port} responding but could not parse version info` });
            }
          });
        } else {
          resolve({ available: false, details: `Port ${port} is in use but not responding as Chrome DevTools (HTTP ${res.statusCode})` });
        }
      });
      req.on('error', () => {
        resolve({ available: false, details: `Port ${port} is in use but not responding to HTTP (may not be Chrome)` });
      });
      req.setTimeout(2000, () => {
        req.destroy();
        resolve({ available: false, details: `Port ${port} is in use but timed out (may be blocked by firewall)` });
      });
    });
  } catch {
    return { available: false, details: 'Failed to check port' };
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

// ---------------------------------------------------------------------------
// totp command group
// ---------------------------------------------------------------------------

const totp = program.command('totp').description('Manage TOTP secrets for 2FA automation');

totp
  .command('add')
  .description('Add a TOTP secret for a domain')
  .requiredOption('--domain <domain>', 'Domain the secret belongs to (e.g. github.com)')
  .requiredOption('--secret <base32-secret>', 'TOTP secret in base32 format')
  .option('--issuer <name>', 'Human-readable issuer name (e.g. GitHub)')
  .action(async (options: { domain: string; secret: string; issuer?: string }) => {
    if (!validateBase32(options.secret)) {
      console.error(`❌ Invalid base32 secret. Ensure the secret only contains characters A-Z and 2-7.`);
      process.exit(1);
    }
    try {
      await addTotpSecret(options.domain, options.secret, options.issuer);
      console.error(`TOTP secret added for ${options.domain}`);
    } catch (error) {
      console.error(`❌ Failed to store TOTP secret: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

totp
  .command('list')
  .description('List all configured TOTP domains')
  .action(async () => {
    try {
      const domains = await listTotpDomains();
      if (domains.length === 0) {
        console.error('No TOTP secrets configured.');
        return;
      }
      // Table header
      const domainWidth = Math.max(6, ...domains.map((d) => d.domain.length));
      const issuerWidth = Math.max(6, ...domains.map((d) => (d.issuer ?? '').length));
      const header = `${'Domain'.padEnd(domainWidth)}  ${'Issuer'.padEnd(issuerWidth)}  Added`;
      const separator = '-'.repeat(header.length);
      console.error(header);
      console.error(separator);
      for (const entry of domains) {
        const addedAt = new Date(entry.addedAt).toISOString().split('T')[0];
        console.error(
          `${entry.domain.padEnd(domainWidth)}  ${(entry.issuer ?? '').padEnd(issuerWidth)}  ${addedAt}`
        );
      }
    } catch (error) {
      console.error(`❌ Failed to list TOTP secrets: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

totp
  .command('remove')
  .description('Remove the TOTP secret for a domain')
  .requiredOption('--domain <domain>', 'Domain to remove')
  .action(async (options: { domain: string }) => {
    try {
      const removed = await removeTotpSecret(options.domain);
      if (!removed) {
        console.error(`❌ No TOTP secret found for ${options.domain}`);
        process.exit(1);
      }
      console.error(`TOTP secret removed for ${options.domain}`);
    } catch (error) {
      console.error(`❌ Failed to remove TOTP secret: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

totp
  .command('generate')
  .description('Generate the current TOTP code for a domain')
  .requiredOption('--domain <domain>', 'Domain to generate code for')
  .action(async (options: { domain: string }) => {
    try {
      const secret = await getTotpSecret(options.domain);
      if (secret === null) {
        console.error(`❌ No TOTP secret configured for ${options.domain}`);
        process.exit(1);
      }
      const code = generateTOTP(secret);
      const secondsLeft = totpSecondsRemaining();
      console.error(`${code} (${secondsLeft}s remaining)`);
    } catch (error) {
      console.error(`❌ Failed to generate TOTP code: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program.parse();
