// Tenant-scoped API key store.
// Append-only JSONL log at ~/.openchrome/auth/api-keys.jsonl, replayed into an
// in-memory Map on load. Hashes with argon2id; plaintext is never persisted and
// is returned only once from create()/rotate(). See issue #9 / PR1.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import writeFileAtomic from 'write-file-atomic';
import * as lockfile from 'proper-lockfile';
import * as argon2 from 'argon2';
import type {
  ApiKey,
  ApiKeyCreateInput,
  ApiKeyCreateResult,
  Scope,
} from './api-key-types';

const KEY_PREFIX = 'oc_live_';
const RANDOM_BYTES = 24; // ~32 base62 chars
const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

// Base62 alphabet: 0-9 A-Z a-z (no padding, URL-safe).
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62Encode(buf: Buffer): string {
  // Convert bytes -> bigint -> base62 digits, preserving a fixed output length
  // derived from input size so differently sized buffers map to stable widths.
  if (buf.length === 0) return '';
  let num = 0n;
  for (const byte of buf) {
    num = (num << 8n) | BigInt(byte);
  }
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 62n);
    out = BASE62_ALPHABET[rem] + out;
    num = num / 62n;
  }
  // Pad with leading zero digits to keep output length deterministic.
  // 1 byte ~ log62(256) ~ 1.344 chars -> ceil(n * 1.344)
  const targetLen = Math.ceil(buf.length * Math.log(256) / Math.log(62));
  if (out.length < targetLen) {
    out = BASE62_ALPHABET[0].repeat(targetLen - out.length) + out;
  }
  return out;
}

function computeKeyId(plaintext: string): string {
  const digest = crypto.createHash('sha256').update(plaintext).digest();
  // First 10 chars of base62(sha256(plaintext)). Safe to log.
  return 'k_' + base62Encode(digest).slice(0, 10);
}

function defaultStoreDir(): string {
  return path.join(os.homedir(), '.openchrome', 'auth');
}

function defaultStorePath(): string {
  return path.join(defaultStoreDir(), 'api-keys.jsonl');
}

function cloneRecord(r: ApiKey): ApiKey {
  return {
    keyId: r.keyId,
    keyHash: r.keyHash,
    tenantId: r.tenantId,
    scopes: [...r.scopes],
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    lastUsedAt: r.lastUsedAt,
    description: r.description,
  };
}

function isExpired(r: ApiKey, now: number): boolean {
  return typeof r.expiresAt === 'number' && r.expiresAt < now;
}

function isRevoked(r: ApiKey): boolean {
  return typeof r.revokedAt === 'number';
}

export class ApiKeyStore {
  private readonly storePath: string;
  private readonly lockPath: string;
  private readonly index: Map<string, ApiKey> = new Map();
  // Precomputed decoy hash so verify(unknown) performs argon2.verify with
  // indistinguishable timing vs verify(known). Initialised in open().
  private decoyHash: string = '';

  private constructor(storePath: string) {
    this.storePath = storePath;
    this.lockPath = storePath + '.lock';
  }

