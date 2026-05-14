/**
 * Environment metadata capture for the competitive benchmark suite.
 *
 * Every result JSON produced by any benchmark axis MUST embed an
 * `EnvironmentMetadata` block. Without it a result is not reproducible and
 * cannot be compared across machines or across time — see Epic #1254
 * methodology principle #3.
 */

import * as os from 'os';
import { execFileSync } from 'child_process';

export interface EnvironmentMetadata {
  /** ISO-8601 timestamp of capture. */
  capturedAt: string;
  /** Short git SHA of the working tree, or 'unknown' if not a git checkout. */
  gitSha: string;
  /** True when the working tree had uncommitted changes at capture time. */
  gitDirty: boolean;
  /** Node.js version, e.g. 'v20.11.0'. */
  nodeVersion: string;
  /** OS platform + release, e.g. 'darwin 25.3.0'. */
  os: string;
  /** Architecture, e.g. 'arm64'. */
  arch: string;
  /** CPU model string of the first core. */
  cpuModel: string;
  /** Logical CPU count. */
  cpuCount: number;
  /** Total system RAM in bytes. */
  totalMemoryBytes: number;
  /** Detected Chrome / Chromium version, or 'unknown'. */
  chromeVersion: string;
  /** Free-form network profile label, e.g. 'unthrottled' or 'fast-3g'. */
  networkProfile: string;
  /** LLM model id + temperature, present only for LLM-driven axes (#B). */
  llm?: { model: string; temperature: number };
}

export interface CaptureEnvironmentOptions {
  /** Path to a Chrome/Chromium binary to version-probe. */
  chromePath?: string;
  /** Network profile label to record. Defaults to 'unthrottled'. */
  networkProfile?: string;
  /** LLM metadata for LLM-driven axes. */
  llm?: { model: string; temperature: number };
}

function tryExec(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function captureGit(): { gitSha: string; gitDirty: boolean } {
  const sha = tryExec('git', ['rev-parse', '--short', 'HEAD']);
  if (sha === null) {
    return { gitSha: 'unknown', gitDirty: false };
  }
  const status = tryExec('git', ['status', '--porcelain']);
  return { gitSha: sha, gitDirty: status !== null && status.length > 0 };
}

function captureChromeVersion(chromePath?: string): string {
  const candidates = chromePath
    ? [chromePath]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium']
      : process.platform === 'win32'
        ? ['chrome', 'chrome.exe']
        : ['google-chrome', 'chromium', 'chromium-browser'];

  for (const candidate of candidates) {
    const out = tryExec(candidate, ['--version']);
    if (out !== null && out.length > 0) {
      return out;
    }
  }
  return 'unknown';
}

/**
 * Capture the current environment. Pure read-only — safe to call from any
 * runner. Each individual probe degrades gracefully to 'unknown' rather than
 * throwing, so a missing git or Chrome never aborts a benchmark.
 */
export function captureEnvironment(options: CaptureEnvironmentOptions = {}): EnvironmentMetadata {
  const cpus = os.cpus();
  const git = captureGit();

  const metadata: EnvironmentMetadata = {
    capturedAt: new Date().toISOString(),
    gitSha: git.gitSha,
    gitDirty: git.gitDirty,
    nodeVersion: process.version,
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus.length > 0 ? cpus[0].model.trim() : 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    chromeVersion: captureChromeVersion(options.chromePath),
    networkProfile: options.networkProfile ?? 'unthrottled',
  };

  if (options.llm) {
    metadata.llm = options.llm;
  }

  return metadata;
}
