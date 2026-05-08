/**
 * Persistence adapters for the handoff manager.
 *
 * Per #708 v2: handoff state at rest must survive a process restart so
 * a long-lived 2FA challenge does not vaporize when the user
 * accidentally Ctrl-C's the harness. The wire format is JSON; the
 * primary at-rest concern is **token confidentiality** — a leaked
 * token grants single-use authority to resume an in-flight transaction.
 *
 * Three confidentiality tiers (caller picks via constructor):
 *
 *   PlaintextFilePersistence      — JSON on disk at mode 0o600. Use only
 *                                   on dev machines where you trust the
 *                                   filesystem.
 *
 *   EncryptedFilePersistence(key) — AES-256-GCM with the supplied 32-
 *                                   byte key. Used on Linux (keychain
 *                                   not standardized) and as a portable
 *                                   default. Key may come from
 *                                   OPENCHROME_HANDOFF_KEY (hex/base64).
 *
 *   In-memory subclass            — manager spawned without persistence
 *                                   keeps the original in-memory
 *                                   semantics; persistence is opt-in.
 *
 * macOS Keychain / Windows Credential Manager bridges are intentionally
 * scoped to a follow-up — they're external-CLI integrations with
 * platform-specific failure modes, easier to add behind the same
 * `PersistenceAdapter` interface once the Linux baseline lands.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HandoffRecord } from './manager';

const FILENAME = 'handoff.json';
const QUARANTINE_SUFFIX = '.quarantine';

export interface PersistenceAdapter {
  /** Read all stored records. Returns [] for a fresh install. */
  loadAll(): HandoffRecord[];
  /** Persist the full record set atomically. Caller deduplicates. */
  saveAll(records: HandoffRecord[]): void;
  /** Erase persisted state. Best-effort. */
  clear(): void;
}

export interface FilePersistenceOptions {
  rootDir?: string;
}

export function defaultHandoffRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'transactions');
}

function pathFor(rootDir: string): string {
  return path.join(rootDir, FILENAME);
}

function writeAtomic(target: string, body: string | Buffer): void {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/* ------------------------------------------------------------------ */
/* PlaintextFilePersistence                                            */
/* ------------------------------------------------------------------ */

export class PlaintextFilePersistence implements PersistenceAdapter {
  private readonly target: string;

  constructor(opts: FilePersistenceOptions = {}) {
    const root = opts.rootDir ?? defaultHandoffRootDir();
    fs.mkdirSync(root, { recursive: true });
    this.target = pathFor(root);
  }

  loadAll(): HandoffRecord[] {
    if (!fs.existsSync(this.target)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.target, 'utf8')) as { records?: unknown };
      if (!Array.isArray(parsed.records)) return [];
      return parsed.records.filter((r): r is HandoffRecord => isRecordShape(r));
    } catch {
      return [];
    }
  }

  saveAll(records: HandoffRecord[]): void {
    writeAtomic(this.target, JSON.stringify({ records }, null, 2));
  }

  clear(): void {
    try {
      fs.unlinkSync(this.target);
    } catch {
      // already gone — ok
    }
  }
}

/* ------------------------------------------------------------------ */
/* EncryptedFilePersistence (AES-256-GCM)                              */
/* ------------------------------------------------------------------ */

const AES_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface EncryptedFilePersistenceOptions extends FilePersistenceOptions {
  /** 32-byte key. Pass Buffer of length 32, or omit and supply via env. */
  key?: Buffer;
  /** Env var to read the key from when `key` is omitted. */
  keyEnvVar?: string;
}

export class EncryptedFilePersistence implements PersistenceAdapter {
  private readonly target: string;
  private readonly key: Buffer;

  constructor(opts: EncryptedFilePersistenceOptions = {}) {
    const root = opts.rootDir ?? defaultHandoffRootDir();
    fs.mkdirSync(root, { recursive: true });
    this.target = pathFor(root);
    this.key = resolveKey(opts);
  }

