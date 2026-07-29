/** Durable, owner-scoped evidence artifacts produced by oc_assert. */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { redactSecretString } from '../secrets/redactor';
import { redactValue } from '../trace/redactor';
import { redactContractFactValue } from './contract-fact-redaction';

export const ASSERT_EVIDENCE_SCHEMA_VERSION = 1;
export const DEFAULT_ASSERT_EVIDENCE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_ASSERT_EVIDENCE_SWEEP_INTERVAL_MS = 60 * 1000;
export const DEFAULT_ASSERT_EVIDENCE_MAX_ARTIFACT_BYTES = 1024 * 1024;
export const DEFAULT_ASSERT_EVIDENCE_MAX_OWNER_BYTES = 16 * 1024 * 1024;
export const DEFAULT_ASSERT_EVIDENCE_MAX_OWNER_ARTIFACTS = 256;
export const DEFAULT_ASSERT_EVIDENCE_MAX_INSTANCE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ASSERT_EVIDENCE_MAX_INSTANCE_ARTIFACTS = 1024;

const ASSERT_EVIDENCE_STORAGE_VERSION = 1;
const PROCESS_ASSERT_EVIDENCE_INSTANCE_ID = randomUUID();

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HANDLE_RE = new RegExp(`^ev_${UUID_SOURCE}$`, 'i');
const ARTIFACT_FILE_RE = new RegExp(`^ev_${UUID_SOURCE}\\.json$`, 'i');
const TEMP_FILE_RE = new RegExp(`^ev_${UUID_SOURCE}\\.json\\.\\d+\\.${UUID_SOURCE}\\.tmp$`, 'i');
const OPAQUE_CDP_ID_RE = /^[0-9a-f]{32}$/i;

export type AssertEvidenceVerdict = 'pass' | 'fail' | 'inconclusive';
export type AssertEvidenceStoreErrorCode =
  | 'malformed_handle'
  | 'not_found'
  | 'expired'
  | 'forbidden'
  | 'corrupt';
export type AssertEvidencePersistErrorCode =
  | 'artifact_too_large'
  | 'owner_quota_exceeded'
  | 'instance_quota_exceeded';

export interface AssertEvidenceTraceUnavailable {
  status: 'unavailable';
  reason: string;
}

export interface AssertEvidenceProvenance {
  session_id: string;
  tenant_id: string;
  target_id?: string;
  worker_id?: string;
  page_url?: string;
  captured_at?: string;
  contract_source: 'inline' | 'registry';
  contract_id?: string;
  verified_at: string;
  verdict: AssertEvidenceVerdict;
}

export interface AssertEvidenceArtifact {
  schema_version: typeof ASSERT_EVIDENCE_SCHEMA_VERSION;
  evidence_handle: string;
  created_at: string;
  expires_at: string;
  provenance: AssertEvidenceProvenance;
  assertion: unknown;
  result: Record<string, unknown>;
  trace: AssertEvidenceTraceUnavailable;
}

export interface AssertEvidencePersistInput {
  sessionId: string;
  tenantId: string;
  verdict: AssertEvidenceVerdict;
  contractSource: 'inline' | 'registry';
  contractId?: string;
  targetId?: string;
  workerId?: string;
  pageUrl?: string;
  capturedAt?: string;
  assertion: unknown;
  result: Record<string, unknown>;
  trace: AssertEvidenceTraceUnavailable;
}

export interface AssertEvidenceHandle {
  evidence_handle: string;
  created_at: string;
  expires_at: string;
}

export interface AssertEvidenceOwner {
  sessionId: string;
  tenantId: string;
}

export interface AssertEvidenceStoreOptions {
  rootDir?: string;
  ttlMs?: number;
  now?: () => number;
  sweepIntervalMs?: number;
  /** Stable for one OpenChrome process; separates otherwise-identical logical sessions. */
  instanceId?: string;
  maxArtifactBytes?: number;
  maxOwnerBytes?: number;
  maxOwnerArtifacts?: number;
  maxInstanceBytes?: number;
  maxInstanceArtifacts?: number;
}

interface StoredAssertEvidenceRecord {
  storage_version: typeof ASSERT_EVIDENCE_STORAGE_VERSION;
  owner: {
    instance_sha256: string;
    session_sha256: string;
    tenant_sha256: string;
  };
  artifact: AssertEvidenceArtifact;
}

