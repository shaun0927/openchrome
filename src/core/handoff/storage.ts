import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSafe, readFileSafe } from '../../utils/atomic-file';
import { redactValue } from '../trace/redactor';
import { TaskRunStore } from '../task-run';
import {
  FinishHandoffInput,
  HandoffEvent,
  HandoffMeta,
  HandoffSnapshot,
  StartHandoffInput,
  TERMINAL_HANDOFF_STATUSES,
} from './types';

const ID_BYTES = 8;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TEXT = 2048;
const MAX_SUMMARY = 4096;
const MAX_KEYS = 100;

export interface HandoffStoreOptions {
  rootDir?: string;
  taskRunStore?: TaskRunStore;
  now?: () => number;
}

export class HandoffNotFoundError extends Error {
  code = 'handoff_not_found';
}

export class HandoffTransitionError extends Error {
  code = 'invalid_handoff_transition';
}

export class HandoffStore {
  readonly rootDir: string;
  private readonly taskRunStore: TaskRunStore;
  private readonly now: () => number;

  constructor(opts: HandoffStoreOptions = {}) {
    const openchromeHome = process.env.OPENCHROME_HOME || path.join(os.homedir(), '.openchrome');
    this.rootDir = opts.rootDir || path.join(openchromeHome, 'handoffs');
    this.taskRunStore = opts.taskRunStore || new TaskRunStore();
    this.now = opts.now || (() => Date.now());
  }

  async start(input: StartHandoffInput): Promise<HandoffMeta> {
    const ts = this.now();
    const ttl = clampTtl(input.ttl_ms);
    const meta: HandoffMeta = pruneUndefined({
      handoff_id: this.createId(String(input.reason || ''), ts),
      status: 'ACTIVE' as const,
      reason: limit(scrub(input.reason), MAX_TEXT),
      run_id: optionalString(input.run_id),
      session_id: optionalString(input.session_id),
      tab_id: optionalString(input.tab_id),
      resume_hint: optionalString(input.resume_hint),
      before: sanitizeSnapshot(input.before),
      created_at: ts,
      updated_at: ts,
      expires_at: ts + ttl,
    });
    await this.writeMeta(meta);
    await this.appendEvent(meta.handoff_id, { ts, kind: 'started', data: { run_id: meta.run_id, expires_at: meta.expires_at } });
    return meta;
  }

  async get(handoffId: string): Promise<HandoffMeta> {
    const result = await readFileSafe<HandoffMeta>(this.metaPath(handoffId));
    if (result.success === false || result.data === undefined) {
      throw new HandoffNotFoundError(`Handoff ${handoffId} not found`);
    }
    return result.data;
  }

  async status(handoffId: string): Promise<HandoffMeta> {
    const meta = await this.expireIfNeeded(await this.get(handoffId));
    await this.appendEvent(handoffId, { ts: this.now(), kind: 'status_checked', data: { status: meta.status } });
    return meta;
  }

  async finish(handoffId: string, input: FinishHandoffInput = {}): Promise<HandoffMeta> {
    const current = await this.expireIfNeeded(await this.get(handoffId));
    this.assertActive(current);
    const ts = this.now();
    const after = sanitizeSnapshot(input.after);
    const delta = summarizeDelta(current.before, after);
    const base: HandoffMeta = pruneUndefined({
      ...current,
      status: 'COMPLETED' as const,
      after,
      human_summary: optionalSummary(input.human_summary),
      delta_summary: delta,
      updated_at: ts,
      completed_at: ts,
    });
    const meta = await this.appendTaskRunEvidence(base);
    await this.writeMeta(meta);
    await this.appendEvent(handoffId, { ts, kind: 'finished', data: { delta_summary: delta, run_id: meta.run_id } });
    return meta;
  }

  async cancel(handoffId: string, reason?: string): Promise<HandoffMeta> {
    const current = await this.expireIfNeeded(await this.get(handoffId));
    this.assertActive(current);
    const ts = this.now();
    const meta: HandoffMeta = pruneUndefined({
      ...current,
      status: 'CANCELLED' as const,
      delta_summary: optionalSummary(reason) || 'Handoff cancelled before human takeover was completed.',
      updated_at: ts,
      completed_at: ts,
    });
    await this.writeMeta(meta);
    await this.appendEvent(handoffId, { ts, kind: 'cancelled', data: { reason: meta.delta_summary } });
    return meta;
  }

  async readEvents(handoffId: string): Promise<HandoffEvent[]> {
    const eventsPath = this.eventsPath(handoffId);
    if (fs.existsSync(eventsPath) === false) return [];
    const text = await fs.promises.readFile(eventsPath, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as HandoffEvent);
  }

  private async appendTaskRunEvidence(meta: HandoffMeta): Promise<HandoffMeta> {
    if (meta.run_id === undefined) return meta;
    try {
      await this.taskRunStore.update(meta.run_id, {
        last_evidence: [{
          kind: 'handoff',
          ref: meta.handoff_id,
          summary: meta.delta_summary || 'Human handoff completed.',
        }],
      });
      return { ...meta, task_run_evidence_appended: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...meta, task_run_evidence_appended: false, task_run_evidence_error: limit(scrub(message), MAX_TEXT) };
    }
  }

