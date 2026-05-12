#!/usr/bin/env node
/**
 * B1-phase0-measure.mjs — Phase 0 measurement spike for issue #892
 *
 * Measures WAF bypass capability of OpenChrome (headed CDP + stealth) against
 * the target set in tests/fixtures/waf-targets.json.
 *
 * Usage:
 *   node scripts/experiments/B1-phase0-measure.mjs [--arm=openchrome]
 *   node scripts/experiments/B1-phase0-measure.mjs --arm=browsermcp
 *
 * Arms:
 *   --arm=openchrome  (default) Automated: launches OpenChrome, navigates each
 *                     target, captures page_screenshot PNG evidence +
 *                     evaluates pass/fail.
 *   --arm=browsermcp  Manual: prints step-by-step instructions for a reviewer
 *                     who has BrowserMCP's extension loaded in Chrome.
 *
 * Output:
 *   - Diagnostics to stderr (safe for MCP hosts — not an MCP server).
 *   - Markdown results table fragment to stdout.
 *   - PNG screenshots to docs/experiments/B1-phase0-evidence/<slot>-<arm>.png
 *   - JSON records to docs/experiments/B1-phase0-evidence/<slot>-<arm>.json
 *
 * The script completes cleanly when the network is unreachable — rows are
 * marked "skipped (no network)" rather than hanging or crashing.
 *
 * Operational pass/fail definition (from fixture):
 *   PASS iff ALL of:
 *     1. Top-level navigation reaches HTTP 200.
 *     2. No element matching any challenge_selector is present in the DOM.
 *     3. document.querySelector('h1, h2, [role=heading]') exists and
 *        textContent.length > 0.
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function argValue(flag, fallback) {
  for (const arg of argv) {
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    if (arg === flag) return true;
  }
  return fallback;
}

const ARM = argValue('--arm', 'openchrome');

if (ARM !== 'openchrome' && ARM !== 'browsermcp') {
  console.error(`[B1-measure] Unknown --arm value: "${ARM}". Use "openchrome" or "browsermcp".`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load fixture
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'waf-targets.json');

if (!fs.existsSync(FIXTURE_PATH)) {
  console.error(`[B1-measure] Fixture not found: ${FIXTURE_PATH}`);
  process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

/** @type {Array<{slot: string, url: string, layer: string, role: string}>} */
const ALL_SLOTS = [...fixture.controls, ...fixture.targets];

/** @type {string[]} */
const ALL_SELECTORS = [
  ...fixture.challenge_selectors.cloudflare,
  ...fixture.challenge_selectors.perimeterx,
  ...fixture.challenge_selectors.datadome,
];

// ---------------------------------------------------------------------------
// Evidence output directory
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'experiments', 'B1-phase0-evidence');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check basic target reachability before spending time launching OpenChrome.
 * Returns true if the target responds to HEAD/GET, false otherwise.
 */
async function isTargetReachable(url) {
  return fetchWithTimeout(url, 'HEAD')
    .then((res) => res.status < 600)
    .catch(async () => {
      try {
        const res = await fetchWithTimeout(url, 'GET');
        return res.status < 600;
      } catch {
        return false;
      }
    });
}

