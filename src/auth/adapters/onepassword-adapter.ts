/**
 * 1Password CLI credential adapter
 * Uses the `op` CLI binary to fetch credentials from 1Password vaults
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

interface OpField {
  id?: string;
  label?: string;
  purpose?: string;
  type?: string;
  value?: string;
}

interface OpItem {
  id: string;
  title: string;
  fields?: OpField[];
  urls?: Array<{ href: string; primary?: boolean }>;
}

interface OpListItem {
  id: string;
  title: string;
  urls?: Array<{ href: string }>;
}

function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export class OnePasswordAdapter implements CredentialProvider {
  readonly name = '1password';

  private readonly exec: ExecFileAsync;

  constructor(exec?: ExecFileAsync) {
    this.exec = exec ?? (promisify(execFile) as unknown as ExecFileAsync);
  }

  private get vaultArgs(): string[] {
    const vault = process.env.OPENCHROME_1PASSWORD_VAULT;
    return vault ? ['--vault', vault] : [];
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.exec('op', ['--version'], { timeout: CLI_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async getCredentials(domain: string): Promise<Credentials | null> {
    let stdout: string;
    try {
      const result = await this.exec(
        'op',
        ['item', 'get', domain, '--format', 'json', ...this.vaultArgs],
        { timeout: CLI_TIMEOUT_MS }
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();

      if (lower.includes('not found') || lower.includes("isn't an item")) {
        return null;
      }
      if (
        lower.includes('not signed in') ||
        lower.includes('vault is locked') ||
        lower.includes('authentication required') ||
        lower.includes('please sign in')
      ) {
        throw new Error(
          '1Password vault is locked or not signed in. Run `op signin` to authenticate.'
        );
      }
      throw new Error(`1Password CLI error: ${message}`);
    }

    let item: OpItem;
    try {
      item = JSON.parse(stdout) as OpItem;
    } catch {
      throw new Error('1Password returned invalid JSON');
    }

    const fields = item.fields ?? [];

    const usernameField = fields.find(
      (f) => f.purpose === 'USERNAME' || f.id === 'username'
    );
    const passwordField = fields.find(
      (f) => f.purpose === 'PASSWORD' || f.id === 'password'
    );
    const otpField = fields.find((f) => f.type === 'OTP');

    return {
      username: usernameField?.value ?? '',
      password: passwordField?.value ?? '',
      totpSecret: otpField?.value,
    };
  }

  async listDomains(): Promise<string[]> {
    let stdout: string;
    try {
      const result = await this.exec(
        'op',
        ['item', 'list', '--categories', 'Login', '--format', 'json', ...this.vaultArgs],
        { timeout: CLI_TIMEOUT_MS }
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`1Password CLI error listing items: ${message}`);
    }

    let items: OpListItem[];
    try {
      items = JSON.parse(stdout) as OpListItem[];
    } catch {
      throw new Error('1Password returned invalid JSON for item list');
    }

    const domains: string[] = [];
    for (const item of items) {
      if (item.urls && item.urls.length > 0) {
        for (const urlObj of item.urls) {
          const domain = extractDomainFromUrl(urlObj.href);
          if (domain && !domains.includes(domain)) {
            domains.push(domain);
          }
        }
      }
    }
    return domains;
  }
}
