/**
 * Tier: pilot. Local credential vault backed by handoff AES-256-GCM persistence.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPilotEnabled } from '../../harness/flags';
import { EphemeralEncryptedPersistence } from '../handoff/persistence';
import { deriveVaultKey, VAULT_KEY_BYTES } from './kdf';

const DATASET_TOKEN = '__openchrome_credentials_v1__';
const SALT_FILE = 'credentials.salt';
const MACHINE_KEY_FILE = 'machine.key';

type VaultDataset = Record<string, { value: string; updatedAt: string }>;

export class VaultError extends Error {
  constructor(public readonly code: 'VAULT_DISABLED' | 'VAULT_MISS' | 'VAULT_DECRYPT_FAILED' | 'VAULT_INVALID_NAME', message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

class RawKeyEncryptedPersistence extends EphemeralEncryptedPersistence {
  constructor(rootDir: string, key: Buffer) {
    super(rootDir);
    if (key.length !== VAULT_KEY_BYTES) throw new Error(`Vault key must be exactly ${VAULT_KEY_BYTES} bytes`);
    this.key = Buffer.from(key);
  }
}

export interface VaultStoreOptions { rootDir?: string; passphrase?: string }
export interface VaultEntryListItem { name: string; updatedAt: string }

function defaultVaultDir(): string {
  return process.env.OPENCHROME_VAULT_DIR || path.join(os.homedir(), '.openchrome', 'vault');
}
function ensureDir(dir: string): void { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function readOrCreateBytes(filePath: string, bytes: number): Buffer {
  try { const existing = fs.readFileSync(filePath); if (existing.length === bytes) return existing; } catch { /* create */ }
  const fresh = crypto.randomBytes(bytes);
  fs.writeFileSync(filePath, fresh, { mode: 0o600 });
  return fresh;
}
function normalizeName(name: string): string {
  const trimmed = String(name || '').trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) {
    throw new VaultError('VAULT_INVALID_NAME', 'Vault credential name must match /^[A-Za-z0-9._-]{1,128}$/');
  }
  return trimmed;
}
export function vaultRefName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('vault://')) return null;
  return decodeURIComponent(value.slice('vault://'.length));
}
export function vaultToken(name: string): string { return `<vault:${name}>`; }

export class CredentialVaultStore {
  private readonly rootDir: string;
  private readonly passphrase?: string;
  constructor(opts: VaultStoreOptions = {}) {
    this.rootDir = opts.rootDir || defaultVaultDir();
    this.passphrase = opts.passphrase ?? process.env.OPENCHROME_VAULT_PASSPHRASE;
  }
  async list(): Promise<VaultEntryListItem[]> {
    const data = await this.readDataset({ allowMissing: true });
    return Object.entries(data).map(([name, entry]) => ({ name, updatedAt: entry.updatedAt })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async save(name: string, value: string): Promise<void> {
    const key = normalizeName(name);
    const data = await this.readDataset({ allowMissing: true });
    data[key] = { value: String(value), updatedAt: new Date().toISOString() };
    await this.writeDataset(data);
  }
  async get(name: string): Promise<string | null> {
    const key = normalizeName(name);
    const data = await this.readDataset({ allowMissing: true });
    return data[key]?.value ?? null;
  }
  async delete(name: string): Promise<boolean> {
    const key = normalizeName(name);
    const data = await this.readDataset({ allowMissing: true });
    const existed = Object.prototype.hasOwnProperty.call(data, key);
    if (existed) { delete data[key]; await this.writeDataset(data); }
    return existed;
  }
  async rotateKey(newPassphrase?: string): Promise<void> {
    const data = await this.readDataset({ allowMissing: true });
    const next = new CredentialVaultStore({ rootDir: this.rootDir, passphrase: newPassphrase ?? this.passphrase });
    await next.resetKeyMaterial();
    await next.writeDataset(data);
  }
  async resolveRef(ref: string): Promise<{ name: string; value: string; token: string }> {
    const rawName = vaultRefName(ref);
    if (!rawName) return { name: '', value: ref, token: ref };
    const name = normalizeName(rawName);
    const value = await this.get(name);
    if (value === null) throw new VaultError('VAULT_MISS', `Vault credential not found: ${name}`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const trace = require('../../core/trace/redactor') as typeof import('../../core/trace/redactor');
      trace.registerVaultTraceRedaction(name, value);
    } catch { /* best-effort */ }
    return { name, value, token: vaultToken(name) };
  }
  private async adapter(): Promise<EphemeralEncryptedPersistence> {
    ensureDir(this.rootDir);
    const key = this.passphrase
      ? await deriveVaultKey(this.passphrase, readOrCreateBytes(path.join(this.rootDir, SALT_FILE), 16))
      : readOrCreateBytes(path.join(this.rootDir, MACHINE_KEY_FILE), VAULT_KEY_BYTES);
    return new RawKeyEncryptedPersistence(this.rootDir, key);
  }
  private async resetKeyMaterial(): Promise<void> {
    ensureDir(this.rootDir);
    fs.writeFileSync(
      path.join(this.rootDir, this.passphrase ? SALT_FILE : MACHINE_KEY_FILE),
      crypto.randomBytes(this.passphrase ? 16 : VAULT_KEY_BYTES),
      { mode: 0o600 },
    );
  }
  private async readDataset(opts: { allowMissing?: boolean } = {}): Promise<VaultDataset> {
    const raw = await (await this.adapter()).get(DATASET_TOKEN);
    if (raw === null) {
      if (opts.allowMissing) return {};
      throw new VaultError('VAULT_DECRYPT_FAILED', 'Vault dataset is missing or cannot be decrypted');
    }
    try { const parsed = JSON.parse(raw) as VaultDataset; return parsed && typeof parsed === 'object' ? parsed : {}; }
    catch { throw new VaultError('VAULT_DECRYPT_FAILED', 'Vault dataset is corrupt'); }
  }
  private async writeDataset(data: VaultDataset): Promise<void> {
    await (await this.adapter()).put(DATASET_TOKEN, JSON.stringify(data));
  }
}

export function getCredentialVaultStore(opts: VaultStoreOptions = {}): CredentialVaultStore { return new CredentialVaultStore(opts); }
export async function resolveVaultValue(value: unknown): Promise<{ value: unknown; vaultName?: string; token?: string; resolved: boolean }> {
  const name = vaultRefName(value);
  if (!name) return { value, resolved: false };
  if (!isPilotEnabled()) return { value, resolved: false };
  const resolved = await getCredentialVaultStore().resolveRef(String(value));
  return { value: resolved.value, vaultName: resolved.name, token: resolved.token, resolved: true };
}
export function maskVaultPlaintext(text: string, plaintext: string, token: string): string {
  return plaintext ? text.split(plaintext).join(token) : text;
}
