/**
 * openchrome doctor — holistic environment diagnostic CLI (#898)
 *
 * Runs a fixed sequence of environment checks, classifies each as
 * ok | warn | fail | skip, and prints an actionable report.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getVersion } from '../core/version';
import { checkNodeVersion } from './doctor/checks/node-version';
import { checkHomeWritable } from './doctor/checks/home-writable';
import { checkChromeBinary } from './doctor/checks/chrome-binary';
import { checkChromePort } from './doctor/checks/chrome-port';
import { checkPidLock } from './doctor/checks/pid-lock';
import { checkOrphanChrome } from './doctor/checks/orphan-chrome';
import { checkProfileLock } from './doctor/checks/profile-lock';
import { checkDiskSpace } from './doctor/checks/disk-space';
import { checkMacosPerms } from './doctor/checks/macos-perms';
import { checkNetworkLocal } from './doctor/checks/network-local';
import { checkNetworkRemote } from './doctor/checks/network-remote';
import { checkOptionalDeps } from './doctor/checks/optional-deps';
import { checkDuplicateControllers } from './doctor/checks/duplicate-controllers';
import { collectDoctorDiagnostics, type DoctorDiagnostics } from './doctor/runtime-diagnostics';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  remediation?: string;
  /** Short factual cause, safe for machine readers. */
  reason?: string;
  /** Primary next action. Mirrors remediation when no better structured action exists. */
  next_action?: string;
  /** Safe alternatives that do not change OpenChrome policy by themselves. */
  safe_alternatives?: string[];
  docs?: string[];
  facts?: Record<string, unknown>;
  durationMs: number;
}

export interface DoctorReport {
  openchromeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  startedAt: string;
  results: CheckResult[];
  diagnostics: DoctorDiagnostics;
  summary: { ok: number; warn: number; fail: number; skip: number };
  exitCode: 0 | 1 | 2;
}

export type CheckFn = () => Promise<Omit<CheckResult, 'durationMs'>>;

const CHECK_TIMEOUT_MS = 5000;


function prescriptiveDefaults(result: Omit<CheckResult, 'durationMs'>): Partial<CheckResult> {
  if (result.status === 'ok' || result.status === 'skip') {
    return {};
  }

  const nextAction = result.remediation;
  const base: Partial<CheckResult> = {
    ...(result.detail ? { reason: result.detail } : {}),
    ...(nextAction ? { next_action: nextAction } : {}),
  };

  switch (result.id) {
    case 'chrome-binary':
      return {
        ...base,
        docs: ['https://www.google.com/chrome/'],
        safe_alternatives: [
          'Install Google Chrome and rerun openchrome doctor.',
          'Set CHROME_PATH to an existing Chrome or chrome-headless-shell binary.',
        ],
      };
    case 'chrome-port':
      return {
        ...base,
        safe_alternatives: [
          'Free the configured CDP port, then rerun openchrome doctor.',
          'Use a different --port or CHROME_PORT value for this OpenChrome instance.',
          'If another OpenChrome owner should be shared, connect through the broker path instead of creating a second direct controller.',
        ],
        docs: ['docs/mcp/topologies.md'],
      };
    case 'duplicate-controllers':
      return {
        ...base,
        safe_alternatives: [
          'Use --broker/--connect-broker or --auto-elect for coordinated sharing when enabled.',
          'Do not use --allow-unsafe-shared-attach unless debugging a known race; it is intentionally not selected by default.',
          'Assign independent clients separate --port and --user-data-dir values.',
        ],
        docs: ['docs/mcp/topologies.md'],
      };
    case 'pid-lock':
      return {
        ...base,
        safe_alternatives: [
          'Run openchrome reap to clean stale OpenChrome-managed state.',
          'Remove only the stale PID file named in the detail if the process is no longer alive.',
        ],
      };
    case 'profile-lock':
      return {
        ...base,
        safe_alternatives: [
          'Close Chrome windows using this profile before reusing it.',
          'Use --user-data-dir to point OpenChrome at a separate profile.',
        ],
        docs: ['docs/mcp/topologies.md'],
      };
    default:
      return base;
  }
}

export function withPrescriptiveFields(result: Omit<CheckResult, 'durationMs'>): Omit<CheckResult, 'durationMs'> {
  const defaults = prescriptiveDefaults(result);
  return {
    ...result,
    ...defaults,
    reason: result.reason ?? defaults.reason,
    next_action: result.next_action ?? defaults.next_action,
    safe_alternatives: result.safe_alternatives ?? defaults.safe_alternatives,
    docs: result.docs ?? defaults.docs,
    facts: result.facts ?? defaults.facts,
  };
}

