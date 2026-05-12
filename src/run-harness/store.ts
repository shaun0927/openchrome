import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TERMINAL_RUN_STATUSES, type RunEvent, type RunRecord, type RunStatus } from './types.js';

export interface RunStoreOptions {
  rootDir?: string;
  now?: () => number;
  idFactory?: () => string;
}

export interface StartRunInput {
  run_id?: string;
  session_id?: string;
  tab_id?: string;
  metadata?: Record<string, unknown>;
}

export interface FinishRunInput {
  status: RunStatus;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolEventInput {
  run_id: string;
  session_id?: string;
  tab_id?: string;
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  duration_ms?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

export function defaultRunRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'runs');
}

export function hashRunArgs(args: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(redact(args))).digest('hex');
}

export class RunStore {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(opts: RunStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultRunRootDir();
    this.now = opts.now ?? Date.now;
    this.idFactory = opts.idFactory ?? (() => crypto.randomUUID());
  }

  startRun(input: StartRunInput = {}): RunRecord {
    const run_id = sanitizeRunId(input.run_id ?? `run-${this.idFactory()}`);
    const existing = this.readRun(run_id);
    if (existing && !TERMINAL_RUN_STATUSES.has(existing.status)) {
      return existing;
    }

    const ts = this.now();
    const record: RunRecord = {
      run_id,
      status: 'running',
      created_at: ts,
      updated_at: ts,
      session_id: input.session_id,
      tab_id: input.tab_id,
      metadata: input.metadata,
      events: [],
    };
    record.events.push(this.event(run_id, 'run_started', {
      session_id: input.session_id,
      tab_id: input.tab_id,
      metadata: input.metadata,
    }));
    this.writeRun(record);
    return record;
  }

  getRun(run_id: string): RunRecord | null {
    return this.readRun(sanitizeRunId(run_id));
  }

  appendToolStarted(input: ToolEventInput): RunEvent | null {
    return this.appendToolEvent('tool_call_started', input);
  }

  appendToolFinished(input: ToolEventInput): RunEvent | null {
    return this.appendToolEvent('tool_call_finished', input);
  }

  finishRun(run_id: string, input: FinishRunInput): RunRecord | null {
    const safeRunId = sanitizeRunId(run_id);
    const record = this.readRun(safeRunId);
    if (!record) return null;
    if (TERMINAL_RUN_STATUSES.has(record.status)) return record;
    if (input.status === 'created' || input.status === 'running') {
      throw new Error(`finishRun requires a terminal/status-like finish value, got ${input.status}`);
    }
    record.status = input.status;
    record.updated_at = this.now();
    record.events.push(this.event(safeRunId, 'run_finished', {
      message: input.message,
      metadata: input.metadata,
    }));
    this.writeRun(record);
    return record;
  }

  private appendToolEvent(kind: 'tool_call_started' | 'tool_call_finished', input: ToolEventInput): RunEvent | null {
    const safeRunId = sanitizeRunId(input.run_id);
    const record = this.readRun(safeRunId);
    if (!record || TERMINAL_RUN_STATUSES.has(record.status)) return null;
    if (record.status === 'created') record.status = 'running';
    const event = this.event(safeRunId, kind, {
      session_id: input.session_id,
      tab_id: input.tab_id,
      tool: input.tool,
      ok: input.ok,
      duration_ms: input.duration_ms,
      args_hash: input.args ? hashRunArgs(input.args) : undefined,
      message: input.message,
      metadata: input.metadata,
    });
    record.events.push(event);
    record.updated_at = event.ts;
    this.writeRun(record);
    return event;
  }

  private event(run_id: string, kind: RunEvent['kind'], partial: Partial<RunEvent>): RunEvent {
    return {
      id: `evt-${this.idFactory()}`,
      run_id,
      ts: this.now(),
      kind,
      ...stripUndefined(partial),
    } as RunEvent;
  }

  private filePath(run_id: string): string {
    return path.join(this.rootDir, `${sanitizeRunId(run_id)}.json`);
  }

  private readRun(run_id: string): RunRecord | null {
    try {
      const raw = fs.readFileSync(this.filePath(run_id), 'utf8');
      const parsed = JSON.parse(raw) as RunRecord;
      if (!parsed || parsed.run_id !== run_id || !Array.isArray(parsed.events)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeRun(record: RunRecord): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const file = this.filePath(record.run_id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  }
}

export function extractRunId(args: Record<string, unknown>): string | undefined {
  const raw = args.run_id ?? args.runId;
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

export function sanitizeRunId(runId: string): string {
  if (!runId || runId.length > 160 || /[\\/\0]/.test(runId) || runId === '.' || runId === '..' || runId.startsWith('.')) {
    throw new Error('run_id must be a non-empty safe basename under 160 characters');
  }
  return runId;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /password|token|secret|credential|api[_-]?key/i.test(key) ? '[REDACTED]' : redact(inner);
    }
    return out;
  }
  return value;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

let singleton: RunStore | null = null;
export function getRunStore(): RunStore {
  if (!singleton) singleton = new RunStore();
  return singleton;
}

export function setRunStoreForTests(store: RunStore | null): void {
  singleton = store;
}
