/**
 * Credential provider interface and factory
 * Supports local, 1Password, and Bitwarden credential stores
 */

export interface Credentials {
  username: string;
  password: string;
  totpSecret?: string;
}

export interface CredentialProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  getCredentials(domain: string): Promise<Credentials | null>;
  listDomains(): Promise<string[]>;
}

/**
 * Factory function that reads OPENCHROME_CREDENTIAL_PROVIDER env var
 * and returns the appropriate credential provider adapter.
 *
 * Supported values: 'local' (default), '1password', 'bitwarden'
 */
export function getCredentialProvider(): CredentialProvider {
  const providerName = process.env.OPENCHROME_CREDENTIAL_PROVIDER ?? 'local';

  switch (providerName.toLowerCase()) {
    case '1password':
    case 'onepassword': {
      const { OnePasswordAdapter } = require('./adapters/onepassword-adapter');
      return new OnePasswordAdapter();
    }
    case 'bitwarden': {
      const { BitwardenAdapter } = require('./adapters/bitwarden-adapter');
      return new BitwardenAdapter();
    }
    case 'local':
    default: {
      const { LocalAdapter } = require('./adapters/local-adapter');
      return new LocalAdapter();
    }
  }
}