  static async open(storePath?: string): Promise<ApiKeyStore> {
    const envOverride = process.env.OPENCHROME_API_KEY_STORE_PATH;
    const finalPath = storePath ?? (envOverride && envOverride.length > 0 ? envOverride : defaultStorePath());
    const dir = path.dirname(finalPath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // Tighten perms on existing dir (mkdir mode only applies on create).
    if (process.platform !== 'win32') {
      try {
        await fs.promises.chmod(dir, 0o700);
      } catch {
        // best-effort
      }
    }

    // Ensure the store file exists with 0600 so proper-lockfile and appends work.
    try {
      await fs.promises.access(finalPath);
    } catch {
      await fs.promises.writeFile(finalPath, '', { mode: 0o600 });
    }
    if (process.platform !== 'win32') {
      try {
        await fs.promises.chmod(finalPath, 0o600);
      } catch {
        // best-effort
      }
    }

    const store = new ApiKeyStore(finalPath);
    await store.loadFromDisk();
    // Pre-hash a throwaway value. Using a random secret each open prevents any
    // adversarial timing signal from a fixed decoy across processes.
    const decoySecret = crypto.randomBytes(32).toString('hex');
    store.decoyHash = await argon2.hash(decoySecret, ARGON2_OPTS);
    return store;
  }

  private async loadFromDisk(): Promise<void> {
    let raw = '';
    try {
      raw = await fs.promises.readFile(this.storePath, 'utf8');
    } catch {
      return;
    }
    if (!raw) return;
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: ApiKey;
      try {
        parsed = JSON.parse(line) as ApiKey;
      } catch (err) {
        console.error('[api-key-store] skipping malformed JSONL line:', err);
        continue;
      }
      if (!parsed || typeof parsed.keyId !== 'string') continue;
      // Latest record wins; revokedAt sticks (do not clear on later records).
      const prior = this.index.get(parsed.keyId);
      if (prior && prior.revokedAt && !parsed.revokedAt) {
        parsed.revokedAt = prior.revokedAt;
      }
      this.index.set(parsed.keyId, parsed);
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    // proper-lockfile requires the target file to exist.
    try {
      await fs.promises.access(this.storePath);
    } catch {
      await fs.promises.writeFile(this.storePath, '', { mode: 0o600 });
    }
    const release = await lockfile.lock(this.storePath, {
      lockfilePath: this.lockPath,
      retries: { retries: 10, minTimeout: 25, maxTimeout: 200 },
      stale: 5000,
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async appendRecord(record: ApiKey): Promise<void> {
    const line = JSON.stringify(record) + '\n';
    await fs.promises.appendFile(this.storePath, line, { mode: 0o600 });
  }

  private async rewriteAll(records: ApiKey[]): Promise<void> {
    const data = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    await new Promise<void>((resolve, reject) => {
      writeFileAtomic(this.storePath, data, { mode: 0o600 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async create(input: ApiKeyCreateInput): Promise<ApiKeyCreateResult> {
    if (!input.tenantId || typeof input.tenantId !== 'string') {
      throw new Error('tenantId is required');
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new Error('at least one scope is required');
    }
    const random = base62Encode(crypto.randomBytes(RANDOM_BYTES)).slice(0, 32);
    const plaintext = `${KEY_PREFIX}${input.tenantId}_${random}`;
    const keyId = computeKeyId(plaintext);
    const keyHash = await argon2.hash(plaintext, ARGON2_OPTS);
    const record: ApiKey = {
      keyId,
      keyHash,
      tenantId: input.tenantId,
      scopes: [...input.scopes] as Scope[],
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
      description: input.description ?? '',
    };
    await this.withLock(async () => {
      await this.appendRecord(record);
      this.index.set(keyId, record);
    });
    return { record: cloneRecord(record), plaintext };
  }

  async list(): Promise<ApiKey[]> {
    return Array.from(this.index.values()).map(cloneRecord);
  }

  async revoke(keyId: string): Promise<boolean> {
    return this.withLock(async () => {
      const existing = this.index.get(keyId);
      if (!existing) return false;
      if (existing.revokedAt) return true; // idempotent
      const updated: ApiKey = { ...existing, revokedAt: Date.now() };
      await this.appendRecord(updated);
      this.index.set(keyId, updated);
      return true;
    });
  }

  async rotate(keyId: string): Promise<ApiKeyCreateResult> {
    const prior = this.index.get(keyId);
    if (!prior) {
      throw new Error(`unknown keyId: ${keyId}`);
    }
    // Revoke old (best-effort idempotent) then create new with same tenant+scopes.
    await this.revoke(keyId);
    return this.create({
      tenantId: prior.tenantId,
      scopes: [...prior.scopes],
      description: prior.description,
      expiresAt: prior.expiresAt,
    });
  }

  async verify(plaintext: string): Promise<ApiKey | null> {
    // Constant-ish time: always perform exactly one argon2.verify regardless of
    // miss/hit, against either the real hash or the decoy.
    const now = Date.now();
    let candidateHash = this.decoyHash;
    let candidate: ApiKey | null = null;

    if (typeof plaintext === 'string' && plaintext.startsWith(KEY_PREFIX)) {
      const keyId = computeKeyId(plaintext);
      const found = this.index.get(keyId) ?? null;
      if (found && !isRevoked(found) && !isExpired(found, now)) {
        candidate = found;
        candidateHash = found.keyHash;
      }
    }

    let ok = false;
    try {
      ok = await argon2.verify(candidateHash, plaintext ?? '');
    } catch {
      ok = false;
    }
    if (ok && candidate) {
      return cloneRecord(candidate);
    }
    return null;
  }

  async touchLastUsed(keyId: string): Promise<void> {
    const existing = this.index.get(keyId);
    if (!existing) return;
    const updated: ApiKey = { ...existing, lastUsedAt: Date.now() };
    // lastUsedAt churn can be frequent; keep file writes serialized but cheap
    // via append. Preserves replay semantics (latest wins, revokedAt sticks).
    await this.withLock(async () => {
      const current = this.index.get(keyId);
      if (!current) return;
      const merged: ApiKey = { ...current, lastUsedAt: updated.lastUsedAt };
      await this.appendRecord(merged);
      this.index.set(keyId, merged);
    });
  }
}

export { defaultStorePath };
