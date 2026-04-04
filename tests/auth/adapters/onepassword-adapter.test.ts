/// <reference types="jest" />
/**
 * Unit tests for 1Password CLI credential adapter
 */

import { OnePasswordAdapter } from '../../../src/auth/adapters/onepassword-adapter';

type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts: { timeout: number }
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Helper: create a mock exec that resolves with the given stdout
 */
function makeSuccessExec(stdout: string): jest.MockedFunction<ExecFileAsync> {
  return jest.fn().mockResolvedValue({ stdout, stderr: '' });
}

/**
 * Helper: create a mock exec that rejects with the given error message
 */
function makeFailureExec(message: string): jest.MockedFunction<ExecFileAsync> {
  return jest.fn().mockRejectedValue(new Error(message));
}

const OP_VERSION_OUTPUT = '2.24.0\n';

const OP_ITEM_JSON = JSON.stringify({
  id: 'abc123',
  title: 'example.com',
  fields: [
    { id: 'username', purpose: 'USERNAME', value: 'alice@example.com' },
    { id: 'password', purpose: 'PASSWORD', value: 's3cr3t!' },
    { id: 'totp', type: 'OTP', value: 'JBSWY3DPEHPK3PXP' },
  ],
  urls: [{ href: 'https://example.com', primary: true }],
});

const OP_LIST_JSON = JSON.stringify([
  {
    id: 'item1',
    title: 'example.com',
    urls: [{ href: 'https://example.com' }],
  },
  {
    id: 'item2',
    title: 'another.org',
    urls: [{ href: 'https://another.org/login' }],
  },
  {
    id: 'item3',
    title: 'No URL item',
  },
]);

describe('OnePasswordAdapter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENCHROME_1PASSWORD_VAULT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isAvailable()', () => {
    test('returns true when op --version succeeds', async () => {
      const exec = makeSuccessExec(OP_VERSION_OUTPUT);
      const adapter = new OnePasswordAdapter(exec);
      const result = await adapter.isAvailable();
      expect(result).toBe(true);
      expect(exec).toHaveBeenCalledWith('op', ['--version'], { timeout: 10000 });
    });

    test('returns false when op binary is not found', async () => {
      const exec = makeFailureExec('command not found: op');
      const adapter = new OnePasswordAdapter(exec);
      const result = await adapter.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe('getCredentials()', () => {
    test('parses 1Password item JSON and returns credentials', async () => {
      const exec = makeSuccessExec(OP_ITEM_JSON);
      const adapter = new OnePasswordAdapter(exec);
      const creds = await adapter.getCredentials('example.com');
      expect(creds).not.toBeNull();
      expect(creds!.username).toBe('alice@example.com');
      expect(creds!.password).toBe('s3cr3t!');
      expect(creds!.totpSecret).toBe('JBSWY3DPEHPK3PXP');
    });

    test('returns null when item is not found', async () => {
      const exec = makeFailureExec("example.com isn't an item in any vault");
      const adapter = new OnePasswordAdapter(exec);
      const creds = await adapter.getCredentials('example.com');
      expect(creds).toBeNull();
    });

    test('returns null for "not found" error message', async () => {
      const exec = makeFailureExec('[ERROR] 2024/01/01 not found');
      const adapter = new OnePasswordAdapter(exec);
      const creds = await adapter.getCredentials('missing.com');
      expect(creds).toBeNull();
    });

    test('throws descriptive error when vault is locked', async () => {
      const exec = makeFailureExec('You are not signed in. Please sign in and try again.');
      const adapter = new OnePasswordAdapter(exec);
      await expect(adapter.getCredentials('example.com')).rejects.toThrow(
        /vault is locked|not signed in/i
      );
    });

    test('throws descriptive error for authentication required', async () => {
      const exec = makeFailureExec('authentication required');
      const adapter = new OnePasswordAdapter(exec);
      await expect(adapter.getCredentials('example.com')).rejects.toThrow(
        /vault is locked|not signed in/i
      );
    });

    test('passes --vault flag when OPENCHROME_1PASSWORD_VAULT is set', async () => {
      process.env.OPENCHROME_1PASSWORD_VAULT = 'Personal';
      const exec = makeSuccessExec(OP_ITEM_JSON);
      const adapter = new OnePasswordAdapter(exec);
      await adapter.getCredentials('example.com');
      expect(exec).toHaveBeenCalledWith(
        'op',
        ['item', 'get', 'example.com', '--format', 'json', '--vault', 'Personal'],
        expect.objectContaining({ timeout: 10000 })
      );
    });

    test('does not pass --vault flag when env var is not set', async () => {
      const exec = makeSuccessExec(OP_ITEM_JSON);
      const adapter = new OnePasswordAdapter(exec);
      await adapter.getCredentials('example.com');
      const callArgs = exec.mock.calls[0][1] as string[];
      expect(callArgs).not.toContain('--vault');
    });
  });

  describe('listDomains()', () => {
    test('parses item list and extracts domains from URLs', async () => {
      const exec = makeSuccessExec(OP_LIST_JSON);
      const adapter = new OnePasswordAdapter(exec);
      const domains = await adapter.listDomains();
      expect(domains).toContain('example.com');
      expect(domains).toContain('another.org');
    });

    test('skips items without URLs', async () => {
      const exec = makeSuccessExec(OP_LIST_JSON);
      const adapter = new OnePasswordAdapter(exec);
      const domains = await adapter.listDomains();
      // 'No URL item' has no urls — only 2 unique domains expected
      expect(domains).toHaveLength(2);
    });

    test('deduplicates domains that appear in multiple items', async () => {
      const duplicateList = JSON.stringify([
        { id: 'a', title: 'a', urls: [{ href: 'https://example.com/login' }] },
        { id: 'b', title: 'b', urls: [{ href: 'https://example.com/settings' }] },
      ]);
      const exec = makeSuccessExec(duplicateList);
      const adapter = new OnePasswordAdapter(exec);
      const domains = await adapter.listDomains();
      expect(domains).toEqual(['example.com']);
    });

    test('passes --vault flag when OPENCHROME_1PASSWORD_VAULT is set', async () => {
      process.env.OPENCHROME_1PASSWORD_VAULT = 'Work';
      const exec = makeSuccessExec(OP_LIST_JSON);
      const adapter = new OnePasswordAdapter(exec);
      await adapter.listDomains();
      expect(exec).toHaveBeenCalledWith(
        'op',
        ['item', 'list', '--categories', 'Login', '--format', 'json', '--vault', 'Work'],
        expect.objectContaining({ timeout: 10000 })
      );
    });
  });
});
