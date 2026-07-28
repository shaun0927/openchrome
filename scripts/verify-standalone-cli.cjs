#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--binary') options.binary = path.resolve(argv[++index]);
    else if (arg === '--expected-target') options.expectedTarget = argv[++index];
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function normalize(output) {
  return output.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function run(command, args, cleanPath = false) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: cleanPath ? '' : process.env.PATH,
      OPENCHROME_UPDATE_CHECK: '0',
      OPENCHROME_PPID_WATCH: '0',
    },
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return normalize(result.stdout);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function listTools(command, prefixArgs, minimal, cleanPath) {
  const port = String(20_000 + Math.floor(Math.random() * 20_000));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-standalone-parity-'));
  const args = [
    ...prefixArgs,
    'serve',
    '--port',
    port,
    '--user-data-dir',
    userDataDir,
    ...(minimal ? ['--minimal'] : []),
  ];
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: cleanPath ? '' : process.env.PATH,
      OPENCHROME_UPDATE_CHECK: '0',
      OPENCHROME_PPID_WATCH: '0',
    },
  });
  if (!child.stdin || !child.stdout) throw new Error('Failed to open MCP stdio pipes.');
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let stderr = '';
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.includes('STDIO transport enabled')) readyResolve();
  });
  rl.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    } catch {
      // Ignore non-JSON diagnostic output.
    }
  });

  let nextId = 1;
  let readinessTimer;
  const prepareRequest = (method, params) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. ${stderr.split('\n').slice(-8).join('\n')}`));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method} failed: ${message.error.message}`));
        else resolve(message.result);
      });
    });
    return {
      line: `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      promise,
    };
  };

  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        readinessTimer = setTimeout(
          () => reject(new Error(`Timed out waiting for stdio readiness. ${stderr.split('\n').slice(-8).join('\n')}`)),
          30_000,
        );
      }),
    ]);
    if (readinessTimer) {
      clearTimeout(readinessTimer);
      readinessTimer = undefined;
    }
    const initialize = prepareRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'openchrome-standalone-parity', version: '1' },
    });
    const toolsList = prepareRequest('tools/list', {});
    child.stdin.write(
      initialize.line +
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n` +
      toolsList.line,
    );
    await initialize.promise;
    const result = await toolsList.promise;
    return (result.tools || []).map((tool) => tool.name).sort();
  } finally {
    if (readinessTimer) clearTimeout(readinessTimer);
    rl.close();
    child.stdin.end();
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/verify-standalone-cli.cjs --binary <path> [--expected-target <triple>]\n');
    return;
  }
  if (!options.binary || !fs.existsSync(options.binary)) throw new Error('--binary must name an existing executable.');

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const nodeCli = path.join(repoRoot, 'dist', 'cli', 'index.js');
  const nodeServer = path.join(repoRoot, 'dist', 'index.js');
  const binaryCommand = options.binary;

  const commandPairs = [
    { name: 'version', node: [nodeCli, '--version'], binary: ['--version'] },
    { name: 'serve-help', node: [nodeServer, 'serve', '--help'], binary: ['serve', '--help'] },
    { name: 'check-help', node: [nodeServer, 'check', '--help'], binary: ['check', '--help'] },
    { name: 'doctor-help', node: [nodeServer, 'doctor', '--help'], binary: ['doctor', '--help'] },
    { name: 'config-codex', node: [nodeCli, 'config', '--client', 'codex'], binary: ['config', '--client', 'codex'] },
    { name: 'setup-help', node: [nodeCli, 'setup', '--help'], binary: ['setup', '--help'] },
    { name: 'run-help', node: [nodeCli, 'run', '--help'], binary: ['run', '--help'] },
    { name: 'playbook-help', node: [nodeCli, 'playbook', '--help'], binary: ['playbook', '--help'] },
  ];
  const commandHashes = {};
  for (const pair of commandPairs) {
    const expected = run(process.execPath, pair.node);
    const actual = run(binaryCommand, pair.binary, true);
    if (actual !== expected) throw new Error(`${pair.name} output differs between npm and standalone CLI.`);
    commandHashes[pair.name] = hash(actual);
  }

  const validationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-standalone-validation-'));
  const validationPath = path.join(validationDir, 'playbook.json');
  try {
    fs.writeFileSync(validationPath, `${JSON.stringify({
      name: 'standalone CLI self-spawn validation',
      steps: [{ navigate: { url: 'https://example.com' } }],
    }, null, 2)}\n`);
    const expected = run(process.execPath, [
      nodeCli,
      'playbook',
      'validate',
      validationPath,
      '--json',
    ]);
    const actual = run(binaryCommand, [
      'playbook',
      'validate',
      validationPath,
      '--json',
    ], true);
    if (actual !== expected) throw new Error('playbook validate output differs between npm and standalone CLI.');
    commandHashes['playbook-validate'] = hash(actual);
  } finally {
    fs.rmSync(validationDir, { recursive: true, force: true });
  }

  if (run(binaryCommand, ['--version'], true) !== packageJson.version) {
    throw new Error('Standalone --version does not match package.json.');
  }

  const buildInfo = JSON.parse(run(binaryCommand, ['build-info'], true));
  if (!buildInfo.standalone || buildInfo.version !== packageJson.version) {
    throw new Error('Standalone build-info is missing embedded version/provenance.');
  }
  if (options.expectedTarget && buildInfo.target !== options.expectedTarget) {
    throw new Error(`Standalone target ${buildInfo.target} does not match ${options.expectedTarget}.`);
  }

  const manifestHashes = {};
  for (const minimal of [false, true]) {
    const args = ['serve', ...(minimal ? ['--minimal'] : []), '--introspect-tools-list'];
    const expected = run(process.execPath, [nodeServer, ...args]);
    const actual = run(binaryCommand, args, true);
    if (actual !== expected) throw new Error(`${minimal ? 'minimal' : 'full'} introspection manifest differs.`);
    manifestHashes[minimal ? 'minimal' : 'full'] = hash(actual);

    const nodeTools = await listTools(process.execPath, [nodeServer], minimal, false);
    const binaryTools = await listTools(binaryCommand, [], minimal, true);
    if (JSON.stringify(binaryTools) !== JSON.stringify(nodeTools)) {
      throw new Error(`${minimal ? 'minimal' : 'full'} MCP tools/list differs.`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    binary: options.binary,
    buildInfo,
    commandHashes,
    manifestHashes,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`[standalone-verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
