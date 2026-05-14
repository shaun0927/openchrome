#!/usr/bin/env node
/**
 * Reproducer helper for issue #849 (`--auto-connect` via DevToolsActivePort).
 *
 * The full verification requires a human/reviewer to launch Chrome manually and
 * then run OpenChrome/MCP calls. This script prints platform-specific commands
 * and validates a provided DevToolsActivePort file when OC_AUTO_CONNECT_DIR is
 * set. It is intentionally side-effect-light: no Chrome process is launched by
 * default.
 *
 * Usage:
 *   node scripts/verify/E-auto-connect.mjs
 *   OC_AUTO_CONNECT_DIR=/tmp/oc-verify-E node scripts/verify/E-auto-connect.mjs
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dir = process.env.OC_AUTO_CONNECT_DIR;

function chromeCommand(userDataDir) {
  const url = 'https://en.wikipedia.org/wiki/Main_Page';
  if (process.platform === 'darwin') {
    return `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=0 --user-data-dir=${userDataDir} ${url}`;
  }
  if (process.platform === 'win32') {
    return `"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=0 --user-data-dir=${userDataDir} ${url}`;
  }
  return `google-chrome --remote-debugging-port=0 --user-data-dir=${userDataDir} ${url}`;
}

function parseActivePort(raw) {
  const [portLine, pathLine = '/devtools/browser'] = raw.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid DevToolsActivePort port: ${JSON.stringify(portLine)}`);
  }
  const browserTargetPath = pathLine.startsWith('/') ? pathLine : `/${pathLine}`;
  return { port, browserTargetPath, wsEndpoint: `ws://127.0.0.1:${port}${browserTargetPath}` };
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 1000 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

function printChecklist(userDataDir) {
  console.log('# #849 auto-connect verification');
  console.log(`mkdir -p ${userDataDir}`);
  console.log(chromeCommand(userDataDir));
  console.log(`\n# wait until ${path.join(userDataDir, 'DevToolsActivePort')} exists`);
  console.log(`openchrome serve --auto-connect=${userDataDir}`);
  console.log('\n# MCP checks:');
  console.log('- oc_get_connection_info(host="openchrome") => {mode:"auto-connect", userDataDir, port}');
  console.log('- tabs_context lists the manually opened Wikipedia tab');
  console.log('- navigate that tab to https://example.com succeeds');
  console.log('- oc_connection_health reports lifecycleMode:"attach"');
  console.log('- stopping OpenChrome leaves the manual Chrome process alive');
  console.log('- --auto-connect combined with --launch-mode=auto or isolated exits non-zero');
  console.log('- stale DevToolsActivePort with closed port fails within the timeout');
}

const defaultDir = path.join(os.tmpdir(), 'oc-verify-E');
printChecklist(dir ?? defaultDir);

if (dir) {
  const file = path.join(dir, 'DevToolsActivePort');
  if (!fs.existsSync(file)) {
    console.error(`\n[E-auto-connect] FAIL: ${file} does not exist`);
    process.exit(2);
  }
  const parsed = parseActivePort(fs.readFileSync(file, 'utf8'));
  const bound = await probePort(parsed.port);
  console.log(`\n[E-auto-connect] Parsed ${file}: ${JSON.stringify(parsed)}`);
  console.log(`[E-auto-connect] Port bound: ${bound}`);
  process.exit(bound ? 0 : 3);
}