  /**
   * Load all persisted handoff records.
   *
   * Fail-closed behaviour on corruption:
   *   1. Auth-tag / decryption failure renames the bad blob to
   *      `<file>.corrupt-<timestamp>` for operator inspection, writes a
   *      `<file>.quarantine` sentinel file, then throws so the current
   *      boot is rejected.
   *   2. On subsequent boots the sentinel is detected before the
   *      "no file → []" path and throws again.  The quarantine is
   *      intentionally NOT self-healing — restart-on-failure loops
   *      cannot silently recover with cleared attempt counters.
   *
   * Recovery (operator steps):
   *   1. Inspect `<file>.corrupt-<timestamp>` to determine root cause.
   *   2. If safe to discard, remove BOTH the `.corrupt-*` and `.quarantine`
   *      files.  The next boot will start fresh with empty state.
   *   3. If the key was rotated, restore a clean encrypted file or let the
   *      manager re-initialize after removing the sentinel.
   */
  loadAll(): HandoffRecord[] {
    // Check for a quarantine sentinel left by a previous corrupt-boot.
    // This must be evaluated before the existsSync check so that
    // restart-on-failure environments cannot silently recover after one
    // failed boot (the rename removed the main file, but the sentinel
    // remains as the "block" marker).
    const sentinel = `${this.target}${QUARANTINE_SUFFIX}`;
    if (fs.existsSync(sentinel)) {
      let details = '';
      try {
        details = fs.readFileSync(sentinel, 'utf8').trim();
      } catch {
        // ignore read error — the file's existence is sufficient
      }
      throw new Error(
        `EncryptedFilePersistence: handoff persistence quarantined — ` +
          `a previous boot detected a decryption/auth-tag failure. ` +
          `Details: ${details || '(none)'}. ` +
          `Remove ${sentinel} after investigating the accompanying ` +
          `*.corrupt-* file to allow the next boot to start with empty state.`,
      );
    }

    if (!fs.existsSync(this.target)) return [];
    let blob: Buffer;
    try {
      blob = fs.readFileSync(this.target);
    } catch (err) {
      // I/O error reading the file — not a tamper signal, re-raise.
      throw new Error(`EncryptedFilePersistence: failed to read ${this.target}: ${String(err)}`);
    }
    let plaintext: Buffer;
    try {
      plaintext = decrypt(blob, this.key);
    } catch (err) {
      // Auth-tag / decryption failure: tampered ciphertext or wrong key.
      // 1. Rename the bad blob so operators can inspect it.
      // 2. Write a sentinel file so subsequent boots also fail closed
      //    (the rename removed the main file, otherwise restart loops
      //    would silently recover with empty state and reset attempt
      //    counters, defeating maxPerTxn protection).
      const corrupt = `${this.target}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.target, corrupt);
      } catch {
        // rename best-effort; original file stays if rename fails
      }
      // Write the quarantine sentinel unconditionally (mode 0o600).
      const sentinelBody =
        `quarantined=${new Date().toISOString()} ` +
        `corrupt=${corrupt} ` +
        `reason=decryption/auth-tag failure`;
      try {
        fs.writeFileSync(sentinel, sentinelBody, { mode: 0o600 });
      } catch {
        // sentinel write is best-effort; the throw below still protects
        // the current boot regardless
      }
      const msg =
        `EncryptedFilePersistence: decryption/auth-tag failure — ` +
        `persisted handoff file may be tampered or was written with a different key. ` +
        `File quarantined as ${corrupt}. ` +
        `A sentinel has been written to ${sentinel}; remove it after investigation ` +
        `to allow the next boot to start with empty state. ` +
        `Startup fails closed to protect maxPerTxn guarantees.`;
      console.error(msg);
      throw new Error(msg);
    }
    try {
      const parsed = JSON.parse(plaintext.toString('utf8')) as { records?: unknown };
      if (!Array.isArray(parsed.records)) return [];
      return parsed.records.filter((r): r is HandoffRecord => isRecordShape(r));
    } catch (err) {
      throw new Error(`EncryptedFilePersistence: failed to parse decrypted handoff JSON: ${String(err)}`);
    }
  }

  saveAll(records: HandoffRecord[]): void {
    const plaintext = Buffer.from(JSON.stringify({ records }), 'utf8');
    const encrypted = encrypt(plaintext, this.key);
    writeAtomic(this.target, encrypted);
  }

  clear(): void {
    // Remove the main data file.
    try {
      fs.unlinkSync(this.target);
    } catch {
      // already gone — ok
    }
    // Remove the quarantine sentinel so the next boot is not blocked.
    const sentinel = `${this.target}${QUARANTINE_SUFFIX}`;
    try {
      fs.unlinkSync(sentinel);
    } catch {
      // not present — ok
    }
    // Remove any corrupt-blob siblings left by a previous failed boot.
    const dir = path.dirname(this.target);
    const base = path.basename(this.target);
    let siblings: string[] = [];
    try {
      siblings = fs.readdirSync(dir);
    } catch {
      // directory gone or unreadable — nothing to clean up
    }
    for (const name of siblings) {
      if (name.startsWith(`${base}.corrupt-`)) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          console.error(
            `EncryptedFilePersistence.clear(): could not remove corrupt blob ${path.join(dir, name)}`,
          );
        }
      }
    }
  }
}

function resolveKey(opts: EncryptedFilePersistenceOptions): Buffer {
  if (opts.key) {
    if (opts.key.length !== KEY_BYTES) {
      throw new Error(`encryption key must be ${KEY_BYTES} bytes; got ${opts.key.length}`);
    }
    return opts.key;
  }
  const envVar = opts.keyEnvVar ?? 'OPENCHROME_HANDOFF_KEY';
  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(
      `EncryptedFilePersistence: no key supplied and ${envVar} is unset (provide 32 bytes hex or base64)`,
    );
  }
  return parseKey(raw);
}

/** Accept hex (64 chars), base64 (44 chars), or base64url. */
function parseKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]+$/.test(raw)) {
    if (raw.length !== KEY_BYTES * 2) {
      throw new Error(`hex key must be ${KEY_BYTES * 2} chars; got ${raw.length}`);
    }
    return Buffer.from(raw, 'hex');
  }
  // base64 / base64url
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(padded, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(`base64 key must decode to ${KEY_BYTES} bytes; got ${buf.length}`);
  }
  return buf;
}

/**
 * Wire format: [iv (12) | ciphertext | tag (16)]. Nonce-misuse risk is
 * negligible because we generate a fresh random IV on every save and
 * keys are 32 bytes.
 */
function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('blob too short to be valid AES-GCM ciphertext');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/* ------------------------------------------------------------------ */
/* NoopPersistence (in-memory only, no disk I/O)                       */
/* ------------------------------------------------------------------ */

/**
 * No-op adapter: satisfies the PersistenceAdapter interface but never
 * touches the filesystem. Used as the safe default when no encryption
 * key is available so that resume tokens are never written to disk in
 * plaintext.
 */
export class NoopPersistence implements PersistenceAdapter {
  loadAll(): HandoffRecord[] {
    return [];
  }
  saveAll(_records: HandoffRecord[]): void {
    // intentionally no-op
  }
  clear(): void {
    // intentionally no-op
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecordShape(r: unknown): r is HandoffRecord {
  if (!r || typeof r !== 'object') return false;
  const obj = r as Record<string, unknown>;
  return (
    typeof obj.txn_id === 'string' &&
    typeof obj.token === 'string' &&
    typeof obj.attempt === 'number' &&
    typeof obj.status === 'string' &&
    typeof obj.created_at === 'number' &&
    typeof obj.expires_at === 'number'
  );
}

/**
 * Convenience: pick a default adapter based on environment.
 *
 *   OPENCHROME_HANDOFF_KEY set        → EncryptedFilePersistence
 *   otherwise                          → NoopPersistence (in-memory only)
 *
 * When no encryption key is present the factory intentionally returns
 * NoopPersistence rather than PlaintextFilePersistence. Resume tokens
 * authorize in-flight transactions and must never be written to disk
 * unencrypted in a misconfigured environment. Handoffs still work
 * in-memory for the duration of the process; they just will not survive
 * a restart. A one-time warning is emitted so operators know.
 *
 * Hosts that want OS keychain or anything else should construct the
 * adapter directly. The factory exists for "give me a sane default"
 * callers (e.g., the main MCP server boot path).
 */
let _warnedNoKey = false;
/** @internal Test hook: reset the one-shot warning flag. */
export function _resetAutoSelectWarning(): void {
  _warnedNoKey = false;
}
export function autoSelectHandoffPersistence(
  opts: FilePersistenceOptions = {},
): PersistenceAdapter {
  if (process.env.OPENCHROME_HANDOFF_KEY) {
    return new EncryptedFilePersistence(opts);
  }
  if (!_warnedNoKey) {
    _warnedNoKey = true;
    console.error(
      'autoSelectHandoffPersistence: OPENCHROME_HANDOFF_KEY is unset — ' +
        'handoff state will NOT be persisted to disk. ' +
        'Set OPENCHROME_HANDOFF_KEY (32-byte hex or base64) to enable encrypted persistence.',
    );
  }
  return new NoopPersistence();
}
