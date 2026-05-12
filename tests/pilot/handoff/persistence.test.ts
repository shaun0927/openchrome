/**
 * Tests for handoff persistence (Phase 3, issue #794).
 *
 * All disk I/O uses a real temp directory created per-test and cleaned up
 * in afterEach. No mocking of `node:crypto` or `node:fs` — the real
 * implementations are used to validate the AES-256-GCM round-trip.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  EphemeralEncryptedPersistence,
  FileBackedKeyEncryptedPersistence,
  autoSelectHandoffPersistence,
} from '../../../src/pilot/handoff/persistence.js';
import { HandoffManager } from '../../../src/pilot/handoff/manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-794-test-'));
}

function removeTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function writeKeyFile(dir: string, bytes: number): string {
  const filePath = path.join(dir, 'handoff.key');
  fs.writeFileSync(filePath, crypto.randomBytes(bytes));
  return filePath;
}

// ---------------------------------------------------------------------------
// EphemeralEncryptedPersistence — encrypt + decrypt round-trip
// ---------------------------------------------------------------------------

describe('EphemeralEncryptedPersistence — round-trip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('put then get returns the original payload', async () => {
    const p = new EphemeralEncryptedPersistence(tmpDir);
    const token = 'tok-abc-123';
    const payload = JSON.stringify({ sessionId: 's1', scope: 'checkout' });
    await p.put(token, payload);
    const result = await p.get(token);
    expect(result).toBe(payload);
  });

  it('get on missing token returns null', async () => {
    const p = new EphemeralEncryptedPersistence(tmpDir);
    const result = await p.get('nonexistent-token');
    expect(result).toBeNull();
  });

  it('delete removes the file; subsequent get returns null', async () => {
    const p = new EphemeralEncryptedPersistence(tmpDir);
    const token = 'tok-del-1';
    await p.put(token, 'hello');
    await p.delete(token);
    expect(await p.get(token)).toBeNull();
  });

  it('delete on absent token is a no-op (does not throw)', async () => {
    const p = new EphemeralEncryptedPersistence(tmpDir);
    await expect(p.delete('no-such-token')).resolves.toBeUndefined();
  });

  it('clear removes all .enc files', async () => {
    const p = new EphemeralEncryptedPersistence(tmpDir);
    await p.put('t1', 'payload-1');
    await p.put('t2', 'payload-2');
    await p.clear();
    expect(await p.get('t1')).toBeNull();
    expect(await p.get('t2')).toBeNull();
    const remaining = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.enc'));
    expect(remaining).toHaveLength(0);
  });

  it('stores the file under a sha256 hash, not the raw token', async () => {
    const p = new EphemeralEncryptedPersistence(tmpDir);
    const token = 'super-secret-token';
    await p.put(token, 'data');
    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      expect(f).not.toContain(token);
    }
  });
});

// ---------------------------------------------------------------------------
// EphemeralEncryptedPersistence — wrong key cannot decrypt
// ---------------------------------------------------------------------------

describe('EphemeralEncryptedPersistence — key isolation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('a new instance (different ephemeral key) cannot decrypt records written by a previous instance', async () => {
    const token = 'shared-token';
    const payload = '{"sessionId":"s2","scope":"admin"}';

    // First instance writes the record.
    const p1 = new EphemeralEncryptedPersistence(tmpDir);
    await p1.put(token, payload);

    // Second instance has a different key — decryption must fail gracefully.
    const p2 = new EphemeralEncryptedPersistence(tmpDir);
    const result = await p2.get(token);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FileBackedKeyEncryptedPersistence
// ---------------------------------------------------------------------------

describe('FileBackedKeyEncryptedPersistence — key file with exactly 32 bytes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('encrypts and decrypts with the file-backed key', async () => {
    const keyFile = writeKeyFile(tmpDir, 32);
    const p = new FileBackedKeyEncryptedPersistence(tmpDir, keyFile);
    const token = 'fb-token-1';
    const payload = '{"sessionId":"s3","scope":"write"}';
    await p.put(token, payload);
    const result = await p.get(token);
    expect(result).toBe(payload);
  });

  it('two instances sharing the same key file can cross-read each other', async () => {
    const keyFile = writeKeyFile(tmpDir, 32);
    const p1 = new FileBackedKeyEncryptedPersistence(tmpDir, keyFile);
    const p2 = new FileBackedKeyEncryptedPersistence(tmpDir, keyFile);
    const token = 'fb-token-cross';
    const payload = '{"sessionId":"s4","scope":"read"}';
    await p1.put(token, payload);
    const result = await p2.get(token);
    expect(result).toBe(payload);
  });
});

describe('FileBackedKeyEncryptedPersistence — wrong size key file throws', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('throws when key file is 16 bytes (too short)', () => {
    const keyFile = writeKeyFile(tmpDir, 16);
    expect(() => new FileBackedKeyEncryptedPersistence(tmpDir, keyFile)).toThrow(
      /must be exactly 32 bytes/
    );
  });

  it('throws when key file is 64 bytes (too long)', () => {
    const keyFile = writeKeyFile(tmpDir, 64);
    expect(() => new FileBackedKeyEncryptedPersistence(tmpDir, keyFile)).toThrow(
      /must be exactly 32 bytes/
    );
  });
});

// ---------------------------------------------------------------------------
// autoSelectHandoffPersistence
// ---------------------------------------------------------------------------

describe('autoSelectHandoffPersistence — selection heuristic', () => {
  let tmpDir: string;
  const envKey = 'OPENCHROME_HANDOFF_KEY_FILE';

  beforeEach(() => {
    tmpDir = makeTmpDir();
    delete process.env[envKey];
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
    delete process.env[envKey];
  });

  it('returns EphemeralEncryptedPersistence when no env var and no keyFilePath', () => {
    const adapter = autoSelectHandoffPersistence({ rootDir: tmpDir });
    expect(adapter).toBeInstanceOf(EphemeralEncryptedPersistence);
    expect(adapter).not.toBeInstanceOf(FileBackedKeyEncryptedPersistence);
  });

  it('returns FileBackedKeyEncryptedPersistence when keyFilePath has exactly 32 bytes', () => {
    const keyFile = writeKeyFile(tmpDir, 32);
    const adapter = autoSelectHandoffPersistence({ rootDir: tmpDir, keyFilePath: keyFile });
    expect(adapter).toBeInstanceOf(FileBackedKeyEncryptedPersistence);
  });

  it('falls back to ephemeral when keyFilePath file is wrong size', () => {
    const keyFile = writeKeyFile(tmpDir, 16);
    const adapter = autoSelectHandoffPersistence({ rootDir: tmpDir, keyFilePath: keyFile });
    expect(adapter).toBeInstanceOf(EphemeralEncryptedPersistence);
    expect(adapter).not.toBeInstanceOf(FileBackedKeyEncryptedPersistence);
  });

  it('falls back to ephemeral when keyFilePath file does not exist', () => {
    const adapter = autoSelectHandoffPersistence({
      rootDir: tmpDir,
      keyFilePath: path.join(tmpDir, 'nonexistent.key'),
    });
    expect(adapter).toBeInstanceOf(EphemeralEncryptedPersistence);
    expect(adapter).not.toBeInstanceOf(FileBackedKeyEncryptedPersistence);
  });

  it('returns FileBackedKeyEncryptedPersistence when OPENCHROME_HANDOFF_KEY_FILE env var is set', () => {
    const keyFile = writeKeyFile(tmpDir, 32);
    process.env[envKey] = keyFile;
    const adapter = autoSelectHandoffPersistence({ rootDir: tmpDir });
    expect(adapter).toBeInstanceOf(FileBackedKeyEncryptedPersistence);
  });

  it('explicit keyFilePath takes precedence over env var', () => {
    // Env var points to a bad key (16 bytes); explicit arg points to good key.
    const badKey = writeKeyFile(tmpDir, 16);
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    const goodKey = writeKeyFile(subDir, 32);
    process.env[envKey] = badKey;
    const adapter = autoSelectHandoffPersistence({ rootDir: tmpDir, keyFilePath: goodKey });
    expect(adapter).toBeInstanceOf(FileBackedKeyEncryptedPersistence);
  });
});

// ---------------------------------------------------------------------------
// Manager integration — ephemeral key restart invalidates persisted tokens
// ---------------------------------------------------------------------------

describe('HandoffManager + EphemeralEncryptedPersistence — restart invalidation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('token registered with instance A cannot be redeemed by instance B (different ephemeral key)', async () => {
    // Instance A: register a token and persist it.
    const persistA = new EphemeralEncryptedPersistence(tmpDir);
    const managerA = new HandoffManager({
      pruneIntervalMs: 0,
      persistence: persistA,
    });
    const { token } = managerA.register({ sessionId: 'sess-restart', scope: 'test' });

    // Wait for the fire-and-forget persistence.put to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));

    managerA.dispose();

    // Instance B: new ephemeral key — cannot decrypt A's persisted record.
    const persistB = new EphemeralEncryptedPersistence(tmpDir);
    const managerB = new HandoffManager({
      pruneIntervalMs: 0,
      persistence: persistB,
    });

    // In-memory miss.
    expect(managerB.redeem(token)).toBeNull();

    // Persistence fallback also returns null (different key).
    const recovered = await managerB.redeemAsync(token);
    expect(recovered).toBeNull();

    managerB.dispose();
  });

  it('redeemAsync recovers a valid token from persistence on an in-memory miss', async () => {
    const persist = new EphemeralEncryptedPersistence(tmpDir);
    const managerA = new HandoffManager({
      pruneIntervalMs: 0,
      persistence: persist,
    });
    const { token } = managerA.register({ sessionId: 'sess-recover', scope: 'read' });

    // Wait for persistence.put to complete.
    await new Promise<void>((resolve) => setImmediate(resolve));

    managerA.dispose();

    // Instance B reuses the same persistence adapter (same key) — simulates
    // a graceful restart where the key is stable.
    const managerB = new HandoffManager({
      pruneIntervalMs: 0,
      persistence: persist,
    });

    // In-memory miss — token was registered only in A.
    expect(managerB.redeem(token)).toBeNull();

    // Async path falls back to persistence and succeeds.
    const redemption = await managerB.redeemAsync(token);
    expect(redemption).not.toBeNull();
    expect(redemption!.sessionId).toBe('sess-recover');
    expect(redemption!.scope).toBe('read');

    // Consumed — second call returns null.
    expect(await managerB.redeemAsync(token)).toBeNull();

    managerB.dispose();
  });
});
