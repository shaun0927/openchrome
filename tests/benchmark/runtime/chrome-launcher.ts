import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

export interface ChromeLaunchOptions {
  chromePath?: string;
  port: number;
  userDataDir?: string;
  extraArgs?: string[];
  spawnImpl?: typeof spawn;
  probe?: (endpoint: string) => Promise<boolean>;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ManagedChrome {
  endpoint: string;
  userDataDir: string;
  pid?: number;
  close(): Promise<void>;
}

export function resolveChromePath(env = process.env, platform = process.platform): string | null {
  if (env.OPENCHROME_BENCH_CHROME_PATH) return env.OPENCHROME_BENCH_CHROME_PATH;
  if (platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return fs.existsSync(p) ? p : null;
  }
  if (platform === 'win32') return env.ProgramFiles ? path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : null;
  return 'google-chrome';
}

export async function launchManagedChrome(options: ChromeLaunchOptions): Promise<ManagedChrome> {
  const chromePath = options.chromePath ?? resolveChromePath();
  if (!chromePath) throw new Error('Chrome path not found; set OPENCHROME_BENCH_CHROME_PATH');
  const userDataDir = options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-bench-profile-'));
  const endpoint = `http://127.0.0.1:${options.port}`;
  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--disable-background-networking',
    '--disable-default-apps',
    ...(options.extraArgs ?? []),
  ];
  const spawnImpl = options.spawnImpl ?? spawn;
  const proc = spawnImpl(chromePath, args, { stdio: 'ignore', detached: false }) as ChildProcess;
  const probe = options.probe ?? defaultCdpProbe;
  await waitForProbe(endpoint, probe, options.readinessTimeoutMs ?? 5000, options.pollIntervalMs ?? 100);
  return {
    endpoint,
    userDataDir,
    pid: proc.pid,
    async close() {
      if (!proc.killed) proc.kill();
    },
  };
}

async function waitForProbe(endpoint: string, probe: (endpoint: string) => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probe(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Chrome CDP endpoint did not become ready: ${endpoint}`);
}

async function defaultCdpProbe(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}
