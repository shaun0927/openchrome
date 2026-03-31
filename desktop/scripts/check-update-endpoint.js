#!/usr/bin/env node
/**
 * check-update-endpoint.js
 *
 * Health check script that verifies the Tauri auto-update endpoint is
 * reachable and that the latest.json manifest is structurally valid.
 * Intended for use in CI after a release to confirm the update pipeline works.
 *
 * Usage:
 *   node check-update-endpoint.js [--url <manifest-url>] [--timeout <ms>]
 *
 * Defaults:
 *   --url     https://github.com/shaun0927/openchrome/releases/latest/download/latest.json
 *   --timeout 10000 (10 seconds)
 *
 * Exit codes:
 *   0  success — endpoint reachable and manifest valid
 *   1  failure — endpoint unreachable or manifest invalid
 */

'use strict';

const https = require('https');
const url   = require('url');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_URL     = 'https://github.com/shaun0927/openchrome/releases/latest/download/latest.json';
const DEFAULT_TIMEOUT = 10000;

// Required top-level keys in a valid Tauri update manifest
const REQUIRED_KEYS = ['version', 'pub_date', 'platforms'];

// Required keys within each platform entry
const REQUIRED_PLATFORM_KEYS = ['signature', 'url'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  let i = 2;
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
 * Perform an HTTPS GET and return the response body as a string.
 * Follows a single redirect (GitHub releases redirect to S3).
 */
function httpsGet(targetUrl, timeoutMs, _depth = 0) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'GET',
      headers:  { 'User-Agent': 'openchrome-update-check/1.0' },
      timeout:  timeoutMs,
    };

    const req = https.request(options, (res) => {
      // Follow redirects (max 5 hops)
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        if (_depth >= 5) {
          reject(new Error(`Too many redirects (>5) following ${targetUrl}`));
          res.resume();
          return;
        }
        httpsGet(res.headers.location, timeoutMs, _depth + 1).then(resolve).catch(reject);
        res.resume();
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}`));
        res.resume();
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Validate the structure of a parsed Tauri update manifest.
 * Returns an array of validation error strings (empty = valid).
 */
function validateManifest(manifest) {
  const errors = [];

  for (const key of REQUIRED_KEYS) {
    if (!(key in manifest)) {
      errors.push(`Missing required key: "${key}"`);
    }
  }

  if (manifest.platforms && typeof manifest.platforms === 'object') {
    const platformEntries = Object.entries(manifest.platforms);
    if (platformEntries.length === 0) {
      errors.push('platforms object is empty — at least one platform entry is required');
    }
    for (const [platform, entry] of platformEntries) {
      if (typeof entry !== 'object' || entry === null) {
        errors.push(`Platform "${platform}" is not an object`);
        continue;
      }
      for (const pKey of REQUIRED_PLATFORM_KEYS) {
        if (!(pKey in entry)) {
          errors.push(`Platform "${platform}" is missing required key: "${pKey}"`);
        }
      }
      if (entry.url && typeof entry.url !== 'string') {
        errors.push(`Platform "${platform}".url must be a string`);
      }
      if (entry.signature && typeof entry.signature !== 'string') {
        errors.push(`Platform "${platform}".signature must be a string`);
      }
    }
  }

  if (manifest.version && typeof manifest.version !== 'string') {
    errors.push('version must be a string');
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args      = parseArgs(process.argv);
  const targetUrl = args['url']     || DEFAULT_URL;
  const timeout   = parseInt(args['timeout'] || DEFAULT_TIMEOUT, 10);

  console.error(`[check-update-endpoint] Checking: ${targetUrl}`);
  console.error(`[check-update-endpoint] Timeout:  ${timeout}ms`);

  let body;
  try {
    body = await httpsGet(targetUrl, timeout);
  } catch (err) {
    console.error(`[check-update-endpoint] FAIL — Could not reach endpoint: ${err.message}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch (err) {
    console.error(`[check-update-endpoint] FAIL — Response is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    console.error('[check-update-endpoint] FAIL — Manifest validation errors:');
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  console.error(`[check-update-endpoint] OK — Manifest valid`);
  console.error(`[check-update-endpoint]   version:   ${manifest.version}`);
  console.error(`[check-update-endpoint]   pub_date:  ${manifest.pub_date}`);
  console.error(`[check-update-endpoint]   platforms: ${Object.keys(manifest.platforms).join(', ')}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[check-update-endpoint] Unexpected error: ${err.message}`);
  process.exit(1);
});
