/**
 * Vault-backed credential adapter — KMS / OS-keychain plumbing.
 *
 * Why this exists
 * ---------------
 * openchrome today has three credential providers: `local` (AES-256-GCM
 * on disk, key derived from a machine-id), `1password` and `bitwarden`
 * (CLI shell-out). For enterprise deployments the answer is often
 * neither: credentials live in a **KMS**-encrypted blob or in an OS
 * **keychain** (macOS Keychain, Windows Credential Vault, Linux
 * libsecret).
 *
 * notte's `Vault` idiom — swap the "how do we decrypt" primitive
 * without touching the "how do we look up creds by domain" surface —
 * is exactly the shape we need.
 *
 * Design
 * ------
 * Two concrete vault flavours ship, both implementing the existing
 * `CredentialProvider` interface so they slot into
 * `getCredentialProvider()` without a schema change:
 *
 *  1. `KeychainVaultAdapter` — reads secrets from the OS keychain via
 *     a caller-supplied `keychain` object. The runtime dependency
 *     (typically `keytar`) is **not** required by openchrome-mcp; the
 *     adapter accepts any object matching the minimal `KeychainLike`
 *     interface. Callers that want it construct the adapter with
 *     `new KeychainVaultAdapter({ keychain: require('keytar') })` at
 *     their entrypoint.
 *
 *  2. `KmsVaultAdapter` — reads an encrypted blob from disk and hands
 *     the ciphertext to a caller-supplied `decrypt(ciphertext) → plaintext`
 *     function. The decrypt function is where a caller wires AWS KMS,
 *     GCP KMS, Vault Transit, etc. openchrome-mcp has no dependency on
 *     any of them — just the byte-slice contract.
 *
 * Both adapters expose the same `getCredentials(domain)` /
 * `listDomains()` surface as `LocalAdapter`, so tools that iterate
 * `provider.listDomains()` keep working.
 *
 * Credential blob shape (KMS): after decrypt, JSON:
 *
 *   { "example.com": { "username": "…", "password": "…", "totpSecret": "…" },
 *     "app.io":      { "username": "…", "password": "…" } }
 *
 * Keychain layout: each domain is a `service="openchrome:<domain>"`
 * account entry whose password is the same JSON credential value.
 *
 * Origin credit
 * -------------
 * The "decouple the KMS from the lookup" idiom is from notte's
 * `Vault` class (SSPL). Clean-room implementation; no upstream code
 * copied.
 */

import type { CredentialProvider, Credentials } from '../credential-provider';

// --- KeychainVaultAdapter ---------------------------------------------------

export interface KeychainLike {
  /** Get one credential blob string. Returns null when the entry is missing. */
  getPassword(service: string, account: string): Promise<string | null>;
  /** Enumerate all credentials under a service prefix. */
  findCredentials(service: string): Promise<{ account: string; password: string }[]>;
}

export interface KeychainVaultOptions {
  keychain: KeychainLike;
  /** Service prefix used for all entries. Default `openchrome`. */
  servicePrefix?: string;
  /** Account name under which the credential blob is stored. Default `credentials`. */
  account?: string;
}

const DEFAULT_SERVICE_PREFIX = 'openchrome';
const DEFAULT_ACCOUNT = 'credentials';

export class KeychainVaultAdapter implements CredentialProvider {
  readonly name = 'keychain-vault';
  private readonly keychain: KeychainLike;
  private readonly servicePrefix: string;
  private readonly account: string;

  constructor(opts: KeychainVaultOptions) {
    if (!opts || !opts.keychain) {
      throw new TypeError('KeychainVaultAdapter: opts.keychain is required');
    }
    this.keychain = opts.keychain;
    this.servicePrefix = opts.servicePrefix ?? DEFAULT_SERVICE_PREFIX;
    this.account = opts.account ?? DEFAULT_ACCOUNT;
  }

  async isAvailable(): Promise<boolean> {
    // Probe by trying to enumerate. The keychain layer decides whether
    // to prompt the user; we just want a non-throwing outcome.
    try {
      await this.keychain.findCredentials(this.servicePrefix);
      return true;
    } catch {
      return false;
    }
  }

