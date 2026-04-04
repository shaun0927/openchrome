/// <reference types="jest" />
/**
 * Unit tests for the encrypted credential store
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Redirect os.homedir to a per-test temp directory BEFORE importing the module
// ---------------------------------------------------------------------------

let tempDir: string = '';

jest.mock('os', () => {
  const real = jest.requireActual<typeof os>('os');
  return {
    ...real,
    homedir: () => tempDir || real.homedir(),
  };
});

// Import AFTER mock is set up
import {
  addTotpSecret,
  removeTotpSecret,
  listTotpDomains,
  getTotpSecret,
  generateTotpForDomain,
} from '../../src/auth/credential-store';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cred-test-'));
});

afterEach(async () => {
  const dir = tempDir;
  tempDir = '';
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const VALID_SECRET = 'JBSWY3DPEHPK3PXP'; // valid base32
const ANOTHER_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC test vector

describe('addTotpSecret / getTotpSecret', () => {
  test('write-read round-trip preserves secret', async () => {
    await addTotpSecret('example.com', VALID_SECRET, 'Example');
    const retrieved = await getTotpSecret('example.com');
    expect(retrieved).toBe(VALID_SECRET);
  });

  test('returns null for unknown domain', async () => {
    const result = await getTotpSecret('unknown.com');
    expect(result).toBeNull();
  });

  test('rejects invalid base32 on add', async () => {
    await expect(addTotpSecret('bad.com', 'NOT-BASE32!!!')).rejects.toThrow(
      /Invalid base32 secret/
    );
  });

  test('updates existing entry when domain is re-added', async () => {
    await addTotpSecret('example.com', VALID_SECRET, 'Old Issuer');
    await addTotpSecret('example.com', ANOTHER_SECRET, 'New Issuer');
    const retrieved = await getTotpSecret('example.com');
    expect(retrieved).toBe(ANOTHER_SECRET);
  });
});

describe('listTotpDomains', () => {
  test('returns empty array when store does not exist', async () => {
    const list = await listTotpDomains();
    expect(list).toEqual([]);
  });

  test('returns domains and issuers but NOT secrets', async () => {
    await addTotpSecret('github.com', VALID_SECRET, 'GitHub');
    await addTotpSecret('google.com', ANOTHER_SECRET, 'Google');

    const list = await listTotpDomains();
    expect(list).toHaveLength(2);

    const domains = list.map((e) => e.domain);
    expect(domains).toContain('github.com');
    expect(domains).toContain('google.com');

    // No entry should have a "secret" property
    for (const entry of list) {
      expect(Object.keys(entry)).not.toContain('secret');
    }

    // Issuers should be present
    const github = list.find((e) => e.domain === 'github.com');
    expect(github?.issuer).toBe('GitHub');
  });

  test('each entry has an addedAt ISO date string', async () => {
    await addTotpSecret('example.com', VALID_SECRET);
    const list = await listTotpDomains();
    expect(list).toHaveLength(1);
    expect(() => new Date(list[0].addedAt)).not.toThrow();
    expect(new Date(list[0].addedAt).toISOString()).toBe(list[0].addedAt);
  });
});

describe('removeTotpSecret', () => {
  test('removes an existing domain and returns true', async () => {
    await addTotpSecret('example.com', VALID_SECRET, 'Example');
    const removed = await removeTotpSecret('example.com');
    expect(removed).toBe(true);
    const retrieved = await getTotpSecret('example.com');
    expect(retrieved).toBeNull();
  });

  test('returns false for non-existent domain', async () => {
    const removed = await removeTotpSecret('nonexistent.com');
    expect(removed).toBe(false);
  });

  test('preserves other entries when one is removed', async () => {
    await addTotpSecret('github.com', VALID_SECRET, 'GitHub');
    await addTotpSecret('google.com', ANOTHER_SECRET, 'Google');

    await removeTotpSecret('github.com');

    const remaining = await listTotpDomains();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].domain).toBe('google.com');

    const googleSecret = await getTotpSecret('google.com');
    expect(googleSecret).toBe(ANOTHER_SECRET);
  });
});

describe('generateTotpForDomain', () => {
  test('generates a 6-digit code for a stored domain', async () => {
    await addTotpSecret('example.com', VALID_SECRET);
    const code = await generateTotpForDomain('example.com');
    expect(code).not.toBeNull();
    expect(/^\d{6}$/.test(code!)).toBe(true);
  });

  test('returns null for unknown domain', async () => {
    const code = await generateTotpForDomain('unknown.com');
    expect(code).toBeNull();
  });
});

describe('multiple entries', () => {
  test('stores and retrieves multiple independent entries', async () => {
    await addTotpSecret('github.com', VALID_SECRET, 'GitHub');
    await addTotpSecret('google.com', ANOTHER_SECRET, 'Google');
    await addTotpSecret('aws.com', VALID_SECRET, 'AWS');

    expect(await getTotpSecret('github.com')).toBe(VALID_SECRET);
    expect(await getTotpSecret('google.com')).toBe(ANOTHER_SECRET);
    expect(await getTotpSecret('aws.com')).toBe(VALID_SECRET);
  });
});

describe('wrong passphrase', () => {
  test('decryption with wrong passphrase fails with a clear error', async () => {
    await addTotpSecret('example.com', VALID_SECRET, 'Example', 'correct-passphrase');
    await expect(getTotpSecret('example.com', 'wrong-passphrase')).rejects.toThrow(
      /Failed to decrypt credentials|wrong passphrase|corrupted/
    );
  });
});

describe('file permissions', () => {
  // Skip on Windows where POSIX permissions don't apply
  const isWindows = os.platform() === 'win32';

  (isWindows ? test.skip : test)('credentials file has mode 0o600', async () => {
    await addTotpSecret('example.com', VALID_SECRET);
    const storePath = path.join(tempDir, '.openchrome', 'credentials', 'totp-secrets.enc');
    const stat = fs.statSync(storePath);
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  (isWindows ? test.skip : test)('credentials directory has mode 0o700', async () => {
    await addTotpSecret('example.com', VALID_SECRET);
    const credDir = path.join(tempDir, '.openchrome', 'credentials');
    const stat = fs.statSync(credDir);
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe('concurrent access', () => {
  test('two rapid adds produce two entries without data loss', async () => {
    await Promise.all([
      addTotpSecret('site-a.com', VALID_SECRET, 'Site A'),
      addTotpSecret('site-b.com', ANOTHER_SECRET, 'Site B'),
    ]);

    const list = await listTotpDomains();
    expect(list).toHaveLength(2);
    const domains = list.map((e) => e.domain).sort();
    expect(domains).toEqual(['site-a.com', 'site-b.com']);
  });
});
