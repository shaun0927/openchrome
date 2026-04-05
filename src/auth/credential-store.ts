/**
 * Credential Store - Encrypted TOTP secret storage
 * Stores secrets in ~/.openchrome/credentials/totp-secrets.enc using AES-256-GCM
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import writeFileAtomic from 'write-file-atomic';
import * as lockfile from 'proper-lockfile';
import { validateBase32, generateTOTP } from './totp-manager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TotpEntry {
  domain: string;
  secret: string;
  issuer?: string;
  addedAt: string;
}

interface TotpStore {
  entries: TotpEntry[];
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

function getCredentialsDir(): string {
  return path.join(os.homedir(), '.openchrome', 'credentials');
}

function getStorePath(): string {
  return path.join(getCredentialsDir(), 'totp-secrets.enc');
}

function getLockPath(): string {
  return getStorePath() + '.lock';
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

function getMachineId(): string {
  let username = 'unknown';
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
  return os.hostname() + username;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  const machineId = getMachineId();
  return crypto.scryptSync(passphrase + machineId, salt, 32) as Buffer;
}

// ---------------------------------------------------------------------------
// Encryption / Decryption
// ---------------------------------------------------------------------------

const SALT_LENGTH = 16;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
// File format: [salt(16)] [iv(16)] [authTag(16)] [ciphertext...]

function encrypt(plaintext: string, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decrypt(data: Buffer, passphrase: string): string {
  if (data.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Credential file is too short or corrupted');
  }

  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(passphrase, salt);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    throw new Error('Failed to decrypt credentials: wrong passphrase or corrupted data');
  }
}

// ---------------------------------------------------------------------------
// Directory and file initialization
// ---------------------------------------------------------------------------

function ensureCredentialsDir(): void {
  const dir = getCredentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function ensureStoreFileExists(storePath: string): void {
  if (!fs.existsSync(storePath)) {
    // Touch the file so proper-lockfile can lock it
    fs.writeFileSync(storePath, Buffer.alloc(0), { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// Read / Write store (caller holds lock)
// ---------------------------------------------------------------------------

function readStore(passphrase: string): TotpStore {
  const storePath = getStorePath();
  const data = fs.readFileSync(storePath);
  if (data.length === 0) {
    return { entries: [] };
  }
  const json = decrypt(data, passphrase);
  return JSON.parse(json) as TotpStore;
}

function writeStore(store: TotpStore, passphrase: string): void {
  const storePath = getStorePath();
  const json = JSON.stringify(store);
  const encrypted = encrypt(json, passphrase);
  // Use synchronous write via writeFileAtomic (sync variant)
  writeFileAtomic.sync(storePath, encrypted, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Passphrase resolution
// ---------------------------------------------------------------------------

// WARNING: The built-in default passphrase provides only obfuscation, not real
// encryption. It is mixed with hostname + username via scrypt, but all components
// are trivially discoverable on the local machine. For meaningful security, set
// OPENCHROME_TOTP_PASSPHRASE to a strong user-supplied secret.
const DEFAULT_PASSPHRASE = 'openchrome-totp-v1';
let passphraseWarned = false;

function resolvePassphrase(passphrase?: string): string {
  if (passphrase) return passphrase;
  const envPassphrase = process.env.OPENCHROME_TOTP_PASSPHRASE;
  if (envPassphrase) return envPassphrase;
  if (!passphraseWarned) {
    console.error('[credential-store] Using default passphrase (obfuscation only). Set OPENCHROME_TOTP_PASSPHRASE for stronger encryption.');
    passphraseWarned = true;
  }
  return DEFAULT_PASSPHRASE;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add or update a TOTP secret for a domain.
 * Throws if `secret` is not valid base32.
 */
