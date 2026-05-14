/** Tier: pilot. Argon2id key derivation for the local credential vault. */
import * as argon2 from 'argon2';

export const VAULT_KEY_BYTES = 32;
export const VAULT_ARGON2_OPTIONS: argon2.Options & { raw: true } = {
  type: argon2.argon2id,
  memoryCost: 2 ** 15,
  timeCost: 3,
  parallelism: 1,
  hashLength: VAULT_KEY_BYTES,
  raw: true,
};

export async function deriveVaultKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (!passphrase) throw new Error('Vault passphrase must be non-empty');
  if (!Buffer.isBuffer(salt) || salt.length < 16) throw new Error('Vault salt must be at least 16 bytes');
  const key = await argon2.hash(passphrase, { ...VAULT_ARGON2_OPTIONS, salt } as argon2.Options & { raw: true });
  return Buffer.isBuffer(key) ? key : Buffer.from(key);
}
