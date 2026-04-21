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
  // Byte offset up to which the JSONL has already been replayed into `index`,
  // plus the inode observed at that time. verify()/list()/revoke() call
  // syncFromDisk() to incrementally apply lines appended by peer processes so
  // a long-lived store sees cross-process create/revoke in multi-process
  // deployments (fixes issue #9 PR1 Codex P1 review).
  private lastReadSize: number = 0;
  private lastReadIno: number = 0;
  // Coalesce concurrent syncFromDisk() callers so we don't issue redundant
  // reads when verify() is called in a burst.
  private pendingSync: Promise<void> | null = null;

  private constructor(storePath: string) {
    this.storePath = storePath;
    this.lockPath = storePath + '.lock';
  }

  static async open(storePath?: string): Promise<ApiKeyStore> {
    const envOverride = process.env.OPENCHROME_API_KEY_STORE_PATH;
    const finalPath = storePath ?? (envOverride && envOverride.length > 0 ? envOverride : defaultStorePath());
    const dir = path.dirname(finalPath);
    // mkdir returns the first path it had to create, or undefined if the
    // directory tree already existed. Only chmod when WE created the dir —
    // otherwise a caller passing a custom path inside a shared parent
    // (e.g. `/tmp/api-keys.jsonl`) would have that parent's permissions
    // silently rewritten (Codex P2 on a9e73c8).
    const dirCreated = await fs.promises.mkdir(dir, {
      recursive: true,
      mode: 0o700,
    });
    if (dirCreated && process.platform !== 'win32') {
      try {
        await fs.promises.chmod(dir, 0o700);
      } catch {
        // best-effort
      }
    }

    // Ensure the store file exists with 0600 so proper-lockfile and appends
    // work. Only force-chmod if WE just created the file — don't mutate the
    // mode of a pre-existing caller-owned file.
    let fileCreated = false;
    try {
      await fs.promises.access(finalPath);
    } catch {
      await fs.promises.writeFile(finalPath, '', { mode: 0o600 });
      fileCreated = true;
    }
    if (fileCreated && process.platform !== 'win32') {
      try {
        await fs.promises.chmod(finalPath, 0o600);
      } catch {
        // best-effort
      }
    }

    const store = new ApiKeyStore(finalPath);
    await store.syncFromDisk();
    // Pre-hash a throwaway value. Using a random secret each open prevents any
    // adversarial timing signal from a fixed decoy across processes.
    const decoySecret = crypto.randomBytes(32).toString('hex');
    store.decoyHash = await argon2.hash(decoySecret, ARGON2_OPTS);
    return store;
  }

  private applyLines(text: string): void {
    for (const line of text.split('\n')) {
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

  // The actual stat+read body. Never touches `pendingSync` — callers own
  // the coalescing decision. Tolerates torn peer appends by consuming only
  // up to the last newline; a partial trailing record is deferred.
  private async doSyncFromDisk(): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.storePath);
    } catch {
      // File is gone: drop cached state so we don't keep answering for
      // keys that no longer exist on disk.
      this.index.clear();
      this.lastReadSize = 0;
      this.lastReadIno = 0;
      return;
    }
    // File replaced (rotated) or truncated: re-replay from scratch.
    if (
      (this.lastReadIno !== 0 && stat.ino !== this.lastReadIno) ||
      stat.size < this.lastReadSize
    ) {
      this.index.clear();
      this.lastReadSize = 0;
    }
    this.lastReadIno = stat.ino;
    if (stat.size === this.lastReadSize) return;

    const toRead = stat.size - this.lastReadSize;
    const fd = await fs.promises.open(this.storePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(toRead);
      // fd.read can return fewer bytes than requested if the file was
      // truncated/replaced between stat() and read(). Only decode the
      // prefix that was actually filled — the tail of `allocUnsafe` is
      // uninitialized memory and must never be interpreted as content
      // (Codex P1 on a7e216b).
      const { bytesRead } = await fd.read(buf, 0, toRead, this.lastReadSize);
      if (bytesRead <= 0) return;
      if (bytesRead < toRead) {
        // Short read: the file was truncated or replaced between our stat()
        // and read(). Cached state may no longer reflect disk, so drop it;
        // the next syncFromDisk will re-replay from offset 0 (or via the
        // inode-change branch if the file was rotated).
        this.index.clear();
        this.lastReadSize = 0;
        this.lastReadIno = 0;
        return;
      }
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return;
      const complete = text.slice(0, lastNewline + 1);
      this.applyLines(complete);
      this.lastReadSize += Buffer.byteLength(complete, 'utf8');
    } finally {
      await fd.close();
    }
  }

  // Coalesced sync for unlocked read paths (verify, list, rotate-precheck).
  // Concurrent callers share a single in-flight sync to avoid redundant
  // stat+read under burst traffic. NOT safe for writers inside the cross-
  // process lock — use syncInsideLock() there.
  private async syncFromDisk(): Promise<void> {
    if (this.pendingSync) return this.pendingSync;
    this.pendingSync = (async () => {
      try {
        await this.doSyncFromDisk();
      } finally {
        this.pendingSync = null;
      }
    })();
    return this.pendingSync;
  }

  // Writer sync: runs INSIDE the cross-process file lock. Must not reuse
  // an in-flight `pendingSync` because that promise's `stat` may have been
  // taken BEFORE a peer append landed — sharing it would hand the writer a
  // stale EOF, appendRecord would then jump lastReadSize past those peer
  // bytes, and this process would skip them forever. Instead, drain any
  // in-flight sync (to avoid clobbering its lastReadSize mutation) and
  // then run a guaranteed-fresh stat+read ourselves (Codex P1 on 0538a8c).
  private async syncInsideLock(): Promise<void> {
    while (this.pendingSync) {
      try {
        await this.pendingSync;
      } catch {
        // Broken sync: retry until the flag clears (doSyncFromDisk's own
        // errors will re-surface when we run our own fresh sync below).
      }
    }
    this.pendingSync = (async () => {
      try {
        await this.doSyncFromDisk();
      } finally {
        this.pendingSync = null;
      }
    })();
    return this.pendingSync;
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
    let line = JSON.stringify(record) + '\n';
    try {
      const st = await fs.promises.stat(this.storePath);
      if (st.size > 0) {
        const fh = await fs.promises.open(this.storePath, 'r');
        try {
          const tail = Buffer.alloc(1);
          const { bytesRead } = await fh.read(tail, 0, 1, st.size - 1);
          if (bytesRead === 1 && tail[0] !== 0x0a) {
            line = '\n' + line;
          }
        } finally {
          await fh.close();
        }
      }
    } catch {
      // Best-effort: if stat/read fails we still append the record and let the
      // next sync reconcile from disk.
    }
    await fs.promises.appendFile(this.storePath, line, { mode: 0o600 });
    // Advance the read cursor so the next syncFromDisk() doesn't re-parse
    // our own append. Best-effort: on stat failure, the next sync reconciles.
    try {
      const st = await fs.promises.stat(this.storePath);
      this.lastReadSize = st.size;
      this.lastReadIno = st.ino;
    } catch {
      // fallthrough — next sync will detect the change
    }
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
      // Guaranteed-fresh sync inside the cross-process lock: MUST NOT reuse
      // a pre-lock coalesced pendingSync whose stat may predate a peer
      // append, which would leave this process blind to those bytes after
      // appendRecord advances the cursor to EOF (Codex P1 on commits
      // 64af728 + 0538a8c).
      await this.syncInsideLock();
      await this.appendRecord(record);
      this.index.set(keyId, record);
    });
    return { record: cloneRecord(record), plaintext };
  }

  async list(): Promise<ApiKey[]> {
    await this.syncFromDisk();
    return Array.from(this.index.values()).map(cloneRecord);
  }

  async revoke(keyId: string): Promise<boolean> {
    return this.withLock(async () => {
      await this.syncInsideLock();
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
    await this.syncFromDisk();
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
    // Pull in any records appended by peer processes (create/revoke) before
    // we consult the in-memory index. Without this, a long-lived instance
    // would keep honouring revoked keys or reject freshly created ones until
    // process restart.
    await this.syncFromDisk();
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
    // Sync INSIDE the lock so a peer revoke that lands between any pre-lock
    // sync and our lock acquisition is observed before we build `merged`.
    // Syncing outside the lock would leave `current.revokedAt` absent, and
    // appending `{ ...current, lastUsedAt }` plus the subsequent cursor
    // advance to EOF would clobber the peer revoke in this instance's view
    // (Codex P1 on commit 64af728).
    await this.withLock(async () => {
      await this.syncInsideLock();
      const current = this.index.get(keyId);
      if (!current) return;
      const merged: ApiKey = { ...current, lastUsedAt: Date.now() };
      await this.appendRecord(merged);
      this.index.set(keyId, merged);
    });
  }
}

export { defaultStorePath };