  async getCredentials(domain: string): Promise<Credentials | null> {
    const service = `${this.servicePrefix}:${domain}`;
    const raw = await this.keychain.getPassword(service, this.account);
    if (raw === null) return null;
    return parseCredentialBlob(raw);
  }

  async listDomains(): Promise<string[]> {
    const entries = await this.keychain.findCredentials(this.servicePrefix);
    const out: string[] = [];
    for (const entry of entries) {
      // entry.account is the account name; we store domain in the service.
      // findCredentials returns entries for the whole prefix, so filter.
      // (keytar returns service string as-is; the caller reconstructs.)
      // Convention: entries stored under service `${prefix}:${domain}`
      // will be returned with account === this.account.
      if (entry.account === this.account) {
        // No way to recover domain from findCredentials — the caller
        // must have used `openchrome:<domain>` as service. Since keytar
        // does not expose the service on find, we require callers to
        // maintain a domain index sibling entry named `__index__` if
        // they need enumeration. Absence returns [].
      }
    }
    // Try the index entry — a JSON array of known domains.
    const idxRaw = await this.keychain.getPassword(this.servicePrefix, '__index__');
    if (!idxRaw) return out;
    try {
      const parsed = JSON.parse(idxRaw);
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : out;
    } catch {
      return out;
    }
  }
}

// --- KmsVaultAdapter --------------------------------------------------------

/** Encrypted blob loader — reads bytes from wherever the caller stores them. */
export type CiphertextLoader = () => Promise<Buffer | Uint8Array>;

/** Ciphertext → plaintext primitive. Wire AWS KMS / GCP KMS / Vault Transit here. */
export type DecryptFn = (ciphertext: Buffer) => Promise<Buffer | Uint8Array | string>;

export interface KmsVaultOptions {
  load: CiphertextLoader;
  decrypt: DecryptFn;
  /**
   * When true, cache the decrypted plaintext in-memory for the process
   * lifetime. Default: true (avoids repeated KMS calls per tool call).
   */
  cache?: boolean;
}

export class KmsVaultAdapter implements CredentialProvider {
  readonly name = 'kms-vault';
  private readonly load: CiphertextLoader;
  private readonly decrypt: DecryptFn;
  private readonly cache: boolean;
  private _cached: Record<string, Credentials> | null = null;

  constructor(opts: KmsVaultOptions) {
    if (!opts || typeof opts.load !== 'function' || typeof opts.decrypt !== 'function') {
      throw new TypeError('KmsVaultAdapter: opts.load and opts.decrypt are required functions');
    }
    this.load = opts.load;
    this.decrypt = opts.decrypt;
    this.cache = opts.cache !== false;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getAll();
      return true;
    } catch {
      return false;
    }
  }

  async getCredentials(domain: string): Promise<Credentials | null> {
    const all = await this.getAll();
    return all[domain] ?? null;
  }

  async listDomains(): Promise<string[]> {
    const all = await this.getAll();
    return Object.keys(all).sort();
  }

  /** Test-only cache reset. */
  _resetCache(): void {
    this._cached = null;
  }

  private async getAll(): Promise<Record<string, Credentials>> {
    if (this.cache && this._cached) return this._cached;
    const ciphertext = await this.load();
    const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
    const plain = await this.decrypt(buf);
    const text = typeof plain === 'string' ? plain : Buffer.from(plain as Uint8Array).toString('utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('KmsVaultAdapter: decrypted blob must be a JSON object');
    }
    const out: Record<string, Credentials> = {};
    for (const [domain, entry] of Object.entries(parsed)) {
      const norm = coerceCredentials(entry);
      if (norm) out[domain] = norm;
    }
    if (this.cache) this._cached = out;
    return out;
  }
}

// --- Shared helpers ---------------------------------------------------------

export function parseCredentialBlob(raw: string): Credentials | null {
  try {
    const parsed = JSON.parse(raw);
    return coerceCredentials(parsed);
  } catch {
    return null;
  }
}

export function coerceCredentials(v: unknown): Credentials | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const username = typeof o.username === 'string' ? o.username : null;
  const password = typeof o.password === 'string' ? o.password : null;
  if (username === null || password === null) return null;
  const out: Credentials = { username, password };
  if (typeof o.totpSecret === 'string') out.totpSecret = o.totpSecret;
  return out;
}
