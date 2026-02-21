/**
 * Installation script for Claude Chrome Parallel
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

interface InstallOptions {
  force?: boolean;
  extensionId?: string;
}

/**
 * Get the installation directory
 */
function getInstallDir(): string {
  return path.join(os.homedir(), '.openchrome');
}

/**
 * Get the extension source directory
 */
function getExtensionSourceDir(): string {
  // In npm package, extension is in dist/extension
  const npmPath = path.join(__dirname, '..', 'dist', 'extension');
  if (fs.existsSync(npmPath)) {
    return npmPath;
  }

  // In development, extension is in dist/extension or extension
  const devPath = path.join(__dirname, '..', '..', 'dist', 'extension');
  if (fs.existsSync(devPath)) {
    return devPath;
  }

  throw new Error('Extension source directory not found. Did you run "npm run build"?');
}

/**
 * Copy directory recursively
 */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Install the extension files
 */
function installExtension(options: InstallOptions): void {
  const installDir = getInstallDir();
  const extensionDir = path.join(installDir, 'extension');

  // Check if already installed
  if (fs.existsSync(extensionDir) && !options.force) {
    console.log('Extension already installed. Use --force to reinstall.');
    return;
  }

  // Create installation directory
  fs.mkdirSync(installDir, { recursive: true });

  // Copy extension files
  console.log('Copying extension files...');
  const sourceDir = getExtensionSourceDir();
  copyDir(sourceDir, extensionDir);

  console.log(`Extension installed to: ${extensionDir}`);
}

/**
 * Install the native messaging host
 */
export function installNativeHost(extensionId?: string): void {
  const installDir = getInstallDir();
  const nativeHostDir = path.join(installDir, 'native-host');
  const platform = os.platform();

  // Create native host directory
  fs.mkdirSync(nativeHostDir, { recursive: true });

  // Copy host.js
  const hostSource = path.join(__dirname, '..', 'native-host', 'host.js');
  const hostDest = path.join(nativeHostDir, 'host.js');

  if (fs.existsSync(hostSource)) {
    fs.copyFileSync(hostSource, hostDest);
  }

  // Create manifest
  const manifest = {
    name: 'com.anthropic.claude_chrome_parallel',
    description: 'Native messaging host for Claude Chrome Parallel extension',
    path: platform === 'win32'
      ? path.join(nativeHostDir, 'host.bat')
      : path.join(nativeHostDir, 'host.js'),
    type: 'stdio',
    allowed_origins: extensionId
      ? [`chrome-extension://${extensionId}/`]
      : ['chrome-extension://*/'],
  };

  // On Windows, create a batch file wrapper
  if (platform === 'win32') {
    const batchContent = `@echo off\nnode "${path.join(nativeHostDir, 'host.js')}" %*`;
    fs.writeFileSync(path.join(nativeHostDir, 'host.bat'), batchContent);
  } else {
    // Make host.js executable
    try {
      fs.chmodSync(hostDest, 0o755);
    } catch {
      // Ignore chmod errors on Windows
    }
  }

  // Get manifest destination path
  let manifestDir: string;

  switch (platform) {
    case 'win32':
      manifestDir = path.join(
        os.homedir(),
        'AppData',
        'Local',
        'Google',
        'Chrome',
        'User Data',
        'NativeMessagingHosts'
      );
      break;
    case 'darwin':
      manifestDir = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'NativeMessagingHosts'
      );
      break;
    default:
      manifestDir = path.join(
        os.homedir(),
        '.config',
        'google-chrome',
        'NativeMessagingHosts'
      );
  }

  // Create manifest directory
  fs.mkdirSync(manifestDir, { recursive: true });

  // Write manifest
  const manifestPath = path.join(manifestDir, 'com.anthropic.claude_chrome_parallel.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`Native host manifest installed to: ${manifestPath}`);

  // On Windows, also register in registry
  if (platform === 'win32') {
    try {
      const regKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.anthropic.claude_chrome_parallel';
      execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, {
        stdio: 'ignore',
      });
      console.log('Registry entry added for native messaging host.');
    } catch (error) {
      console.warn('Warning: Failed to add registry entry. Native messaging may not work.');
    }
  }
}

/**
 * Main installation function
 */
export async function install(options: InstallOptions): Promise<void> {
  console.log('Installing extension files...');
  installExtension(options);

  console.log('\nInstalling native messaging host...');
  installNativeHost(options.extensionId);
}
