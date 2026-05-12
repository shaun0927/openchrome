/**
 * At-rest encryption for persisted handoff tokens (Phase 3, issue #794).
 *
 * Design:
 *   - AES-256-GCM with a random 12-byte IV per record and a 16-byte auth tag.
 *   - Token identity is stored as sha256(token) so the raw token is never
 *     visible in the filesystem (avoids leaking secrets via file names).
 *   - Default mode: ephemeral key generated at construction via
 *     `crypto.randomBytes(32)`. Key is held only in memory; a process
 *     restart invalidates every persisted record.
 *   - Opt-in stable mode: `FileBackedKeyEncryptedPersistence` reads a
 *     32-byte raw key from a file path. Specify the path via the
 *     `OPENCHROME_HANDOFF_KEY_FILE` env var or the `keyFilePath` option
 *     passed to `autoSelectHandoffPersistence`.
 *
 * Wire format (each `.enc` file):
 *   [ 12 bytes IV ][ 16 bytes auth tag ][ N bytes ciphertext ]
 *
 * No OS keychain integration — P3 constraint. Cross-platform by design;
 * uses only `node:crypto`, `node:fs`, and `node:path`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm' as const;

// ---------------------------------------------------------------------------
// PersistenceAdapter interface
// ---------------------------------------------------------------------------

/**
 * Storage contract for persisted handoff payloads. All implementations must
 * treat the `token` parameter as an opaque identifier — they must not log
 * it or store it verbatim on disk.
 */
export interface PersistenceAdapter {
  /** Encrypt and write `payload` keyed by `token`. */
  put(token: string, payload: string): Promise<void>;
  /**
   * Decrypt and return the payload for `token`, or `null` when the file is
   * missing or the auth tag fails (wrong key / tampered ciphertext).
   */
  get(token: string): Promise<string | null>;
  /** Remove the persisted record for `token`. No-op if absent. */
  delete(token: string): Promise<void>;
  /** Remove every persisted record under rootDir. */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the on-disk filename from a token. Using sha256 prevents the raw
 * token bytes from appearing in filesystem paths / directory listings.
 */
function tokenToFilename(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex') + '.enc';
}

function encryptRecord(key: Buffer, payload: string): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [ IV | tag | ciphertext ]
  return Buffer.concat([iv, tag, ct]);
}

function decryptRecord(key: Buffer, data: Buffer): string | null {
  if (data.length < IV_BYTES + TAG_BYTES) return null;
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = data.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct).toString('utf8') + decipher.final('utf8');
  } catch {
    // Auth tag verification failed or other crypto error — treat as missing.
    return null;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// EphemeralEncryptedPersistence
// ---------------------------------------------------------------------------

/**
 * Persists encrypted handoff records to disk using a key that is generated
 * fresh at construction time. The key never leaves memory, so a process
 * restart produces a new key and all previously persisted records become
 * permanently unreadable (returns null on get).
 *
 * This is the safe default: at-rest data is encrypted, but a restart is a
 * natural invalidation boundary — no key material needs protection beyond the
 * process lifetime.
 */
export class EphemeralEncryptedPersistence implements PersistenceAdapter {
  protected key: Buffer;
  protected readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.key = crypto.randomBytes(KEY_BYTES);
  }

  async put(token: string, payload: string): Promise<void> {
    ensureDir(this.rootDir);
    const enc = encryptRecord(this.key, payload);
    const filePath = path.join(this.rootDir, tokenToFilename(token));
    fs.writeFileSync(filePath, enc);
  }

  async get(token: string): Promise<string | null> {
    const filePath = path.join(this.rootDir, tokenToFilename(token));
    let data: Buffer;
    try {
      data = fs.readFileSync(filePath);
    } catch {
      return null;
    }
    return decryptRecord(this.key, data);
  }

  async delete(token: string): Promise<void> {
    const filePath = path.join(this.rootDir, tokenToFilename(token));
    try {
      fs.unlinkSync(filePath);
    } catch {
      // No-op if already absent.
    }
  }

  async clear(): Promise<void> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.rootDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.endsWith('.enc')) {
        try {
          fs.unlinkSync(path.join(this.rootDir, entry));
        } catch {
          // best-effort
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FileBackedKeyEncryptedPersistence
// ---------------------------------------------------------------------------

/**
 * Variant of {@link EphemeralEncryptedPersistence} that loads its 32-byte AES
 * key from a file path at construction time.
 *
 * The file must contain exactly 32 bytes of raw key material. The path is
 * never logged. Useful when the operator manages key rotation externally (e.g.
 * a secrets manager writes the key file on startup).
 *
 * If the key file cannot be read or has the wrong size, construction throws.
 * Callers that want a safe fallback should use `autoSelectHandoffPersistence`
 * instead, which falls back to ephemeral on any error.
 */
export class FileBackedKeyEncryptedPersistence extends EphemeralEncryptedPersistence {
  constructor(rootDir: string, keyFilePath: string) {
    // Call super first (generates an ephemeral key), then overwrite with the
    // file-backed key. We can't skip super() in JS/TS, so we replace the
    // property after the fact via Object.defineProperty to work around the
    // `readonly` constraint.
    super(rootDir);
    const raw = fs.readFileSync(keyFilePath);
    if (raw.length !== KEY_BYTES) {
      throw new Error(
        `FileBackedKeyEncryptedPersistence: key file must be exactly ${KEY_BYTES} bytes, got ${raw.length}`
      );
    }
    // Overwrite the ephemeral key generated by super() with the file-backed key.
    this.key = raw;
  }
}

// ---------------------------------------------------------------------------
// autoSelectHandoffPersistence
// ---------------------------------------------------------------------------

export interface AutoSelectOptions {
  /** Base directory for encrypted .enc record files. */
  rootDir: string;
  /**
   * Optional explicit path to a 32-byte key file. Takes precedence over the
   * `OPENCHROME_HANDOFF_KEY_FILE` environment variable when provided.
   */
  keyFilePath?: string;
}

/**
 * Choose the appropriate persistence adapter based on runtime configuration.
 *
 * Selection logic:
 *   1. Resolve `keyFilePath` from the argument or the
 *      `OPENCHROME_HANDOFF_KEY_FILE` environment variable.
 *   2. If a path is available, the file is readable, and its size is exactly
 *      32 bytes → return `FileBackedKeyEncryptedPersistence`.
 *   3. Otherwise → return `EphemeralEncryptedPersistence` (safe default).
 *
 * This function never throws. Any error (missing file, wrong size, permissions)
 * silently falls back to the ephemeral adapter; a diagnostic is emitted via
 * `console.error` so operators see the fallback without crashing the host.
 */
export function autoSelectHandoffPersistence(opts: AutoSelectOptions): PersistenceAdapter {
  const resolvedPath = opts.keyFilePath ?? process.env['OPENCHROME_HANDOFF_KEY_FILE'];

  if (resolvedPath) {
    try {
      const stat = fs.statSync(resolvedPath);
      if (stat.size !== KEY_BYTES) {
        console.error(
          `[handoff] Key file "${resolvedPath}" is ${stat.size} bytes; expected ${KEY_BYTES}. Falling back to ephemeral key.`
        );
        return new EphemeralEncryptedPersistence(opts.rootDir);
      }
      return new FileBackedKeyEncryptedPersistence(opts.rootDir, resolvedPath);
    } catch (err) {
      console.error(
        `[handoff] Could not read key file (falling back to ephemeral): ${(err as Error).message}`
      );
      return new EphemeralEncryptedPersistence(opts.rootDir);
    }
  }

  return new EphemeralEncryptedPersistence(opts.rootDir);
}