async function fetchWithTimeout(url, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Format a JSON record and write it to the evidence directory. */
function writeRecord(slot, record) {
  const outPath = path.join(EVIDENCE_DIR, `${slot}-${ARM}.json`);
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  console.error(`[B1-measure] Wrote record: ${outPath}`);
}

/**
 * Parse the first text content item from an MCP tool result as JSON.
 *
 * OpenChrome tools return structured data as JSON inside result.content[0].text.
 * Keep this strict enough to catch contract drift, while still allowing callers
 * to decide whether absent/invalid JSON is fatal for a specific step.
 */
function parseToolTextJson(resp, toolName) {
  const firstText = resp?.result?.content?.find((item) => typeof item?.text === 'string')?.text;
  if (!firstText) return null;

  try {
    return JSON.parse(firstText);
  } catch (err) {
    console.error(`[B1-measure] ${toolName} returned non-JSON text: ${err.message}`);
    return null;
  }
}

function toolError(resp) {
  if (resp?.error) return resp.error;
  if (resp?.result?.isError) {
    const text = resp.result.content?.find((item) => typeof item?.text === 'string')?.text;
    return text || 'tool returned isError=true';
  }
  return null;
}

function appendError(result, message) {
  result.error = result.error ? `${result.error}; ${message}` : message;
}

function firstTextContent(resp) {
  return resp?.result?.content?.find((item) => typeof item?.text === 'string')?.text ?? null;
}

// ---------------------------------------------------------------------------
// OpenChrome arm — automated measurement via dist/index.js
// ---------------------------------------------------------------------------

const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

/**
 * Measure a single target via the OpenChrome MCP server.
 *
 * We spawn OpenChrome in stdio MCP mode, send the minimal JSON-RPC sequence
 * (initialize → navigate → evaluate checks → page_screenshot), then kill the child.
 *
 * @param {{slot: string, url: string}} target
 * @returns {Promise<{slot: string, url: string, pass: boolean, httpStatus: number|null, challengeFound: string|null, headingFound: boolean, screenshotPath: string|null, error: string|null, skipped: boolean}>}
 */
async function measureOpenChrome(target) {
  const { slot, url } = target;
  const result = {
    slot,
    url,
    arm: 'openchrome',
    pass: false,
    httpStatus: null,
    challengeFound: null,
    headingFound: false,
    screenshotPath: null,
    error: null,
    skipped: false,
    measuredAt: new Date().toISOString(),
  };

  if (!fs.existsSync(DIST_ENTRY)) {
    result.error = `dist/index.js not found at ${DIST_ENTRY}. Run 'npm run build' first.`;
    result.skipped = true;
    console.error(`[B1-measure][${slot}] SKIP: ${result.error}`);
    return result;
  }

  const screenshotPath = path.join(EVIDENCE_DIR, `${slot}-openchrome.png`);

  // We drive OpenChrome over its stdio MCP transport.
  // Each MCP call is a JSON-RPC 2.0 request; we parse responses from stdout.
  const child = spawn(process.execPath, [DIST_ENTRY, 'serve', '--transport', 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Disable health endpoint to avoid port conflicts during measurement.
      OPENCHROME_HEALTH_ENDPOINT: '0',
      OPENCHROME_PPID_WATCH: '0',
    },
  });

  let stdoutBuf = '';
  const pendingRpcs = new Map(); // id -> {resolve, reject}
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    // JSON-RPC responses are newline-delimited.
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pendingRpcs.has(msg.id)) {
        const { resolve } = pendingRpcs.get(msg.id);
        pendingRpcs.delete(msg.id);
        resolve(msg);
      }
    }
  });

  child.stderr.on('data', (d) => {
    // Forward diagnostic output so the caller can see server logs.
    for (const line of d.toString('utf8').split('\n')) {
      if (line.trim()) console.error(`  [oc-server][${slot}] ${line}`);
    }
  });

  const childDone = new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  /** Send a JSON-RPC request and await the response. Times out after timeoutMs. */
  function rpc(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pendingRpcs.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      pendingRpcs.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject,
      });
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      child.stdin.write(req);
    });
  }

  /** Send a JSON-RPC notification. Notifications do not have responses. */
  function notify(method, params) {
    const notification = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    child.stdin.write(notification);
  }

  function kill() {
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }

  try {
    // Step 1: MCP initialize handshake.
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'B1-phase0-measure', version: '0.1.0' },
    }, 15_000);
    notify('notifications/initialized', {});

    // Step 2: Navigate to the target URL. navigate's schema accepts only its
    // documented tool args; the RPC timeout controls this measurement call.
    const navigateResp = await rpc('tools/call', {
      name: 'navigate',
      arguments: { url },
    }, 45_000);

    const navigateError = toolError(navigateResp);
    if (navigateError) {
      result.error = `navigate failed: ${JSON.stringify(navigateError)}`;
      kill();
      return result;
    }

    const navResult = parseToolTextJson(navigateResp, 'navigate');
    const tabId = typeof navResult?.tabId === 'string' ? navResult.tabId : null;
    if (!tabId) {
      result.error = `navigate did not return tabId in result.content[0].text JSON`;
      kill();
      return result;
    }

    // Extract HTTP status from navigate result if a future tool version exposes
    // it. Missing status remains unknown; a successful navigate alone is not
    // enough to satisfy the Phase 0 HTTP 200 criterion.
    const navStatus = navResult?.httpStatus ?? navResult?.status;
    if (Number.isInteger(navStatus)) result.httpStatus = navStatus;

    if (result.httpStatus === null) {
      const statusResp = await rpc('tools/call', {
        name: 'javascript_tool',
        arguments: {
          tabId,
          code: `
            (function() {
              var nav = performance.getEntriesByType('navigation')[0];
              return nav && Number.isInteger(nav.responseStatus) ? nav.responseStatus : null;
            })()
          `,
        },
      }, 15_000);

      const statusError = toolError(statusResp);
      if (statusError) {
        appendError(result, `HTTP status unknown: ${JSON.stringify(statusError)}`);
      } else {
        const statusText = firstTextContent(statusResp);
        const status = statusText === null ? NaN : Number.parseInt(statusText.trim(), 10);
        if (Number.isInteger(status)) {
          result.httpStatus = status;
        } else {
          appendError(result, 'HTTP status unknown: navigate and performance timing did not expose a status');
        }
      }
    }

    // Step 3: Wait a moment for the page to settle (challenge interstitials
    // sometimes appear after a brief delay).
    await sleep(2000);

    // Step 4: Check for challenge interstitials via JavaScript evaluation.
    const selectorList = ALL_SELECTORS.map((s) => JSON.stringify(s)).join(', ');
    const checkScript = `
      (function() {
        var selectors = [${selectorList}];
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el) return selectors[i];
        }
        return null;
      })()
    `;

    const checkResp = await rpc('tools/call', {
      name: 'javascript_tool',
      arguments: { tabId, code: checkScript },
    }, 15_000);

    const checkError = toolError(checkResp);
    if (checkError) {
      result.challengeFound = 'unknown (javascript_tool error)';
      appendError(result, `challenge detection failed: ${JSON.stringify(checkError)}`);
    } else {
      const checkContent = checkResp.result?.content;
      if (Array.isArray(checkContent)) {
        for (const item of checkContent) {
          if (typeof item.text === 'string' && item.text.trim() !== 'null' && item.text.trim() !== '') {
            result.challengeFound = item.text.trim();
            break;
          }
        }
      }
    }

    // Step 5: Check for non-empty heading.
    const headingScript = `
      (function() {
        var el = document.querySelector('h1, h2, [role="heading"]');
        return el ? el.textContent.trim().length : 0;
      })()
    `;

    const headingResp = await rpc('tools/call', {
      name: 'javascript_tool',
      arguments: { tabId, code: headingScript },
    }, 15_000);

    if (!toolError(headingResp)) {
      const headingContent = headingResp.result?.content;
      if (Array.isArray(headingContent)) {
        for (const item of headingContent) {
          if (typeof item.text === 'string') {
            const len = parseInt(item.text.trim(), 10);
            result.headingFound = Number.isFinite(len) && len > 0;
            break;
          }
        }
      }
    }

    // Step 6: PNG screenshot for evidence.
    const screenshotResp = await rpc('tools/call', {
      name: 'page_screenshot',
      arguments: {
        tabId,
        path: screenshotPath,
        format: 'png',
        fullPage: false,
      },
    }, 20_000);

    if (!toolError(screenshotResp)) {
      const ssResult = parseToolTextJson(screenshotResp, 'page_screenshot');
      const savedPath = typeof ssResult?.path === 'string' ? ssResult.path : screenshotPath;
      if (fs.existsSync(savedPath)) {
        result.screenshotPath = savedPath;
        console.error(`[B1-measure][${slot}] Screenshot saved: ${savedPath}`);
      }
    } else {
      console.error(`[B1-measure][${slot}] Screenshot skipped: ${JSON.stringify(toolError(screenshotResp))}`);
    }

    // Evaluate pass/fail.
    result.pass = (
      result.httpStatus === 200 &&
      result.challengeFound === null &&
      result.headingFound === true
    );

    console.error(`[B1-measure][${slot}] ${result.pass ? 'PASS' : 'FAIL'} — http=${result.httpStatus} challenge=${result.challengeFound} heading=${result.headingFound}`);
  } catch (err) {
    result.error = err.message;
    console.error(`[B1-measure][${slot}] ERROR: ${err.message}`);
  } finally {
    kill();
    await Promise.race([childDone, sleep(5000)]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// BrowserMCP arm — manual instructions for a reviewer
// ---------------------------------------------------------------------------

function printBrowserMCPInstructions() {
  console.error('');
  console.error('==========================================================');
  console.error(' BrowserMCP arm — manual measurement instructions');
  console.error('==========================================================');
  console.error('');
  console.error('Prerequisites:');
  console.error('  1. Install the BrowserMCP extension from https://github.com/BrowserMCP/mcp');
  console.error('     (load unpacked in a profile-isolated Chrome; do NOT use your main profile).');
  console.error('  2. Configure your MCP host (e.g., Claude Code) to connect to BrowserMCP.');
  console.error('  3. Open this file alongside the fixture:');
  console.error(`     ${FIXTURE_PATH}`);
  console.error('');
  console.error('For each slot, ask your MCP host to:');
  console.error('  a) navigate to the URL');
  console.error('  b) call browser_snapshot to get the ARIA snapshot');
  console.error('  c) check for challenge selectors (see fixture challenge_selectors)');
  console.error('  d) check for a non-empty h1/h2/[role=heading]');
  console.error('  e) take a screenshot and save to:');
  console.error(`     ${EVIDENCE_DIR}/<slot>-browsermcp.png`);
  console.error('');
  console.error('Slots to measure:');
  for (const s of ALL_SLOTS) {
    console.error(`  ${s.slot.padEnd(4)}  ${s.url}`);
  }
  console.error('');
  console.error('Record results as JSON files matching the schema:');
  console.error('  { slot, url, arm:"browsermcp", pass, httpStatus, challengeFound, headingFound, screenshotPath, error, skipped, measuredAt }');
  console.error(`  Save to: ${EVIDENCE_DIR}/<slot>-browsermcp.json`);
  console.error('');
  console.error('Then re-run this script with --arm=openchrome (if not already done) and');
  console.error('paste both results tables into docs/experiments/extension-connector-phase0.md.');
  console.error('');
}

/**
 * Build a placeholder result record for the BrowserMCP arm (reviewer fills in).
 */
function buildBrowserMCPPlaceholder(target) {
  return {
    slot: target.slot,
    url: target.url,
    arm: 'browsermcp',
    pass: null,
    httpStatus: null,
    challengeFound: null,
    headingFound: null,
    screenshotPath: null,
    error: 'pending — fill in manually per instructions printed to stderr',
    skipped: false,
    pendingManual: true,
    measuredAt: null,
  };
}

// ---------------------------------------------------------------------------
// Markdown table renderer
// ---------------------------------------------------------------------------

/**
 * @param {Array<object>} records
 * @returns {string}
 */
function renderMarkdownTable(records) {
  const lines = [];
  lines.push('| Slot | URL | HTTP | Challenge | Heading | Pass? |');
  lines.push('|------|-----|------|-----------|---------|-------|');
  for (const r of records) {
    const slot = r.slot ?? '?';
    const url = r.url ?? '?';
    const http = r.pendingManual ? 'pending' : r.skipped ? 'skipped' : (r.httpStatus !== null ? String(r.httpStatus) : 'n/a');
    const challenge = r.pendingManual ? 'manual' : r.skipped ? 'skipped' : (r.challengeFound ? `\`${r.challengeFound}\`` : 'none');
    const heading = r.pendingManual ? 'manual' : r.skipped ? 'skipped' : (r.headingFound === true ? 'yes' : r.headingFound === false ? 'no' : 'n/a');
    const pass = r.pendingManual
      ? 'pending (manual)'
      : r.skipped
      ? 'skipped (no network)'
      : (r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'pending');
    lines.push(`| ${slot} | \`${url}\` | ${http} | ${challenge} | ${heading} | ${pass} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error(`[B1-measure] Phase 0 measurement spike — arm=${ARM}`);
  console.error(`[B1-measure] Platform: ${os.platform()} ${os.release()} node=${process.version}`);
  console.error(`[B1-measure] Fixture: ${FIXTURE_PATH}`);
  console.error(`[B1-measure] Evidence dir: ${EVIDENCE_DIR}`);
  console.error('');

  const records = [];

  if (ARM === 'browsermcp') {
    printBrowserMCPInstructions();
    for (const target of ALL_SLOTS) {
      const rec = buildBrowserMCPPlaceholder(target);
      records.push(rec);
      writeRecord(target.slot, rec);
    }
  } else {
    // openchrome arm
    for (const target of ALL_SLOTS) {
      const targetReachable = await isTargetReachable(target.url);
      if (!targetReachable) {
        console.error(`[B1-measure][${target.slot}] SKIP: target unreachable: ${target.url}`);
        const rec = {
          slot: target.slot,
          url: target.url,
          arm: 'openchrome',
          pass: false,
          httpStatus: null,
          challengeFound: null,
          headingFound: false,
          screenshotPath: null,
          error: 'skipped — no network',
          skipped: true,
          measuredAt: new Date().toISOString(),
        };
        records.push(rec);
        writeRecord(target.slot, rec);
        continue;
      }

      console.error(`[B1-measure] Measuring ${target.slot}: ${target.url}`);
      const rec = await measureOpenChrome(target);
      records.push(rec);
      writeRecord(target.slot, rec);

      // Brief pause between targets to avoid hammering WAF rate limits.
      await sleep(1500);
    }
  }

  // Emit the Markdown table to stdout (safe: this script is not an MCP server).
  const table = renderMarkdownTable(records);
  console.log('');
  console.log(`## B1-phase0 results — arm: ${ARM}`);
  console.log('');
  console.log(table);
  console.log('');

  const passCount = records.filter((r) => r.pass === true).length;
  const failCount = records.filter((r) => r.pass === false && !r.skipped).length;
  const skipCount = records.filter((r) => r.skipped).length;
  console.log(`> ${passCount} PASS, ${failCount} FAIL, ${skipCount} skipped`);
  console.log('');
  console.log(`Evidence files written to: ${EVIDENCE_DIR}`);
}

main().catch((err) => {
  console.error('[B1-measure] FATAL:', err);
  process.exit(1);
});
