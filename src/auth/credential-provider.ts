/**
 * Credential provider interface and factory
 * Supports local, 1Password, and Bitwarden credential stores
 */

import { OnePasswordAdapter } from './adapters/onepassword-adapter';
import { BitwardenAdapter } from './adapters/bitwarden-adapter';
import { LocalAdapter } from './adapters/local-adapter';

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
    case 'onepassword':
      return new OnePasswordAdapter();
    case 'bitwarden':
      return new BitwardenAdapter();
    case 'local':
    default:
      return new LocalAdapter();
  }
}