interface StoredAssertEvidenceEnvelope {
  storage_version: typeof ASSERT_EVIDENCE_STORAGE_VERSION;
  owner: StoredAssertEvidenceRecord['owner'];
  artifact: unknown;
}

interface AssertEvidenceIndexEntry {
  sizeBytes: number;
  expiresAtMs: number;
  sessionSha256: string;
  tenantSha256: string;
}

interface AssertEvidenceUsage {
  bytes: number;
  count: number;
}

export class AssertEvidenceStoreError extends Error {
  constructor(
    public readonly code: AssertEvidenceStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssertEvidenceStoreError';
  }
}

export class AssertEvidencePersistError extends Error {
  constructor(
    public readonly code: AssertEvidencePersistErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssertEvidencePersistError';
  }
}

export function defaultAssertEvidenceRootDir(): string {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
    return path.join(os.tmpdir(), `openchrome-assert-evidence-${process.pid}`);
  }
  return path.join(os.homedir(), '.openchrome', 'evidence', 'assertions');
}

export class AssertEvidenceStore {
  private readonly rootDir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sweepIntervalMs?: number;
  private readonly instanceId: string;
  private readonly instanceSha256: string;
  private readonly maxArtifactBytes: number;
  private readonly maxOwnerBytes: number;
  private readonly maxOwnerArtifacts: number;
  private readonly maxInstanceBytes: number;
  private readonly maxInstanceArtifacts: number;
  private readonly artifactIndex = new Map<string, AssertEvidenceIndexEntry>();
  private readonly ownerUsage = new Map<string, AssertEvidenceUsage>();
  private instanceUsage: AssertEvidenceUsage = { bytes: 0, count: 0 };
  private indexInitialized = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AssertEvidenceStoreOptions = {}) {
    this.rootDir = options.rootDir ?? defaultAssertEvidenceRootDir();
    this.ttlMs = normalizeTtl(options.ttlMs);
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = normalizeSweepInterval(options.sweepIntervalMs);
    this.instanceId = normalizeInstanceId(options.instanceId);
    this.instanceSha256 = hashOwnerPart('instance', this.instanceId);
    this.maxArtifactBytes = normalizeLimit(
      options.maxArtifactBytes,
      DEFAULT_ASSERT_EVIDENCE_MAX_ARTIFACT_BYTES,
    );
    this.maxOwnerBytes = normalizeLimit(
      options.maxOwnerBytes,
      DEFAULT_ASSERT_EVIDENCE_MAX_OWNER_BYTES,
    );
    this.maxOwnerArtifacts = normalizeLimit(
      options.maxOwnerArtifacts,
      DEFAULT_ASSERT_EVIDENCE_MAX_OWNER_ARTIFACTS,
    );
    this.maxInstanceBytes = normalizeLimit(
      options.maxInstanceBytes,
      DEFAULT_ASSERT_EVIDENCE_MAX_INSTANCE_BYTES,
    );
    this.maxInstanceArtifacts = normalizeLimit(
      options.maxInstanceArtifacts,
      DEFAULT_ASSERT_EVIDENCE_MAX_INSTANCE_ARTIFACTS,
    );
  }

  persist(input: AssertEvidencePersistInput): AssertEvidenceHandle {
    if (!input.sessionId) throw new Error('AssertEvidenceStore.persist: sessionId is required');
    if (!input.tenantId) throw new Error('AssertEvidenceStore.persist: tenantId is required');
    this.ensureSweepStarted();
    this.ensureRoot();
    this.ensureIndexInitialized();
    this.pruneExpiredIndexedEntries();

    const nowMs = this.now();
    const handle = `ev_${randomUUID()}`;
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.ttlMs).toISOString();
    const artifact = redactArtifact({
      schema_version: ASSERT_EVIDENCE_SCHEMA_VERSION,
      evidence_handle: handle,
      created_at: createdAt,
      expires_at: expiresAt,
      provenance: {
        session_id: input.sessionId,
        tenant_id: input.tenantId,
        ...(input.targetId ? { target_id: input.targetId } : {}),
        ...(input.workerId ? { worker_id: input.workerId } : {}),
        ...(input.pageUrl ? { page_url: input.pageUrl } : {}),
        ...(input.capturedAt ? { captured_at: input.capturedAt } : {}),
        contract_source: input.contractSource,
        ...(input.contractId ? { contract_id: input.contractId } : {}),
        verified_at: createdAt,
        verdict: input.verdict,
      },
      assertion: input.assertion,
      result: input.result,
      trace: input.trace,
    });
    const record: StoredAssertEvidenceRecord = {
      storage_version: ASSERT_EVIDENCE_STORAGE_VERSION,
      owner: ownerDigest(this.instanceId, input.sessionId, input.tenantId),
      artifact,
    };
    const serialized = JSON.stringify(record, null, 2);
    const sizeBytes = Buffer.byteLength(serialized, 'utf8');
    this.assertWithinQuota(record.owner, sizeBytes);

    const target = this.filePath(handle);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(temporary, target);
      this.addIndexEntry(handle, record, sizeBytes);
    } catch (error) {
      safeUnlink(temporary);
      throw error;
    }

    return {
      evidence_handle: handle,
      created_at: createdAt,
      expires_at: expiresAt,
    };
  }

  loadAuthorized(handle: string, owner: AssertEvidenceOwner): AssertEvidenceArtifact {
    this.ensureSweepStarted();
    const record = this.readEnvelope(handle);
    const expectedOwner = ownerDigest(this.instanceId, owner.sessionId, owner.tenantId);
    if (
      record.owner.instance_sha256 !== expectedOwner.instance_sha256
      || record.owner.session_sha256 !== expectedOwner.session_sha256
      || record.owner.tenant_sha256 !== expectedOwner.tenant_sha256
    ) {
      throw new AssertEvidenceStoreError(
        'forbidden',
        'Evidence is owned by another OpenChrome instance, session, or tenant',
      );
    }

    if (!isArtifact(record.artifact, handle)) {
      throw new AssertEvidenceStoreError('corrupt', 'Evidence artifact has an invalid schema');
    }
    const artifact = record.artifact;
    if (Date.parse(artifact.expires_at) <= this.now()) {
      throw new AssertEvidenceStoreError('expired', 'Evidence handle has expired');
    }

    return redactArtifact(artifact, owner);
  }

  evictSession(sessionId: string, tenantId: string): number {
    if (!sessionId || !tenantId || !fs.existsSync(this.rootDir)) return 0;
    this.ensureIndexInitialized();
    let removed = 0;
    const sessionDigest = hashOwnerPart('session', sessionId);
    const tenantDigest = hashOwnerPart('tenant', tenantId);
    for (const [handle, entry] of Array.from(this.artifactIndex.entries())) {
      if (
        entry.sessionSha256 !== sessionDigest
        || entry.tenantSha256 !== tenantDigest
      ) continue;
      if (!safeUnlink(this.filePath(handle))) continue;
      this.removeIndexEntry(handle);
      removed += 1;
    }
    return removed;
  }

  cleanupExpired(): number {
    if (!fs.existsSync(this.rootDir)) return 0;
    let removed = 0;
    const nowMs = this.now();
    for (const file of this.artifactFiles()) {
      const filePath = path.join(this.rootDir, file);
      const handle = file.slice(0, -'.json'.length);
      try {
        const record = this.readRecordFile(filePath, handle);
        if (Date.parse(record.artifact.expires_at) > nowMs) continue;
        if (!safeUnlink(filePath)) continue;
        this.removeIndexEntry(handle);
        removed += 1;
      } catch (error) {
        if (!isCorruptEvidenceError(error)) continue;
        if (!safeUnlink(filePath)) continue;
        this.removeIndexEntry(handle);
        removed += 1;
      }
    }
    for (const file of this.temporaryFiles()) {
      const filePath = path.join(this.rootDir, file);
      try {
        if (fs.statSync(filePath).mtimeMs + this.ttlMs > nowMs) continue;
        if (safeUnlink(filePath)) removed += 1;
      } catch {
        // A transient stat/read failure does not prove the temporary file is stale.
      }
    }
    return removed;
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.rootDir, 0o700);
    } catch {
      // Best-effort on filesystems that do not expose POSIX modes.
    }
  }

  private ensureIndexInitialized(): void {
    if (this.indexInitialized) return;
    const nowMs = this.now();
    const indexed: Array<{
      handle: string;
      record: StoredAssertEvidenceRecord;
      sizeBytes: number;
    }> = [];
    for (const file of this.artifactFiles()) {
      const handle = file.slice(0, -'.json'.length);
      const filePath = path.join(this.rootDir, file);
      try {
        const record = this.readRecordFile(filePath, handle);
        if (Date.parse(record.artifact.expires_at) <= nowMs) {
          if (
            !safeUnlink(filePath)
            && record.owner.instance_sha256 === this.instanceSha256
          ) {
            indexed.push({ handle, record, sizeBytes: fs.statSync(filePath).size });
          }
          continue;
        }
        if (record.owner.instance_sha256 !== this.instanceSha256) continue;
        indexed.push({ handle, record, sizeBytes: fs.statSync(filePath).size });
      } catch (error) {
        if (isCorruptEvidenceError(error)) {
          safeUnlink(filePath);
          continue;
        }
        throw error;
      }
    }
    this.artifactIndex.clear();
    this.ownerUsage.clear();
    this.instanceUsage = { bytes: 0, count: 0 };
    for (const entry of indexed) {
      this.addIndexEntry(entry.handle, entry.record, entry.sizeBytes);
    }
    this.indexInitialized = true;
  }

  private pruneExpiredIndexedEntries(): void {
    const nowMs = this.now();
    for (const [handle, entry] of Array.from(this.artifactIndex.entries())) {
      if (entry.expiresAtMs > nowMs) continue;
      if (!safeUnlink(this.filePath(handle))) continue;
      this.removeIndexEntry(handle);
    }
  }

  private assertWithinQuota(
    owner: StoredAssertEvidenceRecord['owner'],
    artifactBytes: number,
  ): void {
    if (artifactBytes > this.maxArtifactBytes) {
      throw new AssertEvidencePersistError(
        'artifact_too_large',
        `Evidence artifact exceeds the ${this.maxArtifactBytes}-byte limit`,
      );
    }

    const usage = this.ownerUsage.get(ownerKey(owner)) ?? { bytes: 0, count: 0 };
    if (usage.bytes + artifactBytes > this.maxOwnerBytes || usage.count + 1 > this.maxOwnerArtifacts) {
      throw new AssertEvidencePersistError(
        'owner_quota_exceeded',
        'Evidence retention quota exceeded for this OpenChrome session and tenant',
      );
    }
    if (
      this.instanceUsage.bytes + artifactBytes > this.maxInstanceBytes
      || this.instanceUsage.count + 1 > this.maxInstanceArtifacts
    ) {
      throw new AssertEvidencePersistError(
        'instance_quota_exceeded',
        'Evidence retention quota exceeded for this OpenChrome instance',
      );
    }
  }

  private addIndexEntry(
    handle: string,
    record: StoredAssertEvidenceRecord,
    sizeBytes: number,
  ): void {
    this.removeIndexEntry(handle);
    const entry: AssertEvidenceIndexEntry = {
      sizeBytes,
      expiresAtMs: Date.parse(record.artifact.expires_at),
      sessionSha256: record.owner.session_sha256,
      tenantSha256: record.owner.tenant_sha256,
    };
    this.artifactIndex.set(handle, entry);
    const key = ownerKey(record.owner);
    const usage = this.ownerUsage.get(key) ?? { bytes: 0, count: 0 };
    usage.bytes += sizeBytes;
    usage.count += 1;
    this.ownerUsage.set(key, usage);
    this.instanceUsage.bytes += sizeBytes;
    this.instanceUsage.count += 1;
  }

  private removeIndexEntry(handle: string): void {
    const entry = this.artifactIndex.get(handle);
    if (!entry) return;
    this.artifactIndex.delete(handle);
    const key = `${entry.sessionSha256}:${entry.tenantSha256}`;
    const usage = this.ownerUsage.get(key);
    if (usage) {
      usage.bytes = Math.max(0, usage.bytes - entry.sizeBytes);
      usage.count = Math.max(0, usage.count - 1);
      if (usage.count === 0) this.ownerUsage.delete(key);
    }
    this.instanceUsage.bytes = Math.max(0, this.instanceUsage.bytes - entry.sizeBytes);
    this.instanceUsage.count = Math.max(0, this.instanceUsage.count - 1);
  }

  stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private ensureSweepStarted(): void {
    if (!this.sweepIntervalMs || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        this.cleanupExpired();
      } catch (error) {
        console.error(
          '[AssertEvidenceStore] Failed to sweep expired artifacts:',
          error instanceof Error ? error.message : error,
        );
      }
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  private artifactFiles(): string[] {
    return fs.readdirSync(this.rootDir).filter((file) => ARTIFACT_FILE_RE.test(file));
  }

  private temporaryFiles(): string[] {
    return fs.readdirSync(this.rootDir).filter((file) => TEMP_FILE_RE.test(file));
  }

  private filePath(handle: string): string {
    assertSafeHandle(handle);
    return path.join(this.rootDir, `${handle}.json`);
  }

  private readEnvelope(handle: string): StoredAssertEvidenceEnvelope {
    const filePath = this.filePath(handle);
    if (!fs.existsSync(filePath)) {
      throw new AssertEvidenceStoreError('not_found', 'Evidence handle was not found');
    }
    return this.readEnvelopeFile(filePath);
  }

  private readEnvelopeFile(filePath: string): StoredAssertEvidenceEnvelope {
    const serialized = fs.readFileSync(filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new AssertEvidenceStoreError('corrupt', 'Evidence artifact is corrupt');
    }
    if (!isStoredEnvelope(parsed)) {
      throw new AssertEvidenceStoreError('corrupt', 'Evidence artifact has an invalid schema');
    }
    return parsed;
  }

  private readRecordFile(filePath: string, expectedHandle?: string): StoredAssertEvidenceRecord {
    const record = this.readEnvelopeFile(filePath);
    if (!isArtifact(record.artifact, expectedHandle)) {
      throw new AssertEvidenceStoreError('corrupt', 'Evidence artifact has an invalid schema');
    }
    return record as StoredAssertEvidenceRecord;
  }
}

