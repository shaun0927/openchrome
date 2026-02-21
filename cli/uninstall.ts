/**
 * Uninstallation script for Claude Chrome Parallel
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * Get the installation directory
 */
function getInstallDir(): string {
  return path.join(os.homedir(), '.openchrome');
}

/**
 * Remove directory recursively
 */
function removeDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      removeDir(fullPath);
    } else {
      fs.unlinkSync(fullPath);
    }
  }

  fs.rmdirSync(dir);
}

/**
 * Remove the extension files
 */
function removeExtension(): void {
  const installDir = getInstallDir();

  if (!fs.existsSync(installDir)) {
    console.log('Extension not installed.');
    return;
  }

  console.log('Removing extension files...');
  removeDir(installDir);
  console.log('Extension files removed.');
}

/**
 * Remove the native messaging host
 */
function removeNativeHost(): void {
  const platform = os.platform();

  // Get manifest path
  let manifestPath: string;

  switch (platform) {
    case 'win32':
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

  // Remove manifest file
  if (fs.existsSync(manifestPath)) {
    console.log('Removing native host manifest...');
    fs.unlinkSync(manifestPath);
    console.log('Native host manifest removed.');
  }

  // On Windows, remove registry entry
  if (platform === 'win32') {
    try {
      const regKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.anthropic.claude_chrome_parallel';
      execSync(`reg delete "${regKey}" /f`, { stdio: 'ignore' });
      console.log('Registry entry removed.');
    } catch {
      // Key might not exist
    }
  }
}

/**
 * Main uninstallation function
 */
export async function uninstall(): Promise<void> {
  console.log('Removing native messaging host...');
  removeNativeHost();

  console.log('\nRemoving extension files...');
  removeExtension();
}
