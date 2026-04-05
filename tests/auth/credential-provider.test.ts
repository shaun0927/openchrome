/// <reference types="jest" />
/**
 * Unit tests for credential provider factory
 */

describe('getCredentialProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns LocalAdapter by default when env var not set', () => {
    delete process.env.OPENCHROME_CREDENTIAL_PROVIDER;
    const { getCredentialProvider } = require('../../src/auth/credential-provider');
    const provider = getCredentialProvider();
    expect(provider.name).toBe('local');
  });

  test('returns LocalAdapter when env var is "local"', () => {
    process.env.OPENCHROME_CREDENTIAL_PROVIDER = 'local';
    const { getCredentialProvider } = require('../../src/auth/credential-provider');
    const provider = getCredentialProvider();
    expect(provider.name).toBe('local');
  });

  test('returns OnePasswordAdapter when env var is "1password"', () => {
    process.env.OPENCHROME_CREDENTIAL_PROVIDER = '1password';
    const { getCredentialProvider } = require('../../src/auth/credential-provider');
    const provider = getCredentialProvider();
    expect(provider.name).toBe('1password');
  });

  test('returns OnePasswordAdapter when env var is "onepassword" (alias)', () => {
    process.env.OPENCHROME_CREDENTIAL_PROVIDER = 'onepassword';
    const { getCredentialProvider } = require('../../src/auth/credential-provider');
    const provider = getCredentialProvider();
    expect(provider.name).toBe('1password');
  });

  test('returns BitwardenAdapter when env var is "bitwarden"', () => {
    process.env.OPENCHROME_CREDENTIAL_PROVIDER = 'bitwarden';
    const { getCredentialProvider } = require('../../src/auth/credential-provider');
    const provider = getCredentialProvider();
    expect(provider.name).toBe('bitwarden');
  });

  test('is case-insensitive for provider name', () => {
    process.env.OPENCHROME_CREDENTIAL_PROVIDER = 'BITWARDEN';
    const { getCredentialProvider } = require('../../src/auth/credential-provider');
    const provider = getCredentialProvider();
    expect(provider.name).toBe('bitwarden');
  });

  test('falls back to local for unknown provider values', () => {
    process.env.OPENCHROME_CREDENTIAL_PROVIDER = 'unknown-vault';
    const { getCredentialProvider } = require('../../src/auth/credential-provider');
    const provider = getCredentialProvider();
    expect(provider.name).toBe('local');
  });
});
