/**
 * Bitwarden CLI credential adapter
 * Uses the `bw` CLI binary to fetch credentials from Bitwarden vault
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CredentialProvider, Credentials } from '../credential-provider';

const CLI_TIMEOUT_MS = 10_000;

type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts: { timeout: number }
) => Promise<{ stdout: string; stderr: string }>;

interface BwLoginField {
  username?: string;
  password?: string;
  totp?: string;
  uris?: Array<{ uri: string; match?: number | null }>;
}

interface BwItem {
  id: string;
  name: string;
  type: number;
  login?: BwLoginField;
}

function extractDomainFromUri(uri: string): string {
  try {
    return new URL(uri).hostname;
  } catch {
    return uri;
  }
}

export class BitwardenAdapter implements CredentialProvider {
  readonly name = 'bitwarden';

  private readonly exec: ExecFileAsync;

  constructor(exec?: ExecFileAsync) {
    this.exec = exec ?? (promisify(execFile) as unknown as ExecFileAsync);
  }

  private getSession(): string {
    const session = process.env.OPENCHROME_BITWARDEN_SESSION;
    if (!session) {
      throw new Error(
        'Bitwarden session key not set. Run `bw unlock` and set OPENCHROME_BITWARDEN_SESSION.'
      );
    }
    return session;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.exec('bw', ['--version'], { timeout: CLI_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async getCredentials(domain: string): Promise<Credentials | null> {
    if (!/^[a-zA-Z0-9._-]+$/.test(domain)) {
      throw new Error(`Invalid domain format: "${domain}"`);
    }
    const session = this.getSession();

    let stdout: string;
    try {
      const result = await this.exec(
        'bw',
        ['get', 'item', domain, '--session', session],
        { timeout: CLI_TIMEOUT_MS }
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();

      if (lower.includes('not found') || lower.includes('no items found')) {
        return null;
      }
      if (
        lower.includes('vault is locked') ||
        lower.includes('session key is invalid') ||
        lower.includes('not logged in') ||
        lower.includes('you are not logged in')
      ) {
        throw new Error(
          'Bitwarden vault is locked or session expired. Run `bw unlock` and update OPENCHROME_BITWARDEN_SESSION.'
        );
      }
      throw new Error(`Bitwarden CLI error: ${message}`);
    }

    let item: BwItem;
    try {
      item = JSON.parse(stdout) as BwItem;
    } catch {
      throw new Error('Bitwarden returned invalid JSON');
    }

    const login = item.login ?? {};
    return {
      username: login.username ?? '',
      password: login.password ?? '',
      totpSecret: login.totp ?? undefined,
    };
  }

  async listDomains(): Promise<string[]> {
    const session = this.getSession();

    let stdout: string;
    try {
      const result = await this.exec(
        'bw',
        ['list', 'items', '--session', session],
        { timeout: CLI_TIMEOUT_MS }
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Bitwarden CLI error listing items: ${message}`);
    }

    let items: BwItem[];
    try {
      items = JSON.parse(stdout) as BwItem[];
    } catch {
      throw new Error('Bitwarden returned invalid JSON for item list');
    }

    const domains: string[] = [];
    for (const item of items) {
      const uris = item.login?.uris ?? [];
      for (const uriObj of uris) {
        if (uriObj.uri) {
          const domain = extractDomainFromUri(uriObj.uri);
          if (domain && !domains.includes(domain)) {
            domains.push(domain);
          }
        }
      }
    }
    return domains;
  }
}
