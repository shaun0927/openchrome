import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CredentialVaultStore, resolveVaultValue } from '../../../src/pilot/credentials/store';
import { clearVaultTraceRedactionsForTest, scrubString } from '../../../src/core/trace/redactor';
import { resetFlagsCache } from '../../../src/harness/flags';

describe('pilot credential vault', () => {
  const oldPilot = process.env.OPENCHROME_PILOT;
  const oldDir = process.env.OPENCHROME_VAULT_DIR;
  const oldPass = process.env.OPENCHROME_VAULT_PASSPHRASE;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vault-'));
    process.env.OPENCHROME_VAULT_DIR = dir;
    process.env.OPENCHROME_PILOT = '1';
    delete process.env.OPENCHROME_VAULT_PASSPHRASE;
    resetFlagsCache();
    clearVaultTraceRedactionsForTest();
  });

  afterEach(() => {
    if (oldPilot === undefined) delete process.env.OPENCHROME_PILOT; else process.env.OPENCHROME_PILOT = oldPilot;
    if (oldDir === undefined) delete process.env.OPENCHROME_VAULT_DIR; else process.env.OPENCHROME_VAULT_DIR = oldDir;
    if (oldPass === undefined) delete process.env.OPENCHROME_VAULT_PASSPHRASE; else process.env.OPENCHROME_VAULT_PASSPHRASE = oldPass;
    resetFlagsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('encrypts, decrypts, and list never returns values', async () => {
    const store = new CredentialVaultStore({ rootDir: dir });
    await store.save('demo-user', 'p@ssw0rd');
    await expect(store.get('demo-user')).resolves.toBe('p@ssw0rd');
    await expect(store.list()).resolves.toEqual([{ name: 'demo-user', updatedAt: expect.any(String) }]);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.enc'));
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).not.toContain('p@ssw0rd');
  });

  test('wrong passphrase fails closed', async () => {
    await new CredentialVaultStore({ rootDir: dir, passphrase: 'old' }).save('demo-user', 'secret');
    await expect(new CredentialVaultStore({ rootDir: dir, passphrase: 'wrong' }).get('demo-user')).resolves.toBeNull();
  });

  test('resolves vault references only in pilot mode and registers trace masking', async () => {
    await new CredentialVaultStore({ rootDir: dir }).save('demo-user', 'secret-value');
    const resolved = await resolveVaultValue('vault://demo-user');
    expect(resolved).toMatchObject({ value: 'secret-value', token: '<vault:demo-user>', resolved: true });
    expect(scrubString('typed secret-value')).toBe('typed <vault:demo-user>');

    delete process.env.OPENCHROME_PILOT;
    resetFlagsCache();
    await expect(resolveVaultValue('vault://demo-user')).resolves.toEqual({ value: 'vault://demo-user', resolved: false });
  });

  test('key rotation preserves values and invalidates old key material', async () => {
    const store = new CredentialVaultStore({ rootDir: dir, passphrase: 'old-pass' });
    await store.save('demo-user', 'secret');
    const oldSalt = fs.readFileSync(path.join(dir, 'credentials.salt'));
    await store.rotateKey('new-pass');
    expect(fs.readFileSync(path.join(dir, 'credentials.salt')).equals(oldSalt)).toBe(false);
    await expect(new CredentialVaultStore({ rootDir: dir, passphrase: 'new-pass' }).get('demo-user')).resolves.toBe('secret');
    await expect(new CredentialVaultStore({ rootDir: dir, passphrase: 'old-pass' }).get('demo-user')).resolves.toBeNull();
  });
});
