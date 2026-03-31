#!/usr/bin/env node
/**
 * Download platform-specific cloudflared binary for Tauri sidecar bundling.
 *
 * Usage:
 *   node scripts/download-cloudflared.js [--output-dir <dir>] [--platform <platform>] [--arch <arch>]
 *
 * Defaults:
 *   --output-dir  desktop/src-tauri/binaries
 *   --platform    current OS (darwin, win32, linux)
 *   --arch        current arch (arm64, x64)
 *
 * Downloads the latest cloudflared release from GitHub, verifies SHA256 checksum,
 * and renames the binary with Tauri's platform-suffix convention:
 *   cloudflared-<arch>-<os>   (e.g. cloudflared-aarch64-apple-darwin)
 *
 * Part of #521: Desktop App Cloudflare Tunnel integration.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Cloudflared binary mapping: { `${platform}-${arch}`: assetName }
const BINARY_MAP = {
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'linux-x64': 'cloudflared-linux-amd64',
};

// Tauri target triple suffix mapping
const TAURI_SUFFIX_MAP = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};

const GITHUB_API = 'https://api.github.com';
const REPO = 'cloudflare/cloudflared';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    outputDir: path.join(__dirname, '..', 'desktop', 'src-tauri', 'binaries'),
    platform: process.platform,
    arch: process.arch,
    version: 'latest',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--output-dir':
        opts.outputDir = args[++i];
        break;
      case '--platform':
        opts.platform = args[++i];
        break;
      case '--arch':
        opts.arch = args[++i];
        break;
      case '--version':
        opts.version = args[++i];
        break;
      case '--help':
        console.error(`Usage: node scripts/download-cloudflared.js [options]
  --output-dir <dir>    Output directory (default: desktop/src-tauri/binaries)
  --platform <platform> Target platform: darwin, win32, linux (default: current)
  --arch <arch>         Target arch: arm64, x64 (default: current)
  --version <version>   Cloudflared version tag (default: latest)`);
        process.exit(0);
    }
  }

  return opts;
}

function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'openchrome-download-script', ...options.headers };
    https.get(url, { headers }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, options).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)));
        return;
      }
      if (options.stream) {
        resolve(res);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getLatestRelease() {
  const url = `${GITHUB_API}/repos/${REPO}/releases/latest`;
  const data = await httpsGet(url);
  return JSON.parse(data.toString());
}

async function getReleaseByTag(tag) {
  const url = `${GITHUB_API}/repos/${REPO}/tags`;
  const data = await httpsGet(url);
  const tags = JSON.parse(data.toString());
  const match = tags.find((t) => t.name === tag);
  if (!match) throw new Error(`Tag ${tag} not found`);

  const releaseUrl = `${GITHUB_API}/repos/${REPO}/releases/tags/${tag}`;
  const releaseData = await httpsGet(releaseUrl);
  return JSON.parse(releaseData.toString());
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function downloadAndVerify(release, assetName) {
  // Find the binary asset
  const binaryAsset = release.assets.find((a) => a.name === assetName);
  if (!binaryAsset) {
    const available = release.assets.map((a) => a.name).join(', ');
    throw new Error(`Asset "${assetName}" not found in release. Available: ${available}`);
  }

  // Find checksum file (cloudflared releases include SHA256SUMS)
  const checksumAsset = release.assets.find(
    (a) => a.name === 'cloudflared-SHA256SUMS' || a.name === 'SHA256SUMS',
  );

  console.error(`Downloading ${assetName} (${(binaryAsset.size / 1024 / 1024).toFixed(1)} MB)...`);
  const binaryData = await httpsGet(binaryAsset.browser_download_url);

  // Verify checksum if available
  if (checksumAsset) {
    console.error('Downloading checksums...');
    const checksumData = await httpsGet(checksumAsset.browser_download_url);
    const checksumText = checksumData.toString();
    const expectedHash = checksumText
      .split('\n')
      .find((line) => line.includes(assetName))
      ?.split(/\s+/)[0];

    if (expectedHash) {
      const actualHash = sha256(binaryData);
      if (actualHash !== expectedHash) {
        throw new Error(
          `Checksum mismatch for ${assetName}:\n  expected: ${expectedHash}\n  actual:   ${actualHash}`,
        );
      }
      console.error(`Checksum verified: ${actualHash}`);
    } else {
      console.error(`Warning: no checksum entry found for ${assetName}, skipping verification`);
    }
  } else {
    throw new Error(
      'No checksum file found in release — refusing to install unverified binary. ' +
      'Use --skip-checksum to override (not recommended).',
    );
  }

  return binaryData;
}

function extractTgz(buffer) {
  // Write to temp file, extract with tar
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cloudflared-'));
  const tmpFile = path.join(tmpDir, 'archive.tgz');
  fs.writeFileSync(tmpFile, buffer);

  try {
    execFileSync('tar', ['xzf', tmpFile, '-C', tmpDir], { stdio: 'pipe' });
    // Find the cloudflared binary in extracted files
    const files = fs.readdirSync(tmpDir);
    const binary = files.find((f) => f === 'cloudflared');
    if (!binary) {
      throw new Error(`cloudflared binary not found in archive. Files: ${files.join(', ')}`);
    }
    return fs.readFileSync(path.join(tmpDir, binary));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs();
  const key = `${opts.platform}-${opts.arch}`;

  const assetName = BINARY_MAP[key];
  if (!assetName) {
    console.error(`Unsupported platform/arch: ${key}`);
    console.error(`Supported: ${Object.keys(BINARY_MAP).join(', ')}`);
    process.exit(1);
  }

  const tauriSuffix = TAURI_SUFFIX_MAP[key];
  if (!tauriSuffix) {
    console.error(`No Tauri suffix mapping for: ${key}`);
    process.exit(1);
  }

  console.error(`Platform: ${opts.platform}, Arch: ${opts.arch}`);
  console.error(`Asset: ${assetName}`);

  // Get release info
  const release =
    opts.version === 'latest' ? await getLatestRelease() : await getReleaseByTag(opts.version);
  console.error(`Release: ${release.tag_name}`);

  // Download and verify
  let binaryData = await downloadAndVerify(release, assetName);

  // Extract if tarball (macOS releases are .tgz)
  if (assetName.endsWith('.tgz')) {
    console.error('Extracting from tarball...');
    binaryData = extractTgz(binaryData);
  }

  // Ensure output directory exists
  fs.mkdirSync(opts.outputDir, { recursive: true });

  // Write with Tauri sidecar naming convention
  const isWindows = opts.platform === 'win32';
  const ext = isWindows ? '.exe' : '';
  const outputName = `cloudflared-${tauriSuffix}${ext}`;
  const outputPath = path.join(opts.outputDir, outputName);

  fs.writeFileSync(outputPath, binaryData);
  if (!isWindows) {
    fs.chmodSync(outputPath, 0o755);
  }

  const sizeMB = (binaryData.length / 1024 / 1024).toFixed(1);
  console.error(`Written: ${outputPath} (${sizeMB} MB)`);

  // Write version file for reproducibility
  const versionFile = path.join(opts.outputDir, 'cloudflared-version.txt');
  fs.writeFileSync(versionFile, `${release.tag_name}\n`);
  console.error(`Version file: ${versionFile}`);

  console.error('Done.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
