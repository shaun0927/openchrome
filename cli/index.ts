#!/usr/bin/env node
/**
 * CLI for Claude Chrome Parallel
 *
 * Commands:
 * - install: Install extension and native messaging host
 * - uninstall: Remove extension and native messaging host
 * - serve: Start MCP server for Claude Code
 * - sessions: List or clear sessions
 * - doctor: Check installation status
 */

import { Command } from 'commander';
import { install, installNativeHost } from './install';
import { uninstall } from './uninstall';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const program = new Command();

// Package info
const packageJsonPath = path.join(__dirname, '..', 'package.json');
let version = '0.1.0';
try {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  version = packageJson.version;
} catch {
  // Use default version
}

program
  .name('claude-chrome-parallel')
  .description('Chrome extension for parallel Claude Code sessions')
  .version(version);

program
  .command('install')
  .description('Install extension and native messaging host')
  .option('-f, --force', 'Force reinstall even if already installed')
  .option('--extension-id <id>', 'Chrome extension ID (for native host configuration)')
  .action(async (options) => {
    console.log('Installing Claude Chrome Parallel...\n');

    try {
      await install(options);
      console.log('\n✅ Installation complete!\n');
      console.log('Next steps:');
      console.log('1. Open chrome://extensions/ in Chrome');
      console.log('2. Enable "Developer mode" (top right)');
      console.log('3. Click "Load unpacked"');
      console.log(`4. Select: ${getExtensionPath()}`);
      console.log('\n5. Note the Extension ID and run:');
      console.log('   claude-chrome-parallel install --extension-id <YOUR_ID>');
    } catch (error) {
      console.error('❌ Installation failed:', error);
      process.exit(1);
    }
  });

program
  .command('uninstall')
  .description('Remove extension and native messaging host')
  .action(async () => {
    console.log('Uninstalling Claude Chrome Parallel...\n');

    try {
      await uninstall();
      console.log('\n✅ Uninstallation complete!');
      console.log('Note: You still need to manually remove the extension from chrome://extensions/');
    } catch (error) {
      console.error('❌ Uninstallation failed:', error);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Start MCP server for Claude Code')
  .action(() => {
    // This would start the native messaging host
    // For now, just show info
    console.log('MCP server mode is handled by the native messaging host.');
    console.log('Configure in Claude Code settings.json:');
    console.log(`
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "claude-chrome-parallel",
      "args": ["serve"]
    }
  }
}
`);
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

    const checks = {
      'Extension files': fs.existsSync(getExtensionPath()),
      'Native host manifest': checkNativeHostManifest(),
      'Node.js version': checkNodeVersion(),
    };

    for (const [name, passed] of Object.entries(checks)) {
      const status = passed ? '✅' : '❌';
      console.log(`${status} ${name}`);
    }

    const allPassed = Object.values(checks).every(Boolean);
    console.log();

    if (allPassed) {
      console.log('All checks passed! Extension should be ready to use.');
    } else {
      console.log('Some checks failed. Run "claude-chrome-parallel install" to fix.');
    }
  });

/**
 * Get the extension installation path
 */
function getExtensionPath(): string {
  return path.join(os.homedir(), '.claude-chrome-parallel', 'extension');
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

program.parse();
