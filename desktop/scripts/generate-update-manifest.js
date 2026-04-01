#!/usr/bin/env node
/**
 * generate-update-manifest.js
 *
 * Generates the latest.json manifest required by the Tauri auto-updater.
 * Run after a release build to produce the manifest that is uploaded to
 * GitHub Releases alongside the platform artifacts.
 *
 * Usage:
 *   node generate-update-manifest.js \
 *     --version <version> \
 *     --tag <git-tag> \
 *     [--notes <release-notes>] \
 *     [--darwin-aarch64-sig <path>] \
 *     [--darwin-x86_64-sig <path>] \
 *     [--linux-x86_64-sig <path>] \
 *     [--windows-x86_64-sig <path>] \
 *     [--out <output-path>]
 *
 * Example:
 *   node generate-update-manifest.js \
 *     --version 1.0.0 \
 *     --tag desktop-v1.0.0 \
 *     --notes "Bug fixes and improvements" \
 *     --darwin-aarch64-sig ./OpenChrome_1.0.0_aarch64.app.tar.gz.sig \
 *     --darwin-x86_64-sig  ./OpenChrome_1.0.0_x64.app.tar.gz.sig \
 *     --linux-x86_64-sig   ./openchrome_1.0.0_amd64.AppImage.sig \
 *     --windows-x86_64-sig ./OpenChrome_1.0.0_x64_en-US.msi.zip.sig \
 *     --out ./latest.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse argv key=value pairs into a plain object.
 * Supports both --key value and --key=value forms.
 */
function parseArgs(argv) {
  const args = {};
  let i = 2; // skip node + script path
  while (i < argv.length) {
    const raw = argv[i];
    if (raw.startsWith('--')) {
      const key = raw.slice(2);
      if (key.includes('=')) {
        const eq = key.indexOf('=');
        args[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else {
        args[key] = true;
      }
    }
    i += 1;
  }
  return args;
}

/**
 * Read a .sig file produced by `tauri signer sign` and return its contents.
 * Returns null if sigPath is falsy, so platforms can be omitted.
 */
function readSignature(sigPath) {
  if (!sigPath) return null;
  const resolved = path.resolve(sigPath);
  if (!fs.existsSync(resolved)) {
    console.error(`[generate-update-manifest] Signature file not found: ${resolved}`);
    process.exit(1);
  }
  return fs.readFileSync(resolved, 'utf8').trim();
}

/**
 * Build the GitHub Releases download URL for a given artifact filename.
 */
function releaseUrl(tag, filename) {
  return `https://github.com/shaun0927/openchrome/releases/download/${tag}/${filename}`;
}

// ---------------------------------------------------------------------------
// Platform artifact filename conventions
// Tauri produces these names by default; adjust if your build config differs.
// ---------------------------------------------------------------------------
function artifactFilenames(version) {
  return {
    'darwin-aarch64': `OpenChrome_${version}_aarch64.app.tar.gz`,
    'darwin-x86_64':  `OpenChrome_${version}_x64.app.tar.gz`,
    'linux-x86_64':   `openchrome_${version}_amd64.AppImage.tar.gz`,
    'windows-x86_64': `OpenChrome_${version}_x64_en-US.msi.zip`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  // Required
  const version = args['version'];
  const tag     = args['tag'];
  if (!version) {
    console.error('[generate-update-manifest] --version is required');
    process.exit(1);
  }
  if (!tag) {
    console.error('[generate-update-manifest] --tag is required');
    process.exit(1);
  }

  // Optional
  const notes  = args['notes'] || '';
  const outArg = args['out']   || path.join(process.cwd(), 'latest.json');

  // Signature paths (optional per platform)
  const sigPaths = {
    'darwin-aarch64': args['darwin-aarch64-sig'] || null,
    'darwin-x86_64':  args['darwin-x86_64-sig']  || null,
    'linux-x86_64':   args['linux-x86_64-sig']   || null,
    'windows-x86_64': args['windows-x86_64-sig'] || null,
  };

  const filenames = artifactFilenames(version);
  const pubDate   = new Date().toISOString();

  // Build platforms object — only include platforms that have a signature
  const platforms = {};
  for (const [platform, sigPath] of Object.entries(sigPaths)) {
    const signature = readSignature(sigPath);
    if (signature !== null) {
      platforms[platform] = {
        signature: signature,
        url: releaseUrl(tag, filenames[platform]),
      };
    }
  }

  if (Object.keys(platforms).length === 0) {
    console.error('[generate-update-manifest] No platform signatures provided. Pass at least one --<platform>-sig argument.');
    process.exit(1);
  }

  const manifest = {
    version:  version,
    notes:    notes,
    pub_date: pubDate,
    platforms: platforms,
  };

  const outPath = path.resolve(outArg);
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.error(`[generate-update-manifest] Wrote manifest to ${outPath}`);
  console.error(`[generate-update-manifest] Included platforms: ${Object.keys(platforms).join(', ')}`);
}

main();
