import {
  coerceCredentials,
  KeychainVaultAdapter,
  KmsVaultAdapter,
  parseCredentialBlob,
  type CiphertextLoader,
  type DecryptFn,
  type KeychainLike,
} from '../../src/auth/adapters/vault-adapter';

describe('vault credential adapters (P17)', () => {
  describe('parseCredentialBlob / coerceCredentials', () => {
    test('valid blob returns credentials', () => {
      expect(parseCredentialBlob('{"username":"u","password":"p"}')).toEqual({ username: 'u', password: 'p' });
    });
    test('includes optional totpSecret', () => {
      expect(parseCredentialBlob('{"username":"u","password":"p","totpSecret":"JBSWY3DPEHPK3PXP"}')).toEqual({
        username: 'u',
        password: 'p',
        totpSecret: 'JBSWY3DPEHPK3PXP',
      });
    });
    test('missing username → null', () => {
      expect(parseCredentialBlob('{"password":"p"}')).toBeNull();
    });
    test('malformed JSON → null', () => {
      expect(parseCredentialBlob('not-json')).toBeNull();
    });
    test('coerceCredentials rejects non-object', () => {
      expect(coerceCredentials(null)).toBeNull();
      expect(coerceCredentials(42)).toBeNull();
      expect(coerceCredentials([])).toEqual(null);
    });
  });

  describe('KeychainVaultAdapter', () => {
    function makeKeychain(entries: Record<string, string>, indexDomains?: string[]): KeychainLike {
      return {
        async getPassword(service, account) {
          if (service === 'openchrome' && account === '__index__') {
            return indexDomains ? JSON.stringify(indexDomains) : null;
          }
          return entries[`${service}|${account}`] ?? null;
        },
        async findCredentials(service) {
          return Object.keys(entries)
            .filter((k) => k.startsWith(`${service}|`) || k.startsWith(`${service}:`))
            .map((k) => {
              const [, account] = k.split('|');
              return { account, password: entries[k] };
            });
        },
      };
    }

    test('constructor rejects missing keychain', () => {
      expect(() => new KeychainVaultAdapter({} as any)).toThrow(TypeError);
    });

    test('getCredentials returns parsed blob', async () => {
      const kc = makeKeychain({
        'openchrome:example.com|credentials': '{"username":"alice","password":"pw"}',
      });
      const v = new KeychainVaultAdapter({ keychain: kc });
      const c = await v.getCredentials('example.com');
      expect(c).toEqual({ username: 'alice', password: 'pw' });
    });

    test('getCredentials returns null when missing', async () => {
      const kc = makeKeychain({});
      const v = new KeychainVaultAdapter({ keychain: kc });
      expect(await v.getCredentials('missing.com')).toBeNull();
    });

    test('listDomains reads __index__ entry', async () => {
      const kc = makeKeychain({}, ['a.com', 'b.com']);
      const v = new KeychainVaultAdapter({ keychain: kc });
      expect(await v.listDomains()).toEqual(['a.com', 'b.com']);
    });

    test('listDomains without index returns []', async () => {
      const kc = makeKeychain({});
      const v = new KeychainVaultAdapter({ keychain: kc });
      expect(await v.listDomains()).toEqual([]);
    });

    test('isAvailable false when keychain throws', async () => {
      const kc: KeychainLike = {
        async getPassword() { return null; },
        async findCredentials() { throw new Error('locked'); },
      };
      const v = new KeychainVaultAdapter({ keychain: kc });
      expect(await v.isAvailable()).toBe(false);
    });

    test('custom servicePrefix + account', async () => {
      const kc = makeKeychain({
        'myapp:x.com|prod': '{"username":"u","password":"p"}',
      });
      const v = new KeychainVaultAdapter({ keychain: kc, servicePrefix: 'myapp', account: 'prod' });
      expect(await v.getCredentials('x.com')).toEqual({ username: 'u', password: 'p' });
    });
  });

  describe('KmsVaultAdapter', () => {
    const blob = JSON.stringify({
      'a.com': { username: 'ua', password: 'pa' },
      'b.com': { username: 'ub', password: 'pb', totpSecret: 'ABCDEF' },
    });

    const load: CiphertextLoader = async () => Buffer.from(blob);
    const decrypt: DecryptFn = async (buf) => buf.toString('utf8');

    test('constructor validates load and decrypt', () => {
      expect(() => new KmsVaultAdapter({} as any)).toThrow(TypeError);
      expect(() => new KmsVaultAdapter({ load } as any)).toThrow(TypeError);
    });

    test('getCredentials looks up by domain', async () => {
      const v = new KmsVaultAdapter({ load, decrypt });
      expect(await v.getCredentials('a.com')).toEqual({ username: 'ua', password: 'pa' });
      expect(await v.getCredentials('b.com')).toEqual({ username: 'ub', password: 'pb', totpSecret: 'ABCDEF' });
      expect(await v.getCredentials('nope.com')).toBeNull();
    });

    test('listDomains returns sorted keys', async () => {
      const v = new KmsVaultAdapter({ load, decrypt });
      expect(await v.listDomains()).toEqual(['a.com', 'b.com']);
    });

    test('cache: second call does not invoke load again', async () => {
      const loadFn = jest.fn(load);
      const v = new KmsVaultAdapter({ load: loadFn, decrypt });
      await v.getCredentials('a.com');
      await v.getCredentials('b.com');
      expect(loadFn).toHaveBeenCalledTimes(1);
    });

    test('cache: false reloads every call', async () => {
      const loadFn = jest.fn(load);
      const v = new KmsVaultAdapter({ load: loadFn, decrypt, cache: false });
      await v.getCredentials('a.com');
      await v.getCredentials('b.com');
      expect(loadFn).toHaveBeenCalledTimes(2);
    });

    test('rejects non-object blob', async () => {
      const badLoad: CiphertextLoader = async () => Buffer.from('[]');
      const v = new KmsVaultAdapter({ load: badLoad, decrypt });
      await expect(v.getCredentials('x')).rejects.toThrow(/JSON object/);
    });

    test('isAvailable false when decrypt throws', async () => {
      const failDecrypt: DecryptFn = async () => { throw new Error('no key'); };
      const v = new KmsVaultAdapter({ load, decrypt: failDecrypt });
      expect(await v.isAvailable()).toBe(false);
    });

    test('accepts string plaintext from decrypt', async () => {
      const decryptStr: DecryptFn = async (buf) => buf.toString('utf8');
      const v = new KmsVaultAdapter({ load, decrypt: decryptStr });
      expect(await v.getCredentials('a.com')).toEqual({ username: 'ua', password: 'pa' });
    });
  });
});
