/// <reference types="jest" />
/**
 * Tests for the admin-keys CLI (issue #9 / PR3).
 *
 * Approach: load cli/admin-keys.ts and drive it via a local commander
 * Command instance. The ApiKeyStore is backed by a tmpdir file via the
 * OPENCHROME_API_KEY_STORE_PATH env override. stdout/stderr are captured
 * in-process so assertions can prove plaintext only appears on stdout once
 * and never leaks into stderr/list output.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';

import { registerAdminKeysCommand } from '../../cli/admin-keys';

// ─── Test harness ────────────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Extract an `oc_live_*` plaintext token from captured stdout, ignoring any
 * surrounding noise. The in-process harness shares its `process.stdout.write`
 * hook with Jest's own console-capture rendering, so a leaked timer firing a
 * console.error from a prior test in the same worker can prepend a decorated
 * block ahead of the CLI's own single-line token emission. The CLI only ever
 * emits exactly one token, so a regex match is both sufficient and robust.
 */
function extractToken(stdout: string): string {
  const m = stdout.match(/oc_live_[A-Za-z0-9_]+/);
  if (!m) throw new Error(`No oc_live_* token found in stdout: ${JSON.stringify(stdout)}`);
  return m[0];
}

function extractJsonArray(stdout: string): string {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON array found in stdout: ${JSON.stringify(stdout)}`);
  }
  return stdout.slice(start, end + 1);
}

async function runCli(argv: string[]): Promise<RunResult> {
  const program = new Command();
  program.exitOverride((err) => {
    // Re-throw so exitCode bubbles up; commander signals non-zero on usage errs.
    throw err;
  });
  registerAdminKeysCommand(program);

  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLogErr = console.error;
  const origExit = process.exit;
  let exitCode: number | null = null;

  (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  console.error = (...args: unknown[]) => {
    stderr += args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
  };

  class ExitCalled extends Error {
    constructor(public readonly code: number) {
      super(`process.exit(${code})`);
    }
  }
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitCalled(exitCode);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  try {
    await program.parseAsync(['node', 'openchrome', ...argv]);
  } catch (err) {
    if (err instanceof ExitCalled) {
      // expected path for early exits
    } else if (err && typeof err === 'object' && 'exitCode' in (err as Record<string, unknown>)) {
      const rec = err as { exitCode?: number };
      exitCode = rec.exitCode ?? 1;
    } else {
      throw err;
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.error = origLogErr;
    process.exit = origExit;
  }

  return { stdout, stderr, exitCode };
}

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-admin-keys-'));
  storePath = path.join(tmpDir, 'api-keys.jsonl');
  process.env.OPENCHROME_API_KEY_STORE_PATH = storePath;
  process.env.OPENCHROME_ADMIN_TOKEN = 'test-admin-token';
});

afterEach(() => {
  delete process.env.OPENCHROME_API_KEY_STORE_PATH;
  delete process.env.OPENCHROME_ADMIN_TOKEN;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('admin keys CLI', () => {
  test('create: prints plaintext exactly once to stdout', async () => {
    const { stdout, stderr, exitCode } = await runCli([
      'admin', 'keys', 'create',
      '--tenant', 'acme',
      '--scope', 'read',
      '--scope', 'write',
      '--description', 'test key',
    ]);
    expect(exitCode).toBeNull();
    // Plaintext is the sole CLI token even if Jest noise leaks into the shared stdout hook.
    const tokens = stdout.match(/oc_live_acme_[A-Za-z0-9]+/g) || [];
    expect(tokens).toHaveLength(1);
    const plaintext = tokens[0];
    // Warning routed to stderr.
    expect(stderr).toContain('SAVE THIS KEY NOW');
    // keyId is reported on stderr, not stdout.
    expect(stderr).toMatch(/keyId: k_/);
    // The plaintext must not leak into stderr.
    expect(stderr).not.toContain(plaintext);
  }, 30000);

  test('create: without OPENCHROME_ADMIN_TOKEN exits 1 with stderr error', async () => {
    delete process.env.OPENCHROME_ADMIN_TOKEN;
    const { stdout, stderr, exitCode } = await runCli([
      'admin', 'keys', 'create',
      '--tenant', 'acme',
      '--scope', 'read',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('OPENCHROME_ADMIN_TOKEN');
    expect(stdout).toBe('');
  }, 20000);

  test('create: invalid scope exits 1', async () => {
    const { exitCode, stderr } = await runCli([
      'admin', 'keys', 'create',
      '--tenant', 'acme',
      '--scope', 'superuser',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/invalid scope/i);
  }, 20000);

  test('list: shows keyId after create and never includes plaintext', async () => {
    const created = await runCli([
      'admin', 'keys', 'create',
      '--tenant', 'acme',
      '--scope', 'read',
    ]);
    const plaintext = extractToken(created.stdout);
    const keyIdMatch = created.stderr.match(/keyId: (k_\S+)/);
    expect(keyIdMatch).not.toBeNull();
    const keyId = keyIdMatch![1];

    const listed = await runCli(['admin', 'keys', 'list']);
    expect(listed.exitCode).toBeNull();
    expect(listed.stderr).toContain(keyId);
    // Plaintext must NEVER appear in either stream of list.
    const combined = listed.stdout + listed.stderr;
    expect(combined).not.toContain(plaintext);
    expect(combined).not.toContain('oc_live_');
  }, 30000);

  test('list --json: emits JSON array on stdout without plaintext', async () => {
    const created = await runCli([
      'admin', 'keys', 'create',
      '--tenant', 'acme',
      '--scope', 'read',
    ]);
    const plaintext = extractToken(created.stdout);

    const listed = await runCli(['admin', 'keys', 'list', '--json']);
    expect(listed.exitCode).toBeNull();
    const parsed = JSON.parse(extractJsonArray(listed.stdout)) as Array<{ keyId: string; tenantId: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tenantId).toBe('acme');
    expect(listed.stdout).not.toContain(plaintext);
    expect(listed.stdout).not.toContain('oc_live_');
  }, 30000);

  test('revoke: list afterwards shows revokedAt populated', async () => {
    const created = await runCli([
      'admin', 'keys', 'create',
      '--tenant', 'acme',
      '--scope', 'read',
    ]);
    const keyId = created.stderr.match(/keyId: (k_\S+)/)![1];

    const revoked = await runCli(['admin', 'keys', 'revoke', keyId]);
    expect(revoked.exitCode).toBeNull();
    expect(revoked.stderr).toContain('Revoked');

    const listed = await runCli(['admin', 'keys', 'list', '--json']);
    const parsed = JSON.parse(extractJsonArray(listed.stdout)) as Array<{ keyId: string; revokedAt?: number }>;
    const row = parsed.find((r) => r.keyId === keyId);
    expect(row).toBeDefined();
    expect(typeof row!.revokedAt).toBe('number');
    expect(row!.revokedAt!).toBeGreaterThan(0);
  }, 30000);

  test('rotate: produces new plaintext and revokes the old keyId', async () => {
    const created = await runCli([
      'admin', 'keys', 'create',
      '--tenant', 'acme',
      '--scope', 'read',
    ]);
    const firstPlaintext = extractToken(created.stdout);
    const firstKeyId = created.stderr.match(/keyId: (k_\S+)/)![1];

    const rotated = await runCli(['admin', 'keys', 'rotate', firstKeyId]);
    expect(rotated.exitCode).toBeNull();
    const secondPlaintext = extractToken(rotated.stdout);
    expect(secondPlaintext).toMatch(/^oc_live_acme_/);
    expect(secondPlaintext).not.toBe(firstPlaintext);
    expect(rotated.stderr).toContain('SAVE THIS KEY NOW');
    // Old plaintext must NOT appear anywhere in rotate output.
    expect(rotated.stdout + rotated.stderr).not.toContain(firstPlaintext);

    const listed = await runCli(['admin', 'keys', 'list', '--json']);
    const parsed = JSON.parse(extractJsonArray(listed.stdout)) as Array<{ keyId: string; revokedAt?: number }>;
    const oldRow = parsed.find((r) => r.keyId === firstKeyId);
    expect(oldRow).toBeDefined();
    expect(typeof oldRow!.revokedAt).toBe('number');
  }, 60000);

  test('revoke: unknown keyId exits 1', async () => {
    const { exitCode, stderr } = await runCli(['admin', 'keys', 'revoke', 'k_doesnotexist']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/unknown keyId/);
  }, 20000);
});