function normalizeTtl(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_ASSERT_EVIDENCE_TTL_MS;
  }
  return Math.floor(value);
}

function normalizeSweepInterval(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeInstanceId(value: string | undefined): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return PROCESS_ASSERT_EVIDENCE_INSTANCE_ID;
}

function assertSafeHandle(handle: string): void {
  if (!HANDLE_RE.test(handle)) {
    throw new AssertEvidenceStoreError('malformed_handle', 'Evidence handle is malformed');
  }
}

function ownerDigest(
  instanceId: string,
  sessionId: string,
  tenantId: string,
): StoredAssertEvidenceRecord['owner'] {
  return {
    instance_sha256: hashOwnerPart('instance', instanceId),
    session_sha256: hashOwnerPart('session', sessionId),
    tenant_sha256: hashOwnerPart('tenant', tenantId),
  };
}

function ownerKey(owner: StoredAssertEvidenceRecord['owner']): string {
  return `${owner.session_sha256}:${owner.tenant_sha256}`;
}

function hashOwnerPart(kind: 'instance' | 'session' | 'tenant', value: string): string {
  return createHash('sha256')
    .update(`openchrome/assert-evidence/v1/${kind}\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function redactArtifact(
  artifact: AssertEvidenceArtifact,
  owner?: AssertEvidenceOwner,
): AssertEvidenceArtifact {
  const redacted = redactContractFactValue(artifact);
  const targetId = artifact.provenance.target_id === undefined
    ? undefined
    : redactProvenanceIdentifier(artifact.provenance.target_id);
  const workerId = artifact.provenance.worker_id === undefined
    ? undefined
    : redactProvenanceIdentifier(artifact.provenance.worker_id);
  const ownerProvenance = owner
    ? redactValue({ session_id: owner.sessionId, tenant_id: owner.tenantId }) as {
      session_id: string;
      tenant_id: string;
    }
    : undefined;
  return {
    ...redacted,
    schema_version: artifact.schema_version,
    evidence_handle: artifact.evidence_handle,
    created_at: artifact.created_at,
    expires_at: artifact.expires_at,
    provenance: {
      ...redacted.provenance,
      ...(ownerProvenance ?? {}),
      ...(targetId !== undefined ? { target_id: targetId } : {}),
      ...(workerId !== undefined ? { worker_id: workerId } : {}),
      contract_source: artifact.provenance.contract_source,
      verified_at: artifact.provenance.verified_at,
      verdict: artifact.provenance.verdict,
    },
    result: {
      ...redacted.result,
      verdict: artifact.provenance.verdict,
    },
    trace: {
      ...redacted.trace,
      status: 'unavailable',
    },
  };
}

function redactProvenanceIdentifier(value: string): string {
  // Chrome target IDs are exactly 32 hex characters and are identifiers, not
  // bearer credentials. Preserve that contract while still honoring explicit
  // --secrets literals; every other shape keeps the generic credential scrub.
  if (OPAQUE_CDP_ID_RE.test(value)) return redactSecretString(value);
  return redactValue(value) as string;
}

function isStoredEnvelope(value: unknown): value is StoredAssertEvidenceEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<StoredAssertEvidenceEnvelope>;
  if (record.storage_version !== ASSERT_EVIDENCE_STORAGE_VERSION) return false;
  if (!record.owner || typeof record.owner !== 'object' || Array.isArray(record.owner)) return false;
  if (
    !isSha256(record.owner.instance_sha256)
    || !isSha256(record.owner.session_sha256)
    || !isSha256(record.owner.tenant_sha256)
  ) return false;
  return Object.prototype.hasOwnProperty.call(record, 'artifact');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isArtifact(value: unknown, expectedHandle?: string): value is AssertEvidenceArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const artifact = value as Partial<AssertEvidenceArtifact>;
  if (artifact.schema_version !== ASSERT_EVIDENCE_SCHEMA_VERSION) return false;
  if (typeof artifact.evidence_handle !== 'string' || !HANDLE_RE.test(artifact.evidence_handle)) return false;
  if (expectedHandle && artifact.evidence_handle !== expectedHandle) return false;
  if (typeof artifact.created_at !== 'string' || !Number.isFinite(Date.parse(artifact.created_at))) return false;
  if (typeof artifact.expires_at !== 'string' || !Number.isFinite(Date.parse(artifact.expires_at))) return false;
  if (Date.parse(artifact.expires_at) <= Date.parse(artifact.created_at)) return false;
  if (!artifact.provenance || typeof artifact.provenance !== 'object' || Array.isArray(artifact.provenance)) return false;
  const provenance = artifact.provenance;
  if (typeof provenance.session_id !== 'string' || provenance.session_id.length === 0) return false;
  if (typeof provenance.tenant_id !== 'string' || provenance.tenant_id.length === 0) return false;
  if (provenance.target_id !== undefined && typeof provenance.target_id !== 'string') return false;
  if (provenance.worker_id !== undefined && typeof provenance.worker_id !== 'string') return false;
  if (provenance.page_url !== undefined && typeof provenance.page_url !== 'string') return false;
  if (
    provenance.captured_at !== undefined
    && (typeof provenance.captured_at !== 'string' || !Number.isFinite(Date.parse(provenance.captured_at)))
  ) return false;
  if (provenance.contract_source !== 'inline' && provenance.contract_source !== 'registry') return false;
  if (provenance.contract_source === 'registry' && typeof provenance.contract_id !== 'string') return false;
  if (provenance.contract_id !== undefined && typeof provenance.contract_id !== 'string') return false;
  if (typeof provenance.verified_at !== 'string' || !Number.isFinite(Date.parse(provenance.verified_at))) return false;
  if (provenance.verified_at !== artifact.created_at) return false;
  if (!isVerdict(provenance.verdict)) return false;
  if (!Object.prototype.hasOwnProperty.call(artifact, 'assertion')) return false;
  if (!artifact.trace || artifact.trace.status !== 'unavailable' || typeof artifact.trace.reason !== 'string') return false;
  if (!artifact.result || typeof artifact.result !== 'object' || Array.isArray(artifact.result)) return false;
  if (artifact.result.verdict !== provenance.verdict) return false;
  return true;
}

function isVerdict(value: unknown): value is AssertEvidenceVerdict {
  return value === 'pass' || value === 'fail' || value === 'inconclusive';
}

function safeUnlink(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
}

function isCorruptEvidenceError(error: unknown): error is AssertEvidenceStoreError {
  return error instanceof AssertEvidenceStoreError && error.code === 'corrupt';
}

let singleton: AssertEvidenceStore | null = null;

export function getAssertEvidenceStore(): AssertEvidenceStore {
  if (!singleton) {
    singleton = new AssertEvidenceStore({
      sweepIntervalMs: DEFAULT_ASSERT_EVIDENCE_SWEEP_INTERVAL_MS,
    });
  }
  return singleton;
}

export function setAssertEvidenceStoreForTests(store: AssertEvidenceStore | null): void {
  singleton?.stopSweep();
  singleton = store;
}
