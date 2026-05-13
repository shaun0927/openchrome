/** File-based episode trajectory bundle writer (#1059). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, createHash } from 'crypto';
import type { ContractResultEntry } from '../recording/types';

export type TrajectoryEventKind = 'tool_call_end' | 'checkpoint' | 'contract' | 'hint' | 'recovery' | 'error';

export interface TrajectoryEvent {
  version: 1;
  trajectory_id: string;
  seq: number;
  ts: number;
  sessionId: string;
  tabId?: string;
  event: TrajectoryEventKind;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
  argsSummary?: Record<string, unknown>;
  resultSummary?: Record<string, unknown>;
  state?: { url?: string; title?: string; domTextHash?: string; screenshotHash?: string };
  progress?: { status?: 'progressing' | 'stalling' | 'stuck'; noProgressStreak?: number; rule?: string; severity?: 'info' | 'warning' | 'critical' };
  refs?: { beforeScreenshot?: string; afterScreenshot?: string; checkpoint?: string; contractEvidence?: string };
}

export interface TrajectoryReport {
  trajectory_id: string;
  started_at: string;
  ended_at?: string;
  total_events: number;
  tool_calls: number;
  failures: number;
  progress: { stalling_events: number; stuck_events: number };
  contracts: { pass: number; fail: number; inconclusive: number };
  artifacts: { events: string; screenshots: number; checkpoints: number; contracts: number };
}

export interface TrajectoryMeta {
  version: 1;
  trajectory_id: string;
  sessionId: string;
  recordingId: string;
  started_at: string;
  root: string;
}

const SUMMARY_MAX_BYTES = 4096;
const REDACT_KEYS = /password|token|secret|credential|api[_-]?key|authorization|auth[_-]?token/i;
const REDACT_TOOLS = new Set(['cookies', 'http_auth']);

export const DEFAULT_TRAJECTORY_ROOT = path.join(os.homedir(), '.openchrome', 'trajectories');

export function generateTrajectoryId(): string {
  const now = new Date();
  const date = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}`;
  return `traj-${date}-${time}-${randomBytes(3).toString('hex')}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bounded(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= SUMMARY_MAX_BYTES) return value;
  return { truncated: true, originalBytes: bytes, sha256: hashText(json) };
}

export function redactSummary(tool: string | undefined, value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (tool && REDACT_TOOLS.has(tool)) return { _redacted: true };
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (REDACT_KEYS.test(key)) {
      out[key] = '[REDACTED]';
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      out[key] = redactSummary(undefined, raw as Record<string, unknown>);
    } else {
      out[key] = raw;
    }
  }
  return bounded(out);
}

export class TrajectoryBundleWriter {
  readonly trajectoryId: string;
  readonly dir: string;

  private readonly sessionId: string;
  private readonly startedAt: string;
  private seq = 0;
  private disabled = false;
  private report: TrajectoryReport;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(input: { trajectoryId: string; dir: string; sessionId: string; startedAt: string }) {
    this.trajectoryId = input.trajectoryId;
    this.dir = input.dir;
    this.sessionId = input.sessionId;
    this.startedAt = input.startedAt;
    this.report = {
      trajectory_id: input.trajectoryId,
      started_at: input.startedAt,
      total_events: 0,
      tool_calls: 0,
      failures: 0,
      progress: { stalling_events: 0, stuck_events: 0 },
      contracts: { pass: 0, fail: 0, inconclusive: 0 },
      artifacts: { events: 'events.jsonl', screenshots: 0, checkpoints: 0, contracts: 0 },
    };
  }

  static async create(input: { sessionId: string; recordingId: string; rootDir?: string }): Promise<TrajectoryBundleWriter> {
    const trajectoryId = generateTrajectoryId();
    const root = input.rootDir ?? DEFAULT_TRAJECTORY_ROOT;
    const dir = path.join(root, trajectoryId);
    const startedAt = new Date().toISOString();
    const writer = new TrajectoryBundleWriter({ trajectoryId, dir, sessionId: input.sessionId, startedAt });
    await fs.promises.mkdir(path.join(dir, 'screenshots'), { recursive: true });
    await fs.promises.mkdir(path.join(dir, 'checkpoints'), { recursive: true });
    await fs.promises.mkdir(path.join(dir, 'contracts'), { recursive: true });
    const meta: TrajectoryMeta = { version: 1, trajectory_id: trajectoryId, sessionId: input.sessionId, recordingId: input.recordingId, started_at: startedAt, root };
    await fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return writer;
  }

  get snapshot(): { enabled: true; trajectory_id: string; dir: string } {
    return { enabled: true, trajectory_id: this.trajectoryId, dir: this.dir };
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(op, op).catch((err) => {
      if (!this.disabled) {
        this.disabled = true;
        console.error('[TrajectoryBundle] disabled after write failure:', err instanceof Error ? err.message : err);
      }
    });
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  appendToolCall(input: { tool: string; args: Record<string, unknown>; durationMs: number; ok: boolean; tabId?: string; url?: string; error?: string; screenshotBefore?: string; screenshotAfter?: string }): Promise<void> {
    return this.appendEvent({
      event: 'tool_call_end',
      tool: input.tool,
      ok: input.ok,
      durationMs: input.durationMs,
      tabId: input.tabId,
      argsSummary: redactSummary(input.tool, input.args),
      resultSummary: redactSummary(undefined, input.error ? { error: input.error } : { ok: input.ok }),
      ...(input.url ? { state: { url: input.url } } : {}),
      refs: {
        ...(input.screenshotBefore ? { beforeScreenshot: input.screenshotBefore } : {}),
        ...(input.screenshotAfter ? { afterScreenshot: input.screenshotAfter } : {}),
      },
    });
  }

  appendContract(entry: ContractResultEntry): Promise<void> {
    return this.enqueue(async () => {
      if (this.disabled) return;
      const seq = this.nextSeq();
      const filename = `${String(seq).padStart(6, '0')}.json`;
      const artifact = redactSummary(undefined, entry as unknown as Record<string, unknown>) ?? {};
      const details = redactSummary(undefined, entry.details) ?? {};
      await fs.promises.writeFile(path.join(this.dir, 'contracts', filename), JSON.stringify(artifact, null, 2));
      await this.writeEvent({
        version: 1,
        trajectory_id: this.trajectoryId,
        seq,
        ts: Date.now(),
        sessionId: this.sessionId,
        event: 'contract',
        ok: entry.verdict === 'pass',
        resultSummary: { verdict: entry.verdict, ...details },
        refs: { contractEvidence: path.join('contracts', filename) },
      });
      this.report.contracts[entry.verdict] += 1;
      this.report.artifacts.contracts += 1;
    });
  }

  appendCheckpoint(checkpoint: Record<string, unknown>): Promise<void> {
    return this.enqueue(async () => {
      if (this.disabled) return;
      const seq = this.nextSeq();
      const filename = `${String(seq).padStart(6, '0')}.json`;
      const redacted = redactSummary(undefined, checkpoint) ?? {};
      await fs.promises.writeFile(path.join(this.dir, 'checkpoints', filename), JSON.stringify(redacted, null, 2));
      await this.writeEvent({
        version: 1,
        trajectory_id: this.trajectoryId,
        seq,
        ts: Date.now(),
        sessionId: this.sessionId,
        event: 'checkpoint',
        ok: true,
        resultSummary: {
          taskDescription: redacted.taskDescription,
          completedSteps: Array.isArray(redacted.completedSteps) ? redacted.completedSteps.length : 0,
          pendingSteps: Array.isArray(redacted.pendingSteps) ? redacted.pendingSteps.length : 0,
        },
        refs: { checkpoint: path.join('checkpoints', filename) },
      });
      this.report.artifacts.checkpoints += 1;
    });
  }

  appendEvent(event: Omit<TrajectoryEvent, 'version' | 'trajectory_id' | 'seq' | 'ts' | 'sessionId'>): Promise<void> {
    return this.enqueue(async () => {
      if (this.disabled) return;
      await this.writeEvent({ version: 1, trajectory_id: this.trajectoryId, seq: this.nextSeq(), ts: Date.now(), sessionId: this.sessionId, ...event });
    });
  }

  async finalize(): Promise<TrajectoryReport> {
    await this.writeChain;
    if (!this.disabled) {
      this.report.ended_at = new Date().toISOString();
      await fs.promises.writeFile(path.join(this.dir, 'report.json'), JSON.stringify(this.report, null, 2)).catch((err) => {
        console.error('[TrajectoryBundle] failed to write report:', err instanceof Error ? err.message : err);
      });
    }
    return { ...this.report, progress: { ...this.report.progress }, contracts: { ...this.report.contracts }, artifacts: { ...this.report.artifacts } };
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private async writeEvent(event: TrajectoryEvent): Promise<void> {
    await fs.promises.appendFile(path.join(this.dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    this.report.total_events += 1;
    if (event.event === 'tool_call_end') {
      this.report.tool_calls += 1;
      if (event.ok === false) this.report.failures += 1;
    }
    if (event.progress?.status === 'stalling') this.report.progress.stalling_events += 1;
    if (event.progress?.status === 'stuck') this.report.progress.stuck_events += 1;
  }
}