const ALL_CHECKS: Array<{ id: string; fn: CheckFn }> = [
  { id: 'node-version', fn: checkNodeVersion },
  { id: 'home-writable', fn: checkHomeWritable },
  { id: 'chrome-binary', fn: checkChromeBinary },
  { id: 'chrome-port', fn: checkChromePort },
  { id: 'pid-lock', fn: checkPidLock },
  { id: 'orphan-chrome', fn: checkOrphanChrome },
  { id: 'profile-lock', fn: checkProfileLock },
  { id: 'duplicate-controllers', fn: checkDuplicateControllers },
  { id: 'disk-space', fn: checkDiskSpace },
  { id: 'macos-perms', fn: checkMacosPerms },
  { id: 'network-local', fn: checkNetworkLocal },
  { id: 'network-remote', fn: checkNetworkRemote },
  { id: 'optional-deps', fn: checkOptionalDeps },
];

async function runCheckWithTimeout(id: string, fn: CheckFn): Promise<CheckResult> {
  const start = Date.now();
  let partial: Omit<CheckResult, 'durationMs'>;
  try {
    partial = await Promise.race([
      fn(),
      new Promise<Omit<CheckResult, 'durationMs'>>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Find the check title from the ALL_CHECKS list (fallback to id)
    const entry = ALL_CHECKS.find(c => c.id === id);
    const title = entry ? id : id;
    partial = {
      id,
      title,
      status: 'fail',
      detail: msg === 'timed out' ? 'timed out' : `Error: ${msg}`,
    };
  }
  return { ...withPrescriptiveFields(partial), durationMs: Date.now() - start };
}

export async function runDoctor(options: {
  checks?: string[];
  remote?: boolean;
}): Promise<DoctorReport> {
  const startedAt = new Date().toISOString();

  let checksToRun = ALL_CHECKS;
  if (options.checks && options.checks.length > 0) {
    checksToRun = ALL_CHECKS.filter(c => options.checks!.includes(c.id));
  }
  // Skip network-remote unless --remote is passed
  if (!options.remote) {
    checksToRun = checksToRun.filter(c => c.id !== 'network-remote');
  }

  const results: CheckResult[] = [];
  for (const { id, fn } of checksToRun) {
    const result = await runCheckWithTimeout(id, fn);
    results.push(result);
  }

  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) {
    summary[r.status]++;
  }

  const exitCode: 0 | 1 | 2 = summary.fail > 0 ? 2 : summary.warn > 0 ? 1 : 0;
  const diagnostics = collectDoctorDiagnostics();

  return {
    openchromeVersion: getVersion(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.versions.node,
    startedAt,
    results,
    diagnostics,
    summary,
    exitCode,
  };
}

function statusColor(status: CheckStatus, noColor: boolean): string {
  if (noColor) {
    switch (status) {
      case 'ok': return '  ok  ';
      case 'warn': return ' warn ';
      case 'fail': return ' fail ';
      case 'skip': return ' skip ';
    }
  }
  switch (status) {
    case 'ok':   return '\x1b[32m  ok  \x1b[0m';
    case 'warn': return '\x1b[33m warn \x1b[0m';
    case 'fail': return '\x1b[31m fail \x1b[0m';
    case 'skip': return '\x1b[90m skip \x1b[0m';
  }
}

export function formatReport(report: DoctorReport, noColor: boolean): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('=== openchrome doctor ===');
  lines.push('');

  for (const r of report.results) {
    const statusStr = statusColor(r.status, noColor);
    const detail = r.detail ? `  ${r.detail}` : '';
    lines.push(`[${statusStr}] ${r.title}${detail}`);
    if (r.status !== 'ok' && r.status !== 'skip') {
      if (r.remediation && (!r.next_action || r.next_action === r.remediation)) {
        lines.push(`         Fix: ${r.remediation}`);
      } else if (r.next_action) {
        lines.push(`         Next: ${r.next_action}`);
      } else if (r.remediation) {
        lines.push(`         Fix: ${r.remediation}`);
      }
    }
    if (r.safe_alternatives && r.safe_alternatives.length > 0 && r.status !== 'ok' && r.status !== 'skip') {
      for (const alternative of r.safe_alternatives.slice(0, 2)) {
        lines.push(`         Also: ${alternative}`);
      }
    }
  }

  lines.push('');
  const { ok, warn, fail, skip } = report.summary;
  const summaryParts = [`Doctor: ${ok} ok`];
  if (warn > 0) summaryParts.push(`${warn} warn`);
  if (fail > 0) summaryParts.push(`${fail} fail`);
  if (skip > 0) summaryParts.push(`${skip} skip`);
  lines.push(summaryParts.join(', '));
  lines.push('');

  return lines.join('\n');
}

export async function writeDiagnosticsCache(report: DoctorReport): Promise<void> {
  const dir = path.join(os.homedir(), '.openchrome', 'diagnostics');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'last-report.json');
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.error('[doctor] Failed to write diagnostics cache:', err);
  }
}
