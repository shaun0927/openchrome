/**
 * Self-contained TOTP store for CLI use.
 *
 * Provides TOTP generation (RFC 6238, SHA1, 6 digits, 30s period) and
 * encrypted storage of TOTP secrets using AES-256-GCM.
 *
 * Storage path: ~/.openchrome/credentials/totp-secrets.enc
 * Encryption key: scrypt(hostname + username, salt, 32)
 * File permissions: 0o600 (directory: 0o700)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Base32 helpers
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a base32-encoded string to a Buffer.
 * Accepts uppercase and lowercase input; ignores padding characters.
 */
export function base32Decode(encoded: string): Buffer {
  const input = encoded.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of input) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/**
 * Return true when the input is a valid base32 string (RFC 4648).
 * Allows lowercase, optional padding, and ignores surrounding whitespace.
 */
export function validateBase32(secret: string): boolean {
  const cleaned = secret.trim().toUpperCase().replace(/=+$/, '');
  if (cleaned.length === 0) return false;
  return /^[A-Z2-7]+$/.test(cleaned);
}

// ---------------------------------------------------------------------------
// TOTP generation (RFC 6238)
// ---------------------------------------------------------------------------

/**
 * Generate the current TOTP code for a base32-encoded secret.
 * Uses SHA1, 6 digits, 30-second period.
 */
export function generateTOTP(secret: string): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);

  const counterBuf = Buffer.alloc(8);
  // Write as big-endian 64-bit integer (upper 32 bits are 0 for near-future dates)
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key);
  hmac.update(counterBuf);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Return the number of seconds remaining in the current 30-second TOTP window.
 */
export function totpSecondsRemaining(): number {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM)
// ---------------------------------------------------------------------------

const SALT = 'openchrome-totp-v1';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function deriveKey(): Buffer {
  const passphrase = `${os.hostname()}:${os.userInfo().username}`;
  return crypto.scryptSync(passphrase, SALT, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12) + tag(16) + ciphertext — all hex-encoded
  return Buffer.concat([iv, tag, encrypted]).toString('hex');
}

function decrypt(hexData: string, key: Buffer): string {
  const data = Buffer.from(hexData, 'hex');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function getStoragePath(): string {
  return path.join(os.homedir(), '.openchrome', 'credentials', 'totp-secrets.enc');
}

interface TotpEntry {
  domain: string;
  encryptedSecret: string;
  issuer?: string;
  addedAt: string;
}

function readEntries(): TotpEntry[] {
  const storagePath = getStoragePath();
  if (!fs.existsSync(storagePath)) return [];

  try {
    const raw = fs.readFileSync(storagePath, 'utf8').trim();
    if (!raw) return [];
    const key = deriveKey();
    const plaintext = decrypt(raw, key);
    return JSON.parse(plaintext) as TotpEntry[];
  } catch {
    return [];
  }
}

function writeEntries(entries: TotpEntry[]): void {
  const storagePath = getStoragePath();
  const dir = path.dirname(storagePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const key = deriveKey();
  const plaintext = JSON.stringify(entries, null, 2);
  const encrypted = encrypt(plaintext, key);

  fs.writeFileSync(storagePath, encrypted, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add (or overwrite) a TOTP secret for a domain.
 */
export async function addTotpSecret(domain: string, secret: string, issuer?: string): Promise<void> {
  const entries = readEntries();
  const idx = entries.findIndex((e) => e.domain === domain);

  const key = deriveKey();
  const encryptedSecret = encrypt(secret.toUpperCase().replace(/\s/g, ''), key);

  const entry: TotpEntry = {
    domain,
    encryptedSecret,
    issuer,
    addedAt: new Date().toISOString(),
  };

  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }

  writeEntries(entries);
}

/**
 * Remove a TOTP secret for a domain.
 * Returns true if removed, false if not found.
 */
export async function removeTotpSecret(domain: string): Promise<boolean> {
  const entries = readEntries();
  const idx = entries.findIndex((e) => e.domain === domain);
  if (idx < 0) return false;

  entries.splice(idx, 1);
  writeEntries(entries);
  return true;
}

/**
 * List all configured TOTP domains (never returns secrets).
 */
export async function listTotpDomains(): Promise<Array<{ domain: string; issuer?: string; addedAt: string }>> {
  const entries = readEntries();
  return entries.map(({ domain, issuer, addedAt }) => ({ domain, issuer, addedAt }));
}

/**
 * Retrieve the plaintext TOTP secret for a domain, or null if not found.
 */
export async function getTotpSecret(domain: string): Promise<string | null> {
  const entries = readEntries();
  const entry = entries.find((e) => e.domain === domain);
  if (!entry) return null;

  try {
    const key = deriveKey();
    return decrypt(entry.encryptedSecret, key);
  } catch {
    return null;
  }
}
