/**
 * Local storage credential adapter
 * Wraps the credential store from PR 1 (credential-store module)
 */

import type { CredentialProvider, Credentials } from '../credential-provider';

// Stub interface — will use real credential-store when PR 1 lands
interface CredentialStoreStub {
  getTotpSecret(domain: string): Promise<string | null>;
  listTotpDomains(): Promise<Array<{ domain: string; issuer?: string; addedAt: string }>>;
}

export class LocalAdapter implements CredentialProvider {
  readonly name = 'local';

  private store: CredentialStoreStub;

  constructor(store?: CredentialStoreStub) {
    if (store) {
      this.store = store;
    } else {
      // Dynamic import to avoid hard dependency until PR 1 lands
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const credentialStore = require('../credential-store');
        this.store = {
          getTotpSecret: credentialStore.getTotpSecret,
          listTotpDomains: credentialStore.listTotpDomains,
        };
      } catch {
        // credential-store not yet available — use no-op stub
        this.store = {
          getTotpSecret: async (_domain: string) => null,
          listTotpDomains: async () => [],
        };
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Returns credentials from local store.
   * Local store only holds TOTP secrets — username/password are not stored locally.
   */
  async getCredentials(domain: string): Promise<Credentials | null> {
    const totpSecret = await this.store.getTotpSecret(domain);
    if (totpSecret === null) {
      return null;
    }
    // Local store does not hold username/password; provide empty strings as placeholders
    return {
      username: '',
      password: '',
      totpSecret,
    };
  }

  async listDomains(): Promise<string[]> {
    const entries = await this.store.listTotpDomains();
    return entries.map((e) => e.domain);
  }
}
