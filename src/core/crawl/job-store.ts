/**
 * job-store — JSONL-backed persistence for resumable crawl jobs (issue #886).
 *
 * Layout: each job lives in a single append-only JSONL file at
 *
 *   <jobsRootDir>/<jobId>.jsonl
 *
 * Line 0 is a header record (`{ kind: 'header', config, createdAt }`).
 * Subsequent lines are event records:
 *   - { kind: 'enqueue', urls: [{ url, depth }], t }
 *   - { kind: 'fetched', url, depth, page, t }
 *   - { kind: 'error', url, message, t }
 *   - { kind: 'status', status, t }
 *
 * `loadJob` replays the file to reconstruct (config, queue, visited, results,
 * status, errors). Atomic concurrent appends are serialised via
 * `proper-lockfile` (no in-process state).
 *
 * Pure persistence — no network I/O, no LLM, no background work. Conforms to
 * portability-harness P1/P3/P5.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquireLock } from '../../utils/atomic-file';
import { normalizeUrl } from '../../utils/crawl-utils';
import { redactValue } from '../trace/redactor';

/** A page recorded in the job log (mirrors the legacy `crawl` tool shape). */
export interface CrawledPage {
  url: string;
  title: string;
  content: string;
  depth: number;
  links_found: number;
  error?: string;
  /**
   * Present and `true` when `content` was capped at `OC_CRAWL_PAGE_BYTES`
   * (default 256 KiB). Absent when the page fit under the cap. Bounds the
   * on-disk growth of a single job to a predictable size.
   */
  truncated?: boolean;
}

/** Public crawl configuration (mirrors legacy `crawl` tool args). */
export interface JobConfig {
  url: string;
  max_depth: number;
  max_pages: number;
  scope: string;
  include_patterns?: string[];
  exclude_patterns?: string[];
  output_format: string;
  respect_robots: boolean;
  delay_ms: number;
  concurrency: number;
}

export type JobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'expired';

export interface QueueEntry {
  url: string;
  depth: number;
}

export interface JobError {
  url: string;
  message: string;
}

export interface JobState {
  jobId: string;
  config: JobConfig;
  createdAt: number;
  status: JobStatus;
  startedAt?: number;
  finishedAt?: number;
  queue: QueueEntry[];
  visited: Set<string>;
  pages: CrawledPage[];
  errors: JobError[];
}

interface HeaderRecord {
  kind: 'header';
  config: JobConfig;
  createdAt: number;
}

export type JobEvent =
  | { kind: 'enqueue'; urls: QueueEntry[]; t: number }
  | { kind: 'fetched'; url: string; depth: number; page: CrawledPage; t: number }
  | { kind: 'error'; url: string; message: string; t: number }
  | { kind: 'status'; status: JobStatus; t: number };

/** Resolve `~/.openchrome/jobs` lazily so test overrides via `OC_JOBS_ROOT` apply per-call. */
export function jobsRootDir(): string {
  const override = process.env.OC_JOBS_ROOT;
  if (override && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), '.openchrome', 'jobs');
}

/**
 * Crockford-base32 ULID: 26 chars, alphabet `0-9A-HJKMNP-TV-Z` (no I/L/O/U).
 * Mirrors the format produced by `generateUlid()` below. We enforce the exact
 * shape on every caller-supplied `jobId` so a malicious or buggy caller cannot
 * cause `path.join(jobsRootDir(), ${jobId}.jsonl)` to escape the jobs root
 * (path-traversal via `..`, absolute paths, NUL injection, …).
 */
const VALID_JOB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Runtime-only map for sensitive original start URLs. The persisted header stores
// a redacted URL so secrets never hit disk; same-process advances can still
// fetch signed/basic-auth start URLs via this map. After a restart, only the
// redacted URL remains available, which is the safe recovery fallback.
const ORIGINAL_START_URLS = new Map<string, string>();
const ORIGINAL_QUEUED_URLS = new Map<string, Map<string, string>>();

