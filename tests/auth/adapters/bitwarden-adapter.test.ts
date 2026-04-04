/// <reference types="jest" />
/**
 * Unit tests for Bitwarden CLI credential adapter
 */

import { BitwardenAdapter } from '../../../src/auth/adapters/bitwarden-adapter';

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

const BW_VERSION_OUTPUT = '2024.1.0\n';

const BW_ITEM_JSON = JSON.stringify({
  id: 'xyz789',
  name: 'example.com',
  type: 1,
  login: {
    username: 'bob@example.com',
    password: 'p@ssw0rd',
    totp: 'JBSWY3DPEHPK3PXP',
    uris: [{ uri: 'https://example.com', match: null }],
  },
});

const BW_LIST_JSON = JSON.stringify([
  {
    id: 'item1',
    name: 'example.com',
    type: 1,
    login: {
      username: 'user1',
      uris: [{ uri: 'https://example.com/login' }],
    },
  },
  {
    id: 'item2',
    name: 'another.org',
    type: 1,
    login: {
      username: 'user2',
      uris: [{ uri: 'https://another.org' }, { uri: 'https://sub.another.org' }],
    },
  },
  {
    id: 'item3',
    name: 'No URI item',
    type: 1,
    login: {
      username: 'user3',
    },
  },
]);

describe('BitwardenAdapter', () => {
  const originalEnv = process.env;
  const SESSION_KEY = 'test-session-key-abc123';

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENCHROME_BITWARDEN_SESSION = SESSION_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isAvailable()', () => {
    test('returns true when bw --version succeeds', async () => {
      const exec = makeSuccessExec(BW_VERSION_OUTPUT);
      const adapter = new BitwardenAdapter(exec);
      const result = await adapter.isAvailable();
      expect(result).toBe(true);
      expect(exec).toHaveBeenCalledWith('bw', ['--version'], { timeout: 10000 });
    });

    test('returns false when bw binary is not found', async () => {
      const exec = makeFailureExec('command not found: bw');
      const adapter = new BitwardenAdapter(exec);
      const result = await adapter.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe('getCredentials()', () => {
    test('parses Bitwarden item JSON and returns credentials', async () => {
      const exec = makeSuccessExec(BW_ITEM_JSON);
      const adapter = new BitwardenAdapter(exec);
      const creds = await adapter.getCredentials('example.com');
      expect(creds).not.toBeNull();
      expect(creds!.username).toBe('bob@example.com');
      expect(creds!.password).toBe('p@ssw0rd');
      expect(creds!.totpSecret).toBe('JBSWY3DPEHPK3PXP');
    });

    test('returns null when item is not found', async () => {
      const exec = makeFailureExec('Not found.');
      const adapter = new BitwardenAdapter(exec);
      const creds = await adapter.getCredentials('missing.com');
      expect(creds).toBeNull();
    });

    test('returns null for "no items found" error', async () => {
      const exec = makeFailureExec('no items found');
      const adapter = new BitwardenAdapter(exec);
      const creds = await adapter.getCredentials('missing.com');
      expect(creds).toBeNull();
    });

    test('throws descriptive error when vault is locked', async () => {
      const exec = makeFailureExec('Vault is locked.');
      const adapter = new BitwardenAdapter(exec);
      await expect(adapter.getCredentials('example.com')).rejects.toThrow(
        /vault is locked|session expired/i
      );
    });

    test('throws descriptive error for expired/invalid session', async () => {
      const exec = makeFailureExec('Session key is invalid.');
      const adapter = new BitwardenAdapter(exec);
      await expect(adapter.getCredentials('example.com')).rejects.toThrow(
        /vault is locked|session expired/i
      );
    });

    test('throws when session env var is not set', async () => {
      delete process.env.OPENCHROME_BITWARDEN_SESSION;
      const exec = makeSuccessExec(BW_ITEM_JSON);
      const adapter = new BitwardenAdapter(exec);
      await expect(adapter.getCredentials('example.com')).rejects.toThrow(
        /session key not set|bw unlock/i
      );
    });

    test('passes --session flag from OPENCHROME_BITWARDEN_SESSION', async () => {
      const exec = makeSuccessExec(BW_ITEM_JSON);
      const adapter = new BitwardenAdapter(exec);
      await adapter.getCredentials('example.com');
      expect(exec).toHaveBeenCalledWith(
        'bw',
        ['get', 'item', 'example.com', '--session', SESSION_KEY],
        expect.objectContaining({ timeout: 10000 })
      );
    });

    test('returns undefined totpSecret when item has no totp', async () => {
      const itemWithoutTotp = JSON.stringify({
        id: 'xyz789',
        name: 'example.com',
        type: 1,
        login: { username: 'bob@example.com', password: 'p@ssw0rd' },
      });
      const exec = makeSuccessExec(itemWithoutTotp);
      const adapter = new BitwardenAdapter(exec);
      const creds = await adapter.getCredentials('example.com');
      expect(creds).not.toBeNull();
      expect(creds!.totpSecret).toBeUndefined();
    });
  });

  describe('listDomains()', () => {
    test('parses item list and extracts domains from URIs', async () => {
      const exec = makeSuccessExec(BW_LIST_JSON);
      const adapter = new BitwardenAdapter(exec);
      const domains = await adapter.listDomains();
      expect(domains).toContain('example.com');
      expect(domains).toContain('another.org');
      expect(domains).toContain('sub.another.org');
    });

    test('skips items without URIs', async () => {
      const exec = makeSuccessExec(BW_LIST_JSON);
      const adapter = new BitwardenAdapter(exec);
      const domains = await adapter.listDomains();
      // 'No URI item' has no uris — should not contribute
      expect(domains).not.toContain('No URI item');
    });

    test('deduplicates domains that appear in multiple items', async () => {
      const duplicateList = JSON.stringify([
        {
          id: 'a', name: 'a', type: 1,
          login: { uris: [{ uri: 'https://example.com/login' }] },
        },
        {
          id: 'b', name: 'b', type: 1,
          login: { uris: [{ uri: 'https://example.com/settings' }] },
        },
      ]);
      const exec = makeSuccessExec(duplicateList);
      const adapter = new BitwardenAdapter(exec);
      const domains = await adapter.listDomains();
      expect(domains).toEqual(['example.com']);
    });

    test('passes --session flag when listing items', async () => {
      const exec = makeSuccessExec(BW_LIST_JSON);
      const adapter = new BitwardenAdapter(exec);
      await adapter.listDomains();
      expect(exec).toHaveBeenCalledWith(
        'bw',
        ['list', 'items', '--session', SESSION_KEY],
        expect.objectContaining({ timeout: 10000 })
      );
    });

    test('throws when session env var is not set', async () => {
      delete process.env.OPENCHROME_BITWARDEN_SESSION;
      const exec = makeSuccessExec(BW_LIST_JSON);
      const adapter = new BitwardenAdapter(exec);
      await expect(adapter.listDomains()).rejects.toThrow(/session key not set|bw unlock/i);
    });
  });
});
