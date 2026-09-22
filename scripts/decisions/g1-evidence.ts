import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

interface BaselineTask {
  readonly task: string;
  readonly intentional_failure: boolean;
  readonly mean_tool_calls: number;
}

interface DecisionRecord {
  readonly provider?: string;
  readonly downgraded?: boolean;
}

const outDir = path.join('artifacts', 'decision', 'G1');

function executable(command: string): string {
  return process.platform === 'win32' && ['npm', 'npx'].includes(command) ? `${command}.cmd` : command;
}

function run(command: string, args: readonly string[]): string {
  try {
    return execFileSync(executable(command), [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (error instanceof Error) return `ERROR: ${error.message}`;
    return `ERROR: ${String(error)}`;
  }
}

function sha256(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file: string): unknown {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed;
}

function writeJson(name: string, value: unknown): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function readDecisionRecords(file: string | undefined): DecisionRecord[] {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return parseDecisionRecord(parsed);
    });
}

function parseDecisionRecord(value: unknown): DecisionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.provider === 'string' ? { provider: record.provider } : {}),
    ...(typeof record.downgraded === 'boolean' ? { downgraded: record.downgraded } : {}),
  };
}

function baselineSummary(value: unknown): readonly BaselineTask[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const summary = (value as { readonly summary?: unknown }).summary;
  if (!Array.isArray(summary)) return [];
  return summary.flatMap((item): BaselineTask[] => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const task = item as Record<string, unknown>;
    if (typeof task.task !== 'string' || typeof task.intentional_failure !== 'boolean' || typeof task.mean_tool_calls !== 'number') return [];
    return [{ task: task.task, intentional_failure: task.intentional_failure, mean_tool_calls: task.mean_tool_calls }];
  });
}

function chromeVersion(): string {
  const windows = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
  ];
  const macos = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const linux = ['google-chrome', 'chromium'];
  const candidates = (process.platform === 'win32' ? windows : process.platform === 'darwin' ? macos : linux)
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    if ((path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')) && !fs.existsSync(candidate)) continue;
    const version = run(candidate, ['--version']);
    if (/Chrome|Chromium/i.test(version)) return version;
  }
  return 'not_found';
}

const generatedAt = new Date().toISOString();
const baselinePath = path.join('artifacts', 'decision', 'G0', 'baseline.json');
const measuredTasks = baselineSummary(readJson(baselinePath)).filter((task) => !task.intentional_failure);
const fixedStepDenominator = measuredTasks.reduce((sum, task) => sum + task.mean_tool_calls, 0);
const decisionRecordsPath = argValue('--decision-records');
const decisionRecords = readDecisionRecords(decisionRecordsPath);
const hostSamplingRequests = decisionRecords.filter((record) => record.provider === 'host').length;
const vendorDowngradeSteps = decisionRecords.filter((record) => record.downgraded === true).length;
const escalationNumerator = hostSamplingRequests + vendorDowngradeSteps;

writeJson('environment.json', {
  generated_at: generatedAt,
  cwd: process.cwd(),
  git: {
    head: run('git', ['rev-parse', 'HEAD']),
    branch: run('git', ['branch', '--show-current']),
    tags_at_head: run('git', ['tag', '--points-at', 'HEAD']).split(/\r?\n/).filter(Boolean),
    status_short: run('git', ['status', '--short']).split(/\r?\n/).filter(Boolean),
  },
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    chrome_version: chromeVersion(),
  },
  keys: {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ? 'present' : 'absent',
  },
});

writeJson('baseline-state.json', {
  generated_at: generatedAt,
  baseline_path: baselinePath,
  baseline_sha256: sha256(baselinePath),
  goal_sha256: sha256(path.join('..', 'openchrome-decider-goal.md')),
  ledger_sha256: sha256(path.join('..', 'openchrome-decider-ledger.json')),
  package_sha256: sha256('package.json'),
  package_lock_sha256: sha256('package-lock.json'),
  cache_state: {
    npm_cache: process.env.npm_config_cache ?? run('npm', ['config', 'get', 'cache']),
    decision_records_path: decisionRecordsPath ?? null,
    decision_records_count: decisionRecords.length,
  },
});

writeJson('ratio.json', {
  generated_at: generatedAt,
  denominator_basis: 'G0 measured non-intentional task mean_tool_calls',
  fixed_step_denominator: fixedStepDenominator,
  host_sampling_requests: hostSamplingRequests,
  vendor_downgrade_steps: vendorDowngradeSteps,
  escalation_numerator: escalationNumerator,
  escalation_ratio: fixedStepDenominator === 0 ? null : escalationNumerator / fixedStepDenominator,
  task_steps: measuredTasks.map((task) => ({ task: task.task, mean_tool_calls: task.mean_tool_calls })),
});

process.stderr.write(`G1 evidence written to ${outDir}\n`);