/**
 * Reject any jobId that is not a well-formed ULID. Throws a clear error
 * otherwise. Defence-in-depth: tool handlers also validate at their entry
 * points, but the store enforces the invariant at every fs call so internal
 * misuse (e.g. a buggy refactor) cannot bypass it.
 */
export function assertValidJobId(jobId: string): void {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new Error('job-store: jobId must be a non-empty string');
  }
  if (!VALID_JOB_ID_RE.test(jobId)) {
    throw new Error(
      `job-store: jobId "${jobId}" is not a valid ULID (expected 26-char Crockford base32)`,
    );
  }
}

export function jobFilePath(jobId: string): string {
  assertValidJobId(jobId);
  return path.join(jobsRootDir(), `${jobId}.jsonl`);
}

function lockFilePath(jobId: string): string {
  assertValidJobId(jobId);
  return path.join(jobsRootDir(), `${jobId}.jsonl.lock`);
}

/**
 * Generate a Crockford-base32 ULID (26 chars, monotonic-time prefix).
 * Inline so we do not pull in a new dependency (P5).
 */
function generateUlid(): string {
  const encoding = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ts = Date.now();
  // 48-bit timestamp -> 10 base32 chars (5 bits/char).
  let tsPart = '';
  let t = ts;
  for (let i = 0; i < 10; i++) {
    tsPart = encoding[t % 32] + tsPart;
    t = Math.floor(t / 32);
  }
  // 80-bit random -> 16 base32 chars.
  const bytes = crypto.randomBytes(10);
  let randPart = '';
  // Treat 80 bits as a stream of 5-bit chunks across the 10 bytes.
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randPart += encoding[(buf >> bits) & 0x1f];
    }
  }
  return tsPart + randPart;
}

