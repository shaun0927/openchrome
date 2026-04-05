/**
 * Unit tests for CLI TOTP management commands and totp-store core functions.
 *
 * File system operations are redirected to a temp directory by mocking the
 * `os` module so that `os.homedir()` returns a test-local temp directory.
 * No real ~/.openchrome/credentials/ files are touched.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Set up a real temp directory and redirect homedir BEFORE importing the
// module under test. We mock the entire `os` module so homedir() is writable.
// ---------------------------------------------------------------------------

const realTmpdir = os.tmpdir();
const tempDir = fs.mkdtempSync(path.join(realTmpdir, 'totp-cli-test-'));

// Mock os module so homedir() returns our temp directory
jest.mock('os', () => {
  const realOs = jest.requireActual<typeof os>('os');
  return {
    ...realOs,
    homedir: () => tempDir,
  };
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Remove the encrypted store between tests so each test starts clean
  const storePath = path.join(tempDir, '.openchrome', 'credentials', 'totp-secrets.enc');
  if (fs.existsSync(storePath)) {
    fs.unlinkSync(storePath);
  }
});

// ---------------------------------------------------------------------------
// Import AFTER mocking os
// ---------------------------------------------------------------------------

import {
  addTotpSecret,
  base32Decode,
  generateTOTP,
  getTotpSecret,
  listTotpDomains,
  removeTotpSecret,
  validateBase32,
} from '../../cli/totp-store';

// ---------------------------------------------------------------------------
// base32Decode
// ---------------------------------------------------------------------------

describe('base32Decode', () => {
  test('decodes a known base32 value', () => {
    // base32("f") = "MY======"
    const result = base32Decode('MY');
    expect(result).toEqual(Buffer.from([0x66])); // 0x66 = 'f'
  });

  test('handles lowercase input', () => {
    expect(base32Decode('my')).toEqual(base32Decode('MY'));
  });

  test('throws on invalid character', () => {
    expect(() => base32Decode('1NVALID!')).toThrow(/Invalid base32/);
  });
});

// ---------------------------------------------------------------------------
// validateBase32
// ---------------------------------------------------------------------------

describe('validateBase32', () => {
  test('accepts valid uppercase base32', () => {
    expect(validateBase32('JBSWY3DPEHPK3PXP')).toBe(true);
  });

  test('accepts valid lowercase base32', () => {
    expect(validateBase32('jbswy3dpehpk3pxp')).toBe(true);
  });

  test('rejects strings with invalid characters', () => {
    expect(validateBase32('NOT_VALID!')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(validateBase32('')).toBe(false);
  });

  test('rejects digit 1 (not in base32 alphabet)', () => {
    expect(validateBase32('1NVALID')).toBe(false);
  });

  test('accepts base32 with padding characters', () => {
    expect(validateBase32('MY======')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateTOTP
// ---------------------------------------------------------------------------

describe('generateTOTP', () => {
  test('returns a 6-digit string', () => {
    const code = generateTOTP('JBSWY3DPEHPK3PXP');
    expect(code).toMatch(/^\d{6}$/);
  });

  test('two consecutive calls in the same time window return the same code', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(generateTOTP(secret)).toBe(generateTOTP(secret));
  });

  test('produces consistent output for a known counter value (RFC 6238 test vector)', () => {
    // RFC 6238 test vector: secret ASCII "12345678901234567890"
    // Base32 of that byte sequence: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    // T=59s → counter = floor(59/30) = 1, expected TOTP = 287082 (SHA1)
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const realDateNow = Date.now;
    try {
      Date.now = () => 59 * 1000;
      const code = generateTOTP(secret);
      expect(code).toBe('287082');
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Storage: add / list / get / remove
// ---------------------------------------------------------------------------

describe('totp storage', () => {
  const DOMAIN = 'example.com';
  const SECRET = 'JBSWY3DPEHPK3PXP';
  const ISSUER = 'Example';

  test('totp add: stores an encrypted secret that can be retrieved', async () => {
    await addTotpSecret(DOMAIN, SECRET, ISSUER);
    const retrieved = await getTotpSecret(DOMAIN);
    expect(retrieved).toBe(SECRET.toUpperCase());
  });

  test('totp list: shows domain and issuer but NOT the raw secret', async () => {
    await addTotpSecret(DOMAIN, SECRET, ISSUER);
    const list = await listTotpDomains();

    expect(list).toHaveLength(1);
    expect(list[0].domain).toBe(DOMAIN);
    expect(list[0].issuer).toBe(ISSUER);
    expect(list[0].addedAt).toBeTruthy();

    // The list entry must not expose the secret in any form
    const serialised = JSON.stringify(list[0]);
    expect(serialised).not.toContain(SECRET);
  });

  test('totp list: returns empty array when no secrets are configured', async () => {
    const list = await listTotpDomains();
    expect(list).toHaveLength(0);
  });

  test('totp remove: deletes the specific domain entry and returns true', async () => {
    await addTotpSecret(DOMAIN, SECRET, ISSUER);
    const removed = await removeTotpSecret(DOMAIN);
    expect(removed).toBe(true);

    const list = await listTotpDomains();
    expect(list).toHaveLength(0);
  });

  test('totp remove: returns false for a non-existent domain', async () => {
    const removed = await removeTotpSecret('nonexistent.com');
    expect(removed).toBe(false);
  });

  test('getTotpSecret returns null for an unconfigured domain', async () => {
    const secret = await getTotpSecret('unconfigured.com');
    expect(secret).toBeNull();
  });

  test('totp add: overwrites the existing entry when called twice for the same domain', async () => {
    await addTotpSecret(DOMAIN, SECRET, 'Old Issuer');
    await addTotpSecret(DOMAIN, 'MFRA', 'New Issuer');

    const list = await listTotpDomains();
    expect(list).toHaveLength(1);
    expect(list[0].issuer).toBe('New Issuer');

    const retrieved = await getTotpSecret(DOMAIN);
    expect(retrieved).toBe('MFRA');
  });

  test('encryption round-trip: decrypt(encrypt(secret)) === secret', async () => {
    const domain = 'roundtrip.test';
    const secret = 'NBSWY3DPEB3W64TMMQ';
    await addTotpSecret(domain, secret);
    const result = await getTotpSecret(domain);
    expect(result).toBe(secret);
  });

  const isWindows = os.platform() === 'win32';
  (isWindows ? test.skip : test)('storage file is created with mode 0o600', async () => {
    await addTotpSecret(DOMAIN, SECRET);
    const storePath = path.join(tempDir, '.openchrome', 'credentials', 'totp-secrets.enc');
    const stat = fs.statSync(storePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('storage file is binary (not hex text)', async () => {
    await addTotpSecret(DOMAIN, SECRET);
    const storePath = path.join(tempDir, '.openchrome', 'credentials', 'totp-secrets.enc');
    const data = fs.readFileSync(storePath);
    // Binary buffer: length should be 16(salt) + 16(iv) + 16(tag) + ciphertext
    // Minimum length is 48 bytes (header alone), actual ciphertext adds more
    expect(data.length).toBeGreaterThan(48);
    // Must NOT be valid UTF-8 hex string (i.e., not all hex chars)
    const asHex = data.toString('hex');
    expect(asHex.length).toBe(data.length * 2); // hex is double length of binary
    // The raw buffer should NOT equal its own hex re-encoding as string bytes
    expect(data.toString('utf8')).not.toMatch(/^[0-9a-f]+$/i);
  });

  test('decryption failure throws with clear message', async () => {
    const storePath = path.join(tempDir, '.openchrome', 'credentials', 'totp-secrets.enc');
    const dir = path.dirname(storePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Write a file that is large enough to pass the length check but has garbage data
    fs.writeFileSync(storePath, crypto.randomBytes(64), { mode: 0o600 });
    await expect(getTotpSecret(DOMAIN)).rejects.toThrow('Failed to decrypt credential store');
  });

  test('corrupted JSON throws with clear message', async () => {
    const storePath = path.join(tempDir, '.openchrome', 'credentials', 'totp-secrets.enc');
    const dir = path.dirname(storePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Encrypt invalid JSON and write it directly
    const { createCipheriv, randomBytes, scryptSync } = crypto;
    const salt = randomBytes(16);
    const iv = randomBytes(16);
    const machineId = os.hostname() + os.userInfo().username;
    const key = scryptSync('openchrome-totp-v1' + machineId, salt, 32) as Buffer;
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update('not valid json', 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const fileData = Buffer.concat([salt, iv, authTag, encrypted]);
    fs.writeFileSync(storePath, fileData, { mode: 0o600 });

    await expect(getTotpSecret(DOMAIN)).rejects.toThrow('Credential store corrupted');
  });
});

// ---------------------------------------------------------------------------
// Integration: totp generate uses the stored secret
// ---------------------------------------------------------------------------

describe('totp generate (integration)', () => {
  test('generate: outputs a valid 6-digit code for a configured domain', async () => {
    const domain = 'generate.test';
    const secret = 'JBSWY3DPEHPK3PXP';
    await addTotpSecret(domain, secret);

    const stored = await getTotpSecret(domain);
    expect(stored).toBeTruthy();

    const code = generateTOTP(stored!);
    expect(code).toMatch(/^\d{6}$/);
  });

  test('generate: returns null secret for an unconfigured domain', async () => {
    const secret = await getTotpSecret('not-configured.com');
    expect(secret).toBeNull();
  });
});
