/**
 * JSON-per-domain skill memory store (#712 epic, Phase 3 cleanup —
 * replaces the storage half of closed PR #762).
 *
 * On-disk layout under `rootDir`:
 *
 *   <rootDir>/
 *     <encodedDomain>/
 *       skills.json                       -- SkillMemoryFile (atomic writes)
 *       .lock                             -- proper-lockfile coordination
 *       snapshots/
 *         <snapshotId>.json.gz            -- gzipped frozen snapshot
 *
 * Per portability-harness contract P5 (Native dependency discipline —
 * argon2 only) this storage layer uses plain filesystem primitives plus
 * the already-vendored `proper-lockfile` and Node's built-in `zlib`.
 * No SQLite, no native binary deps.
 *
 * Write coordination is per-domain: two `SkillMemoryStore` instances
 * targeting *different* domains can run fully in parallel because each
 * domain has its own lock file. Within a domain, writes serialize via
 * `acquireLock`. `record()` is idempotent on `(domain, name)` so retried
 * extractor flushes do not produce duplicate skills.
 *
 * The recall *ranking* logic (relevance score, recency weighting,
 * LLM-facing payload sizing) is pilot-tier work and is intentionally
 * deferred to a separate issue. `list()` here returns an unranked
 * listing sorted by `last_used_at desc` for deterministic order — the
 * pilot recall layer is expected to rerank.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { acquireLock, writeFileAtomicSafe } from '../../utils/atomic-file';

import {
  SKILL_MEMORY_SCHEMA_VERSION,
  type FrozenSnapshot,
  type SkillMemoryFile,
  type SkillRecord,
} from './types';

export interface SkillMemoryStoreOptions {
  /** Root directory for per-domain skills.json + snapshot files. */
  rootDir?: string;
  /** Domain this store instance is bound to. Required. */
  domain: string;
}

export interface RecordResult {
  /** The skill_id assigned (existing one on idempotent re-record). */
  skill_id: string;
  /** Wall-clock ms epoch when the record completed. */
  stored_at: number;
}

export interface ListFilter {
  /** Restrict to a single contract_id. */
  contract_id?: string;
  /** Cap the number of records returned (default: unlimited). */
  limit?: number;
}

export interface WriteFrozenSnapshotResult {
  /** Absolute path to the gzipped snapshot on disk. */
  snapshot_path: string;
}

/** Default rootDir resolves to `${HOME}/.openchrome/skill-memory`. */
export function defaultSkillMemoryRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'skill-memory');
}

/**
 * Windows reserved device names. Even on POSIX we prefix these so a
 * domain recorded on Linux is round-trippable on Windows without
 * collision. `CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9` (with or
 * without an extension) are unusable as directory basenames on Windows.
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * Encode a domain string into a filesystem-safe directory basename.
 *
 * Domains arrive as eTLD+1 hosts (e.g. `amazon.com`) but the surface is
 * declared as `string` so we cannot assume well-formed input. The
 * encoding here is lossless enough to round-trip via `decodeURIComponent`
 * but the store itself never decodes — the domain is also stored
 * verbatim inside each `SkillRecord`. Encoding only governs the *path*.
 */
function encodeDomain(domain: string): string {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new Error('SkillMemoryStore: domain must be a non-empty string');
  }
  if (domain.length > 253) {
    // RFC 1035 maximum DNS name length. Anything longer is almost
    // certainly an attacker probe rather than a real host.
    throw new Error(`SkillMemoryStore: domain too long (${domain.length} chars; max 253)`);
  }
  // Reject NUL and control characters outright — they are never valid
  // host components and only ever appear in path-traversal probes.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(domain)) {
    throw new Error('SkillMemoryStore: domain contains a control character');
  }
  // Percent-encode anything that is not an unreserved DNS label
  // character. This handles `.` (preserved), `/`, `\`, `:`, and
  // anything else a creative caller might pass.
  const encoded = domain.replace(/[^a-zA-Z0-9._-]/g, (ch) => {
    return '%' + ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase();
  });
  return WINDOWS_RESERVED.test(encoded) ? `_${encoded}` : encoded;
}