function ensureRoot(): void {
  const dir = jobsRootDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Best-effort URL scrub: runs the credential-pattern walker over a string
 * value so that tokens like `?token=...`, basic-auth `user:pass@`, JWTs in
 * the path, etc. become `[REDACTED]` before they hit disk. The redactor
 * returns the same value type, so a `string` in → `string` out.
 */
function scrubUrlString(value: string): string {
  const out = redactValue(value);
  return typeof out === 'string' ? out : value;
}

/**
 * Defence-in-depth: even though the runner now scrubs `url`/`title`/`content`
 * up front (see `runner.ts`), every event is run through the credential
 * walker at the persistence boundary. This catches both:
 *   - direct callers (tests, future tools) that forgot to redact, and
 *   - secrets that slip into fields the runner doesn't explicitly handle
 *     (e.g. an error `message` that quotes a Bearer token).
 *
 * The walker preserves shape (kind, t, depth, links_found, page.depth, …) —
 * only string leaves get pattern-scrubbed.
 */
function scrubEvent(event: JobEvent): JobEvent {
  return redactValue(event) as JobEvent;
}

/**
 * Create a new job file. Atomically writes the header record so a partial
 * write never produces a half-initialised job. Returns the freshly minted ULID.
 */
export async function createJob(config: JobConfig): Promise<string> {
  ensureRoot();
  const jobId = generateUlid();
  const file = jobFilePath(jobId);
  // Redact credentials from the start URL before persisting (e.g. a
  // basic-auth `https://user:pass@host/` or a `?token=…` in a callback URL).
  // The runner sees the original `config.url` only in memory; on disk we
  // keep the scrubbed copy.
  const safeConfig: JobConfig = { ...config, url: scrubUrlString(config.url) };
  ORIGINAL_START_URLS.set(jobId, config.url);
  const header: HeaderRecord = { kind: 'header', config: safeConfig, createdAt: Date.now() };
  const line = JSON.stringify(header) + '\n';
  // Use atomic write for the header — the file is brand new so this is just
  // "create with content" plus rename, which prevents readers from seeing a
  // half-written first line. Subsequent appends go through `appendEvent`.
  const writeFileAtomic = require('write-file-atomic') as typeof import('write-file-atomic');
  await writeFileAtomic(file, line, { encoding: 'utf8' });
  return jobId;
}

/**
 * Append a single event line WITHOUT acquiring the job lock. Intended for
 * callers that already hold the lock via `withJobLock(...)`. Concurrent
 * callers that bypass `withJobLock` risk interleaved writes; use
 * `appendEvent` for those.
 */
export function getOriginalStartUrl(jobId: string): string | undefined {
  assertValidJobId(jobId);
  return ORIGINAL_START_URLS.get(jobId);
}

export function rememberOriginalQueuedUrls(jobId: string, entries: QueueEntry[]): void {
  assertValidJobId(jobId);
  if (entries.length === 0) return;
  let bySafeUrl = ORIGINAL_QUEUED_URLS.get(jobId);
  if (!bySafeUrl) {
    bySafeUrl = new Map<string, string>();
    ORIGINAL_QUEUED_URLS.set(jobId, bySafeUrl);
  }
  for (const entry of entries) {
    const safeUrl = scrubUrlString(entry.url);
    bySafeUrl.set(safeUrl, entry.url);
    try {
      bySafeUrl.set(normalizeUrl(safeUrl), entry.url);
    } catch {
      /* keep the raw scrubbed key only */
    }
  }
}

export function getOriginalQueuedUrl(jobId: string, safeUrl: string): string | undefined {
  assertValidJobId(jobId);
  const bySafeUrl = ORIGINAL_QUEUED_URLS.get(jobId);
  if (!bySafeUrl) return undefined;
  return bySafeUrl.get(safeUrl);
}

function forgetOriginalQueuedUrl(jobId: string, safeUrl: string): void {
  const bySafeUrl = ORIGINAL_QUEUED_URLS.get(jobId);
  if (!bySafeUrl) return;
  bySafeUrl.delete(safeUrl);
  bySafeUrl.delete(normalizeUrl(safeUrl));
  if (bySafeUrl.size === 0) {
    ORIGINAL_QUEUED_URLS.delete(jobId);
  }
}

export function clearJobRuntimeSecrets(jobId: string): void {
  assertValidJobId(jobId);
  ORIGINAL_START_URLS.delete(jobId);
  ORIGINAL_QUEUED_URLS.delete(jobId);
}

export function appendEventUnlocked(jobId: string, event: JobEvent): void {
  assertValidJobId(jobId);
  ensureRoot();
  const file = jobFilePath(jobId);
  if (!fs.existsSync(file)) {
    throw new Error(`appendEvent: job ${jobId} does not exist`);
  }
  const safe = scrubEvent(event);
  fs.appendFileSync(file, JSON.stringify(safe) + '\n', 'utf8');
}

/**
 * Append a single event line. Serialised via `proper-lockfile` so concurrent
 * calls on the same jobId do not interleave bytes. Do NOT call this from
 * inside a `withJobLock` callback — use `appendEventUnlocked` to avoid a
 * self-deadlock against the per-job lock.
 */
export async function appendEvent(jobId: string, event: JobEvent): Promise<void> {
  assertValidJobId(jobId);
  ensureRoot();
  const file = jobFilePath(jobId);
  if (!fs.existsSync(file)) {
    throw new Error(`appendEvent: job ${jobId} does not exist`);
  }
  const release = await acquireLock(lockFilePath(jobId));
  try {
    const safe = scrubEvent(event);
    fs.appendFileSync(file, JSON.stringify(safe) + '\n', 'utf8');
  } finally {
    await release();
  }
}

/** Convenience: append a status event (acquires the lock). */
export async function setStatus(jobId: string, status: JobStatus): Promise<void> {
  assertValidJobId(jobId);
  await appendEvent(jobId, { kind: 'status', status, t: Date.now() });
}

/** Lock-free status append — for callers that already hold `withJobLock`. */
export function setStatusUnlocked(jobId: string, status: JobStatus): void {
  assertValidJobId(jobId);
  appendEventUnlocked(jobId, { kind: 'status', status, t: Date.now() });
}

/**
 * Replay the JSONL file to rebuild the in-memory state.
 *
 * Status precedence: terminal statuses ('completed' | 'cancelled') are sticky
 * — once observed, later 'status' events do not downgrade them. This protects
 * the cancel-then-status flow from a stale runner.
 */
export function loadJob(jobId: string): JobState {
  assertValidJobId(jobId);
  const file = jobFilePath(jobId);
  if (!fs.existsSync(file)) {
    throw new Error(`loadJob: job ${jobId} does not exist`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error(`loadJob: job ${jobId} is empty`);
  }
  let header: HeaderRecord;
  try {
    header = JSON.parse(lines[0]) as HeaderRecord;
  } catch (err) {
    throw new Error(
      `loadJob: failed to parse header for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (header.kind !== 'header') {
    throw new Error(`loadJob: first line of ${jobId} is not a header`);
  }

  const state: JobState = {
    jobId,
    config: header.config,
    createdAt: header.createdAt,
    status: 'pending',
    queue: [],
    visited: new Set<string>(),
    pages: [],
    errors: [],
  };

  for (let i = 1; i < lines.length; i++) {
    let evt: JobEvent;
    try {
      evt = JSON.parse(lines[i]) as JobEvent;
    } catch (err) {
      // Skip malformed event line — best-effort replay. Surface it on
      // stderr (NEVER stdout — that channel carries MCP JSON-RPC) so an
      // operator can find truncated lines, partial writes after a crash,
      // or a corrupt log file.
      console.error(
        `[crawl/job-store] parse failure jobId=${jobId} lineIndex=${i}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    applyEvent(state, evt);
  }

  return state;
}

function applyEvent(state: JobState, evt: JobEvent): void {
  switch (evt.kind) {
    case 'enqueue':
      for (const entry of evt.urls) {
        if (!state.visited.has(entry.url)) {
          state.queue.push(entry);
        }
      }
      return;
    case 'fetched': {
      state.visited.add(evt.url);
      forgetOriginalQueuedUrl(state.jobId, evt.url);
      // Drop all queued duplicates for the URL. Duplicate links may be
      // discovered from multiple parents; leaving stale duplicate queue entries
      // can keep a job running even after every unique URL has been visited.
      state.queue = state.queue.filter((q) => q.url !== evt.url);
      state.pages.push(evt.page);
      if (state.startedAt === undefined) state.startedAt = evt.t;
      return;
    }
    case 'error':
      state.errors.push({ url: evt.url, message: evt.message });
      return;
    case 'status': {
      // Sticky terminal status: cancelled / completed are never downgraded.
      if (state.status === 'cancelled' || state.status === 'completed') {
        return;
      }
      state.status = evt.status;
      if (evt.status === 'running' && state.startedAt === undefined) {
        state.startedAt = evt.t;
      }
      if (
        evt.status === 'completed' ||
        evt.status === 'cancelled' ||
        evt.status === 'expired'
      ) {
        state.finishedAt = evt.t;
        clearJobRuntimeSecrets(state.jobId);
      }
      return;
    }
  }
}

/** Retention TTL — older jobs are *reported* as expired, never deleted. */
export function defaultRetentionMs(): number {
  const raw = process.env.OC_JOB_RETENTION_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 24 * 60 * 60 * 1000;
}

export function isExpired(state: { createdAt: number }, now: number): boolean {
  return now - state.createdAt > defaultRetentionMs();
}

/** Acquire the per-job lock and run `fn`. Exposed for callers that need atomicity across read + write (e.g. the runner). */
export async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  assertValidJobId(jobId);
  ensureRoot();
  const release = await acquireLock(lockFilePath(jobId));
  try {
    return await fn();
  } finally {
    await release();
  }
}
