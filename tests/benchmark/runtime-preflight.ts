#!/usr/bin/env ts-node
/** Runtime preflight for publishable benchmark rows.
 *
 * This does not run a benchmark. It checks whether the operator-provided
 * runtimes needed by live/headline benchmark rows are reachable and records
 * explicit missing-runtime blockers instead of letting axis runners silently
 * skip or fabricate evidence.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';
import { applyBenchmarkLiveSecretInputs } from './utils/live-secret-input';
import { captureEnvironment } from './utils/environment';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'runtime-preflight.json');

export type RuntimeStatus = 'ready' | 'missing' | 'blocked';
export type RuntimeName = 'chrome-cdp' | 'playwright-mcp' | 'browser-use' | 'llm-api-key';

export interface RuntimeProbeRow {
  runtime: RuntimeName;
  status: RuntimeStatus;
  requiredFor: string[];
  endpoint: string;
  evidence: string;
  remediation: string;
}

export interface RuntimePreflightOptions {
  cdpEndpoint: string;
  playwrightMcpServerPath?: string;
  browserUsePython: string;
  browserUseBridgeScript: string;
  requireLive: boolean;
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  const prefix = `${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

export function parseRuntimePreflightArgs(argv: string[]): RuntimePreflightOptions {
  return {
    cdpEndpoint: flagValue(argv, '--cdp-endpoint') ?? process.env.OPENCHROME_BENCH_CDP_ENDPOINT ?? 'http://127.0.0.1:9222',
    playwrightMcpServerPath: flagValue(argv, '--playwright-mcp-server-path') ?? process.env.PLAYWRIGHT_MCP_SERVER_PATH,
    browserUsePython: flagValue(argv, '--browser-use-python') ?? process.env.BROWSER_USE_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
    browserUseBridgeScript: flagValue(argv, '--browser-use-bridge') ?? process.env.BROWSER_USE_BRIDGE_SCRIPT ?? path.join(__dirname, 'bridges', 'browser_use_bridge.py'),
    requireLive: argv.includes('--require-live') || process.env.OPENCHROME_BENCH_REQUIRE_LIVE === '1',
  };
}

function parseHostPort(endpoint: string): { host: string; port: number } {
  const url = new URL(endpoint);
  return { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
}

async function canConnect(endpoint: string, timeoutMs = 1000): Promise<boolean> {
  const { host, port } = parseHostPort(endpoint);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function probeChromeCdp(options: RuntimePreflightOptions): Promise<RuntimeProbeRow> {
  const reachable = await canConnect(options.cdpEndpoint);
  return reachable
    ? {
        runtime: 'chrome-cdp',
        status: 'ready',
        requiredFor: ['live token extractors', 'live throughput', 'reliability CDP faults', 'real-world browser episodes'],
        endpoint: options.cdpEndpoint,
        evidence: 'TCP connection to CDP endpoint succeeded',
        remediation: '',
      }
    : {
        runtime: 'chrome-cdp',
        status: 'missing',
        requiredFor: ['live token extractors', 'live throughput', 'reliability CDP faults', 'real-world browser episodes'],
        endpoint: options.cdpEndpoint,
        evidence: 'CDP endpoint is not reachable',
        remediation: 'Start Chrome with --remote-debugging-port=9222 and set OPENCHROME_BENCH_CDP_ENDPOINT if using a different endpoint.',
      };
}

function resolvePlaywrightMcp(serverPath?: string): string | null {
  if (serverPath && fs.existsSync(serverPath)) return serverPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require.resolve('@playwright/mcp/cli.js');
  } catch {
    return null;
  }
}

function probePlaywrightMcp(options: RuntimePreflightOptions): RuntimeProbeRow {
  const serverPath = resolvePlaywrightMcp(options.playwrightMcpServerPath);
  return serverPath
    ? {
        runtime: 'playwright-mcp',
        status: 'ready',
        requiredFor: ['native competitor adapter matrix', 'playwright-mcp token payloads', 'real-world competitor episodes'],
        endpoint: serverPath,
        evidence: 'playwright-mcp CLI path resolved',
        remediation: '',
      }
    : {
        runtime: 'playwright-mcp',
        status: 'missing',
        requiredFor: ['native competitor adapter matrix', 'playwright-mcp token payloads', 'real-world competitor episodes'],
        endpoint: options.playwrightMcpServerPath ?? '@playwright/mcp/cli.js',
        evidence: 'playwright-mcp CLI path could not be resolved',
        remediation: 'Install @playwright/mcp or set PLAYWRIGHT_MCP_SERVER_PATH to its cli.js path.',
      };
}

function probeBrowserUse(options: RuntimePreflightOptions): RuntimeProbeRow {
  const bridgeExists = fs.existsSync(options.browserUseBridgeScript);
  const py = spawnSync(options.browserUsePython, ['--version'], { encoding: 'utf8' });
  const pythonOk = py.status === 0;
  return bridgeExists && pythonOk
    ? {
        runtime: 'browser-use',
        status: 'ready',
        requiredFor: ['browser-use native competitor rows', 'browser-use real-world episodes'],
        endpoint: `${options.browserUsePython} ${options.browserUseBridgeScript}`,
        evidence: `Python available (${(py.stdout || py.stderr).trim()}); bridge script exists`,
        remediation: '',
      }
    : {
        runtime: 'browser-use',
        status: 'missing',
        requiredFor: ['browser-use native competitor rows', 'browser-use real-world episodes'],
        endpoint: `${options.browserUsePython} ${options.browserUseBridgeScript}`,
        evidence: `pythonOk=${pythonOk}; bridgeExists=${bridgeExists}`,
        remediation: 'Install Python/browser-use dependencies and set BROWSER_USE_PYTHON/BROWSER_USE_BRIDGE_SCRIPT if needed.',
      };
}

function probeLlmApiKey(): RuntimeProbeRow {
  const hasAnthropic = typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0;
  const hasOpenAI = typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length > 0;
  return hasAnthropic || hasOpenAI
    ? {
        runtime: 'llm-api-key',
        status: 'ready',
        requiredFor: ['real LLM tool-use loop', 'episode token/USD accounting', 'WebVoyager repetitions'],
        endpoint: hasAnthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
        evidence: 'At least one supported LLM API key is present in the environment',
        remediation: '',
      }
    : {
        runtime: 'llm-api-key',
        status: 'missing',
        requiredFor: ['real LLM tool-use loop', 'episode token/USD accounting', 'WebVoyager repetitions'],
        endpoint: 'ANTHROPIC_API_KEY or OPENAI_API_KEY',
        evidence: 'No supported LLM API key found in environment',
        remediation: 'Export ANTHROPIC_API_KEY or OPENAI_API_KEY before running live LLM benchmark loops.',
      };
}

export async function runRuntimePreflight(options: RuntimePreflightOptions): Promise<RuntimeProbeRow[]> {
  return [
    await probeChromeCdp(options),
    probePlaywrightMcp(options),
    probeBrowserUse(options),
    probeLlmApiKey(),
  ];
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function format(rows: readonly RuntimeProbeRow[]): string {
  return [
    'Benchmark runtime preflight — fail-closed live readiness',
    'runtime          status    endpoint/evidence',
    ...rows.map((row) => `${row.runtime.padEnd(16)} ${row.status.padEnd(8)} ${row.evidence}`),
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  applyBenchmarkLiveSecretInputs(argv);
  const options = parseRuntimePreflightArgs(argv);
  const rows = await runRuntimePreflight(options);
  const envelope = buildResultEnvelope({
    axis: 'foundation',
    environment: captureEnvironment(),
    competitors: [{ name: 'OpenChrome runtime preflight', version: readRepoVersion() }],
    results: rows,
  });
  assertValidResultEnvelope(envelope);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(envelope, null, 2) + '\n');
  console.error(format(rows));
  console.error(`Saved: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  if (options.requireLive && rows.some((row) => row.status !== 'ready')) {
    throw new Error('OPENCHROME_BENCH_REQUIRE_LIVE failed: one or more required runtimes are missing');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('runtime preflight failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