export async function addTotpSecret(
  domain: string,
  secret: string,
  issuer?: string,
  passphrase?: string
): Promise<void> {
  if (!validateBase32(secret)) {
    throw new Error(`Invalid base32 secret for domain "${domain}"`);
  }

  const pp = resolvePassphrase(passphrase);
  ensureCredentialsDir();
  const storePath = getStorePath();
  ensureStoreFileExists(storePath);

  // Ensure lock file exists before locking
  const lockPath = getLockPath();
  const lockExists = await fs.promises.access(lockPath).then(() => true).catch(() => false);
  if (!lockExists) {
    await fs.promises.writeFile(lockPath, '', { mode: 0o600 });
  }

  const release = await lockfile.lock(lockPath, { retries: { retries: 5, minTimeout: 50 } });
  try {
    const store = readStore(pp);
    const existing = store.entries.findIndex((e) => e.domain === domain);
    const entry: TotpEntry = {
      domain,
      secret,
      issuer,
      addedAt: new Date().toISOString(),
    };
    if (existing >= 0) {
      store.entries[existing] = entry;
    } else {
      store.entries.push(entry);
    }
    writeStore(store, pp);
  } finally {
    await release();
  }
}

/**
 * Remove a TOTP secret for a domain.
 * Returns true if found and removed, false if not found.
 */
export async function removeTotpSecret(domain: string, passphrase?: string): Promise<boolean> {
  const pp = resolvePassphrase(passphrase);
  ensureCredentialsDir();
  const storePath = getStorePath();
  const storeExists = await fs.promises.access(storePath).then(() => true).catch(() => false);
  if (!storeExists) return false;

  const lockPath = getLockPath();
  const lockExists = await fs.promises.access(lockPath).then(() => true).catch(() => false);
  if (!lockExists) {
    await fs.promises.writeFile(lockPath, '', { mode: 0o600 });
  }

  const release = await lockfile.lock(lockPath, { retries: { retries: 5, minTimeout: 50 } });
  try {
    const store = readStore(pp);
    const before = store.entries.length;
    store.entries = store.entries.filter((e) => e.domain !== domain);
    const removed = store.entries.length < before;
    if (removed) {
      writeStore(store, pp);
    }
    return removed;
  } finally {
    await release();
  }
}

/**
 * List all stored domains with issuer and addedAt (secrets are NOT returned).
 */
export async function listTotpDomains(
  passphrase?: string
): Promise<Array<{ domain: string; issuer?: string; addedAt: string }>> {
  const pp = resolvePassphrase(passphrase);
  ensureCredentialsDir();
  const storePath = getStorePath();
  const storeExists = await fs.promises.access(storePath).then(() => true).catch(() => false);
  if (!storeExists) return [];

  const data = await fs.promises.readFile(storePath);
  if (data.length === 0) return [];

  const store: TotpStore = JSON.parse(decrypt(data, pp));
  return store.entries.map(({ domain, issuer, addedAt }) => ({ domain, issuer, addedAt }));
}

/**
 * Retrieve the decrypted TOTP secret for a domain.
 * Returns null if not found.
 */
export async function getTotpSecret(domain: string, passphrase?: string): Promise<string | null> {
  const pp = resolvePassphrase(passphrase);
  ensureCredentialsDir();
  const storePath = getStorePath();
  const storeExists = await fs.promises.access(storePath).then(() => true).catch(() => false);
  if (!storeExists) return null;

  const data = await fs.promises.readFile(storePath);
  if (data.length === 0) return null;

  const store: TotpStore = JSON.parse(decrypt(data, pp));
  const entry = store.entries.find((e) => e.domain === domain);
  return entry?.secret ?? null;
}

/**
 * Convenience: retrieve the TOTP secret for a domain and generate the current code.
 * Returns null if the domain is not found.
 */
export async function generateTotpForDomain(
  domain: string,
  passphrase?: string
): Promise<string | null> {
  const secret = await getTotpSecret(domain, passphrase);
  if (secret === null) return null;
  try {
    return generateTOTP(secret);
  } catch (err) {
    console.error(`[credential-store] Failed to generate TOTP for "${domain}":`, err);
    return null;
  }
}
