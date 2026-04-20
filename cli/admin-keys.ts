/**
 * Admin CLI for tenant API key management (issue #9 / PR3).
 *
 * Subcommands under `openchrome admin keys`:
 *   - create  — issue a new key and print the plaintext ONCE to stdout
 *   - list    — table (default) or JSON of ApiKey metadata (never plaintext)
 *   - revoke  — mark a key revoked
 *   - rotate  — revoke and reissue (same tenant + scopes)
 *
 * Admin auth: the env var OPENCHROME_ADMIN_TOKEN must be set and non-empty.
 * The token is a CLI-local gate only — it is NEVER written to disk or
 * injected into the API key store. If unset we abort with exit code 1.
 *
 * Output contract:
 *   - stdout: plaintext key (create/rotate) or JSON (list --json) only
 *   - stderr: diagnostics, tables, warnings, errors
 *
 * Designed so `openchrome admin keys create ... --json | jq` (future-proof)
 * and `openchrome admin keys list --json | jq` work cleanly with pipes.
 */

import { Command } from 'commander';

// Types mirrored from src/auth/api-key-types.ts so the CLI tsconfig (rootDir=./cli)
// can compile without depending on the src tree directly. Runtime resolves the
// real ApiKeyStore via require() against dist/auth/api-key-store.js.
type Scope = 'read' | 'write' | 'admin' | 'headless-only';

interface ApiKey {
  keyId: string;
  keyHash: string;
  tenantId: string;
  scopes: Scope[];
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  description: string;
}

interface ApiKeyCreateResult {
  record: ApiKey;
  plaintext: string;
}

interface ApiKeyStoreInstance {
  create(input: { tenantId: string; scopes: Scope[]; description: string; expiresAt?: number }): Promise<ApiKeyCreateResult>;
  list(): Promise<ApiKey[]>;
  revoke(keyId: string): Promise<boolean>;
  rotate(keyId: string): Promise<ApiKeyCreateResult>;
}

interface ApiKeyStoreCtor {
  open(storePath?: string): Promise<ApiKeyStoreInstance>;
}

const VALID_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'read',
  'write',
  'admin',
  'headless-only',
]);

function requireAdminToken(): void {
  const token = process.env.OPENCHROME_ADMIN_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    console.error('Error: OPENCHROME_ADMIN_TOKEN environment variable must be set.');
    console.error('       Export a non-empty admin token before running admin commands.');
    process.exit(1);
  }
}