  private async expireIfNeeded(meta: HandoffMeta): Promise<HandoffMeta> {
    if (TERMINAL_HANDOFF_STATUSES.has(meta.status)) return meta;
    const ts = this.now();
    if (ts <= meta.expires_at) return meta;
    const timedOut: HandoffMeta = pruneUndefined({
      ...meta,
      status: 'TIMED_OUT' as const,
      delta_summary: 'Handoff timed out before human takeover was completed.',
      updated_at: ts,
      completed_at: ts,
    });
    await this.writeMeta(timedOut);
    await this.appendEvent(meta.handoff_id, { ts, kind: 'timed_out', data: { expires_at: meta.expires_at } });
    return timedOut;
  }

  private assertActive(meta: HandoffMeta): void {
    if (meta.status !== 'ACTIVE') {
      throw new HandoffTransitionError(`Handoff ${meta.handoff_id} is ${meta.status} and cannot be modified`);
    }
  }

  private createId(seed: string, ts: number): string {
    return crypto.createHash('sha256')
      .update(seed)
      .update('\0')
      .update(String(ts))
      .update('\0')
      .update(crypto.randomBytes(ID_BYTES))
      .digest('hex')
      .slice(0, 16);
  }

  private async writeMeta(meta: HandoffMeta): Promise<void> {
    await writeFileAtomicSafe(this.metaPath(meta.handoff_id), meta);
  }

  private async appendEvent(handoffId: string, event: HandoffEvent): Promise<void> {
    await fs.promises.mkdir(this.handoffDir(handoffId), { recursive: true });
    await fs.promises.appendFile(this.eventsPath(handoffId), `${JSON.stringify(redactValue(event))}\n`, 'utf8');
  }

  private handoffDir(handoffId: string): string {
    assertSafeId(handoffId);
    return path.join(this.rootDir, handoffId);
  }

  private metaPath(handoffId: string): string {
    return path.join(this.handoffDir(handoffId), 'meta.json');
  }

  private eventsPath(handoffId: string): string {
    return path.join(this.handoffDir(handoffId), 'events.jsonl');
  }
}

function summarizeDelta(before?: HandoffSnapshot, after?: HandoffSnapshot): string {
  const parts: string[] = [];
  pushDelta(parts, 'url', before?.url, after?.url);
  pushDelta(parts, 'title', before?.title, after?.title);
  pushDelta(parts, 'origin', before?.origin, after?.origin);
  pushDelta(parts, 'cookie_count', before?.cookie_count, after?.cookie_count);
  pushArrayDelta(parts, 'local_storage_keys', before?.local_storage_keys, after?.local_storage_keys);
  pushArrayDelta(parts, 'session_storage_keys', before?.session_storage_keys, after?.session_storage_keys);
  pushDelta(parts, 'dom_fingerprint', before?.dom_fingerprint, after?.dom_fingerprint);
  if (after?.screenshot_ref !== undefined) parts.push(`screenshot_ref=${after.screenshot_ref}`);
  if (parts.length === 0) return 'No caller-supplied snapshot delta.';
  return limit(parts.join('; '), MAX_SUMMARY);
}

function pushDelta(parts: string[], label: string, before: unknown, after: unknown): void {
  if (after === undefined) return;
  if (before === after) return;
  parts.push(`${label}: ${String(before ?? '(unset)')} -> ${String(after)}`);
}

function pushArrayDelta(parts: string[], label: string, before?: string[], after?: string[]): void {
  if (after === undefined) return;
  const beforeText = (before || []).join(',');
  const afterText = after.join(',');
  if (beforeText === afterText) return;
  parts.push(`${label}: ${beforeText || '(empty)'} -> ${afterText || '(empty)'}`);
}

function sanitizeSnapshot(input: unknown): HandoffSnapshot | undefined {
  if (input === undefined || input === null || typeof input !== 'object') return undefined;
  const source = input as HandoffSnapshot;
  return pruneUndefined({
    url: optionalString(source.url),
    title: optionalString(source.title),
    origin: optionalString(source.origin),
    cookie_count: finiteNumber(source.cookie_count),
    local_storage_keys: sanitizeKeys(source.local_storage_keys),
    session_storage_keys: sanitizeKeys(source.session_storage_keys),
    dom_fingerprint: optionalString(source.dom_fingerprint),
    screenshot_ref: optionalString(source.screenshot_ref),
  });
}

function sanitizeKeys(values: unknown): string[] | undefined {
  if (Array.isArray(values) === false) return undefined;
  return values.slice(0, MAX_KEYS).map(value => limit(scrub(String(value)), 256)).filter(Boolean);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? limit(scrub(value.trim()), MAX_TEXT) : undefined;
}

function optionalSummary(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? limit(scrub(value.trim()), MAX_SUMMARY) : undefined;
}

function scrub(value: unknown): string {
  return String(redactValue(String(value || '')));
}

function limit(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function clampTtl(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TTL_MS;
  return Math.max(1000, Math.min(MAX_TTL_MS, n));
}

function assertSafeId(id: string): void {
  if (/^[a-f0-9]{16}$/i.test(id) === false) {
    throw new Error(`Invalid Handoff id: ${id}`);
  }
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}