/**
 * Reject snapshot IDs that would let a caller escape the snapshots
 * directory via `path.join`. Same conservative basename policy as the
 * trace storage uses for session IDs.
 */
function assertSafeSnapshotId(snapshotId: string): void {
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    throw new Error('SkillMemoryStore: snapshot_id must be a non-empty string');
  }
  if (snapshotId.length > 200) {
    throw new Error(
      `SkillMemoryStore: snapshot_id too long (${snapshotId.length} chars; max 200)`,
    );
  }
  if (snapshotId === '.' || snapshotId === '..' || snapshotId.startsWith('.')) {
    throw new Error(`SkillMemoryStore: snapshot_id "${snapshotId}" begins with a dot (reserved)`);
  }
  if (/[\\/\0]/.test(snapshotId)) {
    throw new Error(
      `SkillMemoryStore: snapshot_id "${snapshotId}" contains a path separator or NUL`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(snapshotId)) {
    throw new Error(
      `SkillMemoryStore: snapshot_id "${snapshotId}" contains a control character`,
    );
  }
}

/**
 * Deterministic skill_id derived from (domain, name). Stable across
 * process restarts so `record()` is idempotent without needing a
 * separate uniqueness index.
 */
function computeSkillId(domain: string, name: string): string {
  return crypto
    .createHash('sha256')
    .update(`${domain}\x00${name}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * JSON-per-domain skill memory store. One instance is bound to a single
 * domain; cross-domain workloads should construct one store per domain
 * so locks do not contend. The instance is safe to share across async
 * call sites — per-domain serialisation runs through `proper-lockfile`.
 */
export class SkillMemoryStore {
  private readonly rootDir: string;
  private readonly domain: string;
  private readonly encodedDomain: string;
  /** Lazy-init flag — we do not touch the filesystem in the constructor. */
  private rootEnsured = false;

  constructor(opts: SkillMemoryStoreOptions) {
    if (!opts || typeof opts.domain !== 'string' || opts.domain.length === 0) {
      throw new Error('SkillMemoryStore: opts.domain is required');
    }
    this.rootDir = opts.rootDir ?? defaultSkillMemoryRootDir();
    this.domain = opts.domain;
    this.encodedDomain = encodeDomain(opts.domain);
  }

  /** Ensure the per-domain directory exists exactly once per instance. */
  private ensureDomainDir(): string {
    const dir = this.domainDir();
    if (!this.rootEnsured) {
      fs.mkdirSync(dir, { recursive: true });
      this.rootEnsured = true;
    }
    return dir;
  }

  /** Directory holding `skills.json` + `snapshots/` for this domain. */
  private domainDir(): string {
    return path.join(this.rootDir, this.encodedDomain);
  }

  /** Path to the per-domain skills.json. */
  private skillsFile(): string {
    return path.join(this.domainDir(), 'skills.json');
  }

  /** Path to the per-domain lock file used by `proper-lockfile`. */
  private lockFile(): string {
    return path.join(this.domainDir(), '.lock');
  }

  /** Path to the per-domain snapshots directory. */
  private snapshotsDir(): string {
    return path.join(this.domainDir(), 'snapshots');
  }

  /**
   * Read skills.json synchronously. Returns an empty file shape when
   * the file is missing, malformed, or stamped with an unknown schema
   * version. The schema-mismatch case is logged via `console.error`
   * (per project rule — `console.log` collides with MCP JSON-RPC) so
   * operators can spot the rollback path during upgrades.
   */
  private readFileSync(): SkillMemoryFile {
    const file = this.skillsFile();
    if (!fs.existsSync(file)) {
      return { schema_version: SKILL_MEMORY_SCHEMA_VERSION, skills: {} };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return { schema_version: SKILL_MEMORY_SCHEMA_VERSION, skills: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { schema_version: SKILL_MEMORY_SCHEMA_VERSION, skills: {} };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { schema_version: SKILL_MEMORY_SCHEMA_VERSION, skills: {} };
    }
    const obj = parsed as Partial<SkillMemoryFile>;
    if (obj.schema_version !== SKILL_MEMORY_SCHEMA_VERSION) {
      console.error(
        `SkillMemoryStore: skipping ${file} — unknown schema_version=${String(obj.schema_version)}`,
      );
      return { schema_version: SKILL_MEMORY_SCHEMA_VERSION, skills: {} };
    }
    if (!obj.skills || typeof obj.skills !== 'object') {
      return { schema_version: SKILL_MEMORY_SCHEMA_VERSION, skills: {} };
    }
    return { schema_version: SKILL_MEMORY_SCHEMA_VERSION, skills: obj.skills as Record<string, SkillRecord> };
  }

  /** Persist skills.json atomically (temp + rename via write-file-atomic). */
  private async writeFile(file: SkillMemoryFile): Promise<void> {
    await writeFileAtomicSafe(this.skillsFile(), JSON.stringify(file, null, 2));
  }

  /**
   * Insert / update a skill record. Idempotent on `(domain, name)`:
   * calling `record()` twice with the same name updates the existing
   * record's mutable fields (`steps`, `contract_id`, `frozen_snapshot_path`,
   * counter resets) but keeps the same `skill_id`. The persisted
   * `success_count` and `last_used_at` are preserved across re-records
   * — only `markUsed` mutates those.
   *
   * Returns the assigned `skill_id` and the wall-clock ms `stored_at`.
   */
  async record(skill: Omit<SkillRecord, 'skillId'> & { skillId?: string }): Promise<RecordResult> {
    if (skill.domain !== this.domain) {
      throw new Error(
        `SkillMemoryStore: domain mismatch — store bound to "${this.domain}", record carries "${skill.domain}"`,
      );
    }
    if (typeof skill.name !== 'string' || skill.name.length === 0) {
      throw new Error('SkillMemoryStore: skill.name must be a non-empty string');
    }
    this.ensureDomainDir();
    const release = await acquireLock(this.lockFile());
    try {
      const file = this.readFileSync();
      // Locate an existing record by name (idempotency key is
      // (domain, name) per the contract). The map key is skill_id, so
      // we scan once — the count of skills per domain is small enough
      // (low hundreds) that O(n) scan is well below any lock-hold budget.
      let existingId: string | null = null;
      for (const [id, rec] of Object.entries(file.skills)) {
        if (rec.name === skill.name) {
          existingId = id;
          break;
        }
      }
      const skillId = existingId ?? skill.skillId ?? computeSkillId(skill.domain, skill.name);
      const existing = existingId ? file.skills[existingId] : undefined;
      const next: SkillRecord = {
        skillId,
        domain: skill.domain,
        name: skill.name,
        steps: skill.steps,
        contractId: skill.contractId,
        // Preserve usage stats across idempotent re-records — only
        // markUsed should bump these. New records start at the
        // caller-supplied value (typically 0).
        successCount: existing ? existing.successCount : skill.successCount,
        lastUsedAt: existing ? existing.lastUsedAt : skill.lastUsedAt,
        // `frozen_snapshot_path` is also caller-managed via
        // writeFrozenSnapshot; re-record without an explicit override
        // keeps the previously-recorded value.
        frozenSnapshotPath: skill.frozenSnapshotPath ?? existing?.frozenSnapshotPath ?? null,
      };
      // Preserve replay-outcome fields across idempotent re-record. The
      // recorder owns `steps`/`contractId`; the replay path owns the
      // replay-outcome fields. Mixing them would let a re-record erase
      // the demote-on-fail signal that drives `oc_skill_recall` ranking (#856).
      if (existing?.lastReplayPassedAt !== undefined) {
        next.lastReplayPassedAt = existing.lastReplayPassedAt;
      }
      if (existing?.lastReplayFailedAt !== undefined) {
        next.lastReplayFailedAt = existing.lastReplayFailedAt;
      }
      if (existing?.lastReplayError !== undefined) {
        next.lastReplayError = existing.lastReplayError;
      }
      file.skills[skillId] = next;
      await this.writeFile(file);
      return { skill_id: skillId, stored_at: Date.now() };
    } finally {
      await release();
    }
  }

  /** Look up a single skill by id. Returns null on miss. */
  get(skillId: string): SkillRecord | null {
    if (typeof skillId !== 'string' || skillId.length === 0) return null;
    if (!fs.existsSync(this.skillsFile())) return null;
    const file = this.readFileSync();
    return file.skills[skillId] ?? null;
  }

  /**
   * Unranked listing sorted by `last_used_at` descending (ties broken
   * by `skill_id` ascending for byte-stable output). The pilot recall
   * layer is responsible for any LLM-facing reranking.
   */
  list(filter: ListFilter = {}): SkillRecord[] {
    if (!fs.existsSync(this.skillsFile())) return [];
    const file = this.readFileSync();
    let rows = Object.values(file.skills);
    if (filter.contract_id !== undefined) {
      rows = rows.filter((r) => r.contractId === filter.contract_id);
    }
    rows.sort((a, b) => {
      if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return a.skillId.localeCompare(b.skillId);
    });
    if (filter.limit !== undefined && filter.limit >= 0) {
      rows = rows.slice(0, filter.limit);
    }
    return rows;
  }

  /**
   * Persist the outcome of a deterministic skill replay (#856). Exactly
   * one of `passedAt` / `failedAt` must be supplied. On a passing replay
   * the prior `lastReplayError` is cleared so callers can rely on the
   * field being absent once a skill is healthy again.
   *
   * Throws when `skillId` is not known to this domain — replay is
   * expected to be called only against skills that were previously
   * recorded via `record()`. Atomicity matches `markUsed()`:
   * `acquireLock` + `writeFileAtomicSafe`.
   */
  async recordReplayResult(
    skillId: string,
    args: { passedAt?: number; failedAt?: number; error?: string },
  ): Promise<void> {
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('SkillMemoryStore.recordReplayResult: skill_id must be a non-empty string');
    }
    const passedAt = args.passedAt;
    const failedAt = args.failedAt;
    if (passedAt === undefined && failedAt === undefined) {
      throw new Error(
        'SkillMemoryStore.recordReplayResult: exactly one of passedAt / failedAt must be supplied',
      );
    }
    if (passedAt !== undefined && failedAt !== undefined) {
      throw new Error(
        'SkillMemoryStore.recordReplayResult: passedAt and failedAt are mutually exclusive',
      );
    }
    if (passedAt !== undefined && !Number.isFinite(passedAt)) {
      throw new Error('SkillMemoryStore.recordReplayResult: passedAt must be a finite number');
    }
    if (failedAt !== undefined && !Number.isFinite(failedAt)) {
      throw new Error('SkillMemoryStore.recordReplayResult: failedAt must be a finite number');
    }
    this.ensureDomainDir();
    const release = await acquireLock(this.lockFile());
    try {
      const file = this.readFileSync();
      const existing = file.skills[skillId];
      if (!existing) {
        throw new Error(`SkillMemoryStore.recordReplayResult: unknown skill_id=${skillId}`);
      }
      const next: SkillRecord = { ...existing };
      if (passedAt !== undefined) {
        next.lastReplayPassedAt = passedAt;
        // A passing replay supersedes any stored error — keep the field
        // shape clean so consumers can rely on its absence.
        delete next.lastReplayError;
      } else if (failedAt !== undefined) {
        next.lastReplayFailedAt = failedAt;
        if (typeof args.error === 'string' && args.error.length > 0) {
          // Bound the persisted error so a runaway stack trace cannot
          // bloat the on-disk JSON.
          next.lastReplayError =
            args.error.length > 2048 ? args.error.slice(0, 2048) : args.error;
        } else {
          delete next.lastReplayError;
        }
      }
      file.skills[skillId] = next;
      await this.writeFile(file);
    } finally {
      await release();
    }
  }

  /**
   * Mark a skill as used at `ts` (ms epoch). When `success` is true,
   * `success_count` is incremented. `last_used_at` is updated
   * unconditionally so the deterministic-order list reflects most-recent
   * activity regardless of outcome.
   *
   * Throws if the skill_id is unknown — callers should not be calling
   * `markUsed` on something they never `record`-ed.
   */
  async markUsed(skillId: string, ts: number, success: boolean): Promise<void> {
    if (typeof skillId !== 'string' || skillId.length === 0) {
      throw new Error('SkillMemoryStore.markUsed: skill_id must be a non-empty string');
    }
    if (!Number.isFinite(ts)) {
      throw new Error('SkillMemoryStore.markUsed: ts must be a finite number');
    }
    this.ensureDomainDir();
    const release = await acquireLock(this.lockFile());
    try {
      const file = this.readFileSync();
      const existing = file.skills[skillId];
      if (!existing) {
        throw new Error(`SkillMemoryStore.markUsed: unknown skill_id=${skillId}`);
      }
      const next: SkillRecord = {
        ...existing,
        lastUsedAt: ts,
        successCount: success ? existing.successCount + 1 : existing.successCount,
      };
      file.skills[skillId] = next;
      await this.writeFile(file);
    } finally {
      await release();
    }
  }

  /**
   * Write a frozen snapshot to
   * `<rootDir>/<encodedDomain>/snapshots/<snapshotId>.json.gz`.
   *
   * Snapshots are write-once: if the destination already exists, the
   * call fails fast rather than overwriting. This matches the
   * frozen-snapshot semantics the recall layer expects — once a
   * snapshot is captured for a `(session_id, skill_id)` pair, hosts
   * should never see a different payload at the same path.
   *
   * The `skill_id` argument is used as the on-disk basename so callers
   * do not have to manage their own snapshot IDs. Callers needing
   * versioned snapshots for the same skill should embed the version in
   * the snapshot payload itself.
   */
  writeFrozenSnapshot(skillId: string, snapshot: FrozenSnapshot): WriteFrozenSnapshotResult {
    assertSafeSnapshotId(skillId);
    this.ensureDomainDir();
    const dir = this.snapshotsDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${skillId}.json.gz`);
    if (fs.existsSync(target)) {
      throw new Error(
        `SkillMemoryStore.writeFrozenSnapshot: snapshot already exists at ${target} (snapshots are write-once)`,
      );
    }
    const json = JSON.stringify(snapshot);
    const gzipped = zlib.gzipSync(Buffer.from(json, 'utf8'));
    // Write to a sibling temp file then rename so a crash mid-write
    // never leaves a half-gzipped blob at the target path.
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, gzipped);
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort
      }
      throw err;
    }
    return { snapshot_path: target };
  }

  /**
   * Read and gunzip a frozen snapshot. Accepts any absolute path
   * returned by a prior `writeFrozenSnapshot` call (callers normally
   * just plumb the path through from `SkillRecord.frozenSnapshotPath`).
   *
   * The path is validated to live inside this store's snapshots
   * directory so a hostile caller cannot abuse the API as an arbitrary
   * file reader.
   */
  readFrozenSnapshot(snapshotPath: string): FrozenSnapshot {
    if (typeof snapshotPath !== 'string' || snapshotPath.length === 0) {
      throw new Error('SkillMemoryStore.readFrozenSnapshot: path must be a non-empty string');
    }
    const resolved = path.resolve(snapshotPath);
    const root = path.resolve(this.snapshotsDir());
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(
        `SkillMemoryStore.readFrozenSnapshot: path "${snapshotPath}" is outside the domain snapshots dir`,
      );
    }
    const raw = fs.readFileSync(resolved);
    const json = zlib.gunzipSync(raw).toString('utf8');
    return JSON.parse(json) as FrozenSnapshot;
  }
}