// Exported so tests can inject a local store. Default resolution walks the
// candidate locations: when running from dist/cli (the shipped bin) the store
// lives at ../auth/api-key-store; when running from ts-jest against the src
// tree it lives at ../src/auth/api-key-store relative to this file's dirname.
export function defaultLoadStore(): ApiKeyStoreCtor {
  const candidates = ['../auth/api-key-store', '../src/auth/api-key-store'];
  let lastErr: unknown;
  for (const spec of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(spec) as { ApiKeyStore: ApiKeyStoreCtor };
      if (mod && mod.ApiKeyStore) return mod.ApiKeyStore;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Unable to load ApiKeyStore from any candidate path: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

let loadStore: () => ApiKeyStoreCtor = defaultLoadStore;

/** Test hook: override the ApiKeyStore loader. */
export function _setStoreLoader(loader: () => ApiKeyStoreCtor): void {
  loadStore = loader;
}

function coerceScopes(values: string[] | undefined): Scope[] {
  if (!values || values.length === 0) {
    console.error('Error: at least one --scope is required (read|write|admin|headless-only).');
    process.exit(1);
  }
  const out: Scope[] = [];
  for (const v of values) {
    if (!VALID_SCOPES.has(v as Scope)) {
      console.error(`Error: invalid scope "${v}". Allowed: read, write, admin, headless-only.`);
      process.exit(1);
    }
    if (!out.includes(v as Scope)) out.push(v as Scope);
  }
  return out;
}

function formatTimestamp(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '-';
  try {
    return new Date(ts).toISOString();
  } catch {
    return '-';
  }
}

function printTable(rows: ApiKey[]): void {
  const headers = ['keyId', 'tenantId', 'scopes', 'createdAt', 'expiresAt', 'revokedAt', 'lastUsedAt'] as const;
  const data: string[][] = rows.map((r) => [
    r.keyId,
    r.tenantId,
    r.scopes.join(','),
    formatTimestamp(r.createdAt),
    formatTimestamp(r.expiresAt),
    formatTimestamp(r.revokedAt),
    formatTimestamp(r.lastUsedAt),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const sepLine = widths.map((w) => '-'.repeat(w)).join('  ');
  console.error(headerLine);
  console.error(sepLine);
  for (const row of data) {
    console.error(row.map((cell, i) => cell.padEnd(widths[i])).join('  '));
  }
}

export function registerAdminKeysCommand(program: Command): void {
  const admin = program
    .command('admin')
    .description('Admin commands (requires OPENCHROME_ADMIN_TOKEN env var)');

  const keys = admin.command('keys').description('Manage tenant API keys');

  keys
    .command('create')
    .description('Create a new API key for a tenant')
    .requiredOption('--tenant <id>', 'Tenant identifier (e.g. acme)')
    .option(
      '--scope <scope>',
      'Scope (read|write|admin|headless-only). Repeat for multiple.',
      (value: string, previous: string[] | undefined) => {
        const arr = previous ?? [];
        arr.push(value);
        return arr;
      },
      [] as string[],
    )
    .option('--description <text>', 'Human-readable description', '')
    .option('--expires-in <days>', 'Expiry in days from now (integer > 0)')
    .action(async (options: {
      tenant: string;
      scope: string[];
      description: string;
      expiresIn?: string;
    }) => {
      requireAdminToken();
      const scopes = coerceScopes(options.scope);
      let expiresAt: number | undefined;
      if (options.expiresIn !== undefined) {
        const days = Number.parseInt(options.expiresIn, 10);
        if (!Number.isFinite(days) || days <= 0) {
          console.error('Error: --expires-in must be a positive integer number of days.');
          process.exit(1);
        }
        expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
      }
      try {
        const Store = loadStore();
        const store = await Store.open();
        const result = await store.create({
          tenantId: options.tenant,
          scopes,
          description: options.description,
          expiresAt,
        });
        console.error('SAVE THIS KEY NOW. It will never be shown again.');
        // Plaintext goes to stdout on its own line so pipes work cleanly.
        process.stdout.write(result.plaintext + '\n');
        console.error(`keyId: ${result.record.keyId}`);
        console.error(`tenant: ${result.record.tenantId}`);
        console.error(`scopes: ${result.record.scopes.join(',')}`);
        if (result.record.expiresAt) {
          console.error(`expires: ${formatTimestamp(result.record.expiresAt)}`);
        }
      } catch (err) {
        console.error(`Error creating key: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  keys
    .command('list')
    .description('List API keys (never shows plaintext)')
    .option('--tenant <id>', 'Filter by tenant')
    .option('--json', 'Emit JSON array to stdout instead of a table')
    .action(async (options: { tenant?: string; json?: boolean }) => {
      requireAdminToken();
      try {
        const Store = loadStore();
        const store = await Store.open();
        let records = await store.list();
        if (options.tenant) {
          records = records.filter((r) => r.tenantId === options.tenant);
        }
        if (options.json) {
          process.stdout.write(JSON.stringify(records) + '\n');
          return;
        }
        if (records.length === 0) {
          console.error('No API keys found.');
          return;
        }
        printTable(records);
      } catch (err) {
        console.error(`Error listing keys: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  keys
    .command('revoke <keyId>')
    .description('Revoke an API key by keyId')
    .action(async (keyId: string) => {
      requireAdminToken();
      try {
        const Store = loadStore();
        const store = await Store.open();
        const ok = await store.revoke(keyId);
        if (!ok) {
          console.error(`Error: unknown keyId "${keyId}".`);
          process.exit(1);
        }
        console.error(`Revoked ${keyId}.`);
      } catch (err) {
        console.error(`Error revoking key: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  keys
    .command('rotate <keyId>')
    .description('Revoke an existing key and issue a new one for the same tenant + scopes')
    .action(async (keyId: string) => {
      requireAdminToken();
      try {
        const Store = loadStore();
        const store = await Store.open();
        const result = await store.rotate(keyId);
        console.error('SAVE THIS KEY NOW. It will never be shown again.');
        process.stdout.write(result.plaintext + '\n');
        console.error(`oldKeyId: ${keyId}`);
        console.error(`newKeyId: ${result.record.keyId}`);
        console.error(`tenant: ${result.record.tenantId}`);
        console.error(`scopes: ${result.record.scopes.join(',')}`);
      } catch (err) {
        console.error(`Error rotating key: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
