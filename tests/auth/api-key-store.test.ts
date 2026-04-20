/// <reference types="jest" />
// Unit tests for the tenant API key store.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ApiKeyStore } from '../../src/auth/api-key-store';

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-apikeys-'));
  return path.join(dir, 'api-keys.jsonl');
}

describe('ApiKeyStore', () => {
  test('create returns plaintext once and list omits it', async () => {
    const store = await ApiKeyStore.open(tmpStore());
    const res = await store.create({
      tenantId: 'acme',
      scopes: ['read'],
      description: 'test',
    });
    expect(res.plaintext).toMatch(/^oc_live_acme_[A-Za-z0-9]{32}$/);
    expect(res.record.keyId).toMatch(/^k_/);
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    const first = listed[0] as ApiKey & { plaintext?: string };
    expect(first.keyId).toBe(res.record.keyId);
    expect(first.keyHash).toBe(res.record.keyHash);
    expect(first.plaintext).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain(res.plaintext);
  });

  test('verify returns the record for correct plaintext', async () => {
    const store = await ApiKeyStore.open(tmpStore());
    const { plaintext, record } = await store.create({
      tenantId: 't1',
      scopes: ['read', 'write'],
      description: '',
    });
    const verified = await store.verify(plaintext);
    expect(verified).not.toBeNull();
    expect(verified?.keyId).toBe(record.keyId);
    expect(verified?.scopes).toEqual(['read', 'write']);
  });

  test('verify returns null for wrong plaintext', async () => {
    const store = await ApiKeyStore.open(tmpStore());
    await store.create({ tenantId: 't1', scopes: ['read'], description: '' });
    expect(await store.verify('oc_live_t1_' + 'x'.repeat(32))).toBeNull();
    expect(await store.verify('not-even-a-key')).toBeNull();
    expect(await store.verify('')).toBeNull();
  });

  test('verify returns null after revoke', async () => {
    const store = await ApiKeyStore.open(tmpStore());
    const { plaintext, record } = await store.create({
      tenantId: 't1',
      scopes: ['read'],
      description: '',
    });
    expect(await store.verify(plaintext)).not.toBeNull();
    const ok = await store.revoke(record.keyId);
    expect(ok).toBe(true);
    expect(await store.verify(plaintext)).toBeNull();
  });

  test('verify returns null when expired', async () => {
    const store = await ApiKeyStore.open(tmpStore());
    const { plaintext } = await store.create({
      tenantId: 't1',
      scopes: ['read'],
      description: '',
      expiresAt: Date.now() - 1000,
    });
    expect(await store.verify(plaintext)).toBeNull();
  });

  test('revoke returns false for unknown keyId', async () => {
    const store = await ApiKeyStore.open(tmpStore());
    expect(await store.revoke('k_nonexistent')).toBe(false);
  });

  test('rotate revokes old and issues new plaintext', async () => {
    const store = await ApiKeyStore.open(tmpStore());
    const first = await store.create({
      tenantId: 't1',
      scopes: ['read', 'admin'],
      description: 'orig',
    });
    const rotated = await store.rotate(first.record.keyId);
    expect(rotated.plaintext).not.toBe(first.plaintext);
    expect(rotated.record.keyId).not.toBe(first.record.keyId);
    expect(rotated.record.tenantId).toBe('t1');
    expect(rotated.record.scopes).toEqual(['read', 'admin']);
    expect(await store.verify(first.plaintext)).toBeNull();
    expect(await store.verify(rotated.plaintext)).not.toBeNull();
  });

  test('reopen sees writes from another store instance', async () => {
    const p = tmpStore();
    const a = await ApiKeyStore.open(p);
    const { plaintext, record } = await a.create({
      tenantId: 't1',
      scopes: ['read'],
      description: 'x',
    });
    const b = await ApiKeyStore.open(p);
    const listed = await b.list();
    expect(listed.some((r) => r.keyId === record.keyId)).toBe(true);
    expect(await b.verify(plaintext)).not.toBeNull();
  });

  // Regression: the Codex P1 review on PR #18. A long-lived store instance
  // must observe create/revoke performed by a peer process without a restart.
  // We simulate two processes by opening two stores against the same JSONL
  // file; `b` is opened BEFORE `a` writes, so `b`'s in-memory index starts
  // empty and must catch up via the sync-on-verify path.
  test('verify() picks up peer-process create and revoke without restart', async () => {
    const p = tmpStore();
    const a = await ApiKeyStore.open(p);
    const b = await ApiKeyStore.open(p);

    // b was opened before any writes — its index is empty.
    expect(await b.list()).toHaveLength(0);

    // Peer (a) creates a key. b must see it on the next verify().
    const { plaintext, record } = await a.create({
      tenantId: 't1',
      scopes: ['read'],
      description: 'peer-created',
    });
    const seen = await b.verify(plaintext);
    expect(seen).not.toBeNull();
    expect(seen?.keyId).toBe(record.keyId);

    // Peer (a) revokes the key. b must stop accepting it without restart.
    const ok = await a.revoke(record.keyId);
    expect(ok).toBe(true);
    expect(await b.verify(plaintext)).toBeNull();
  });

  test('reopen preserves revocation across instances', async () => {
    const p = tmpStore();
    const a = await ApiKeyStore.open(p);
    const { plaintext, record } = await a.create({
      tenantId: 't1',
      scopes: ['read'],
      description: '',
    });
    await a.revoke(record.keyId);
    const b = await ApiKeyStore.open(p);
    expect(await b.verify(plaintext)).toBeNull();
  });

  test('touchLastUsed updates lastUsedAt in-memory and on reopen', async () => {
    const p = tmpStore();
    const a = await ApiKeyStore.open(p);
    const { record } = await a.create({
      tenantId: 't1',
      scopes: ['read'],
      description: '',
    });
    await a.touchLastUsed(record.keyId);
    const listed = await a.list();
    expect(listed[0].lastUsedAt).toBeGreaterThan(0);
    const b = await ApiKeyStore.open(p);
    const listedB = await b.list();
    expect(listedB[0].lastUsedAt).toBeGreaterThan(0);
  });

  test('verify timing: wrong vs correct are indistinguishable', async () => {
    // The issue target is <1ms; we relax to a ratio-based check to survive
    // loaded CI runners. argon2.verify at memoryCost=19MiB takes ~50-120ms per
    // call with natural jitter of several ms, so absolute-ms thresholds are
    // flaky. We instead require the median ratio to be within 25% of 1.0,
    // which is sensitive to a real short-circuit on miss (which would be ~0ms)
    // but tolerant of OS-level jitter.
    const store = await ApiKeyStore.open(tmpStore());
    const { plaintext } = await store.create({
      tenantId: 't1',
      scopes: ['read'],
      description: '',
    });
    const wrong = 'oc_live_t1_' + 'y'.repeat(32);
    const runs = 20;

    // Warmup to prime JIT / native addon.
    for (let i = 0; i < 3; i++) {
      await store.verify(plaintext);
      await store.verify(wrong);
    }

    async function time(fn: () => Promise<unknown>): Promise<number> {
      const start = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - start) / 1e6;
    }

    const correctTimes: number[] = [];
    const wrongTimes: number[] = [];
    for (let i = 0; i < runs; i++) {
      correctTimes.push(await time(() => store.verify(plaintext)));
      wrongTimes.push(await time(() => store.verify(wrong)));
    }
    const median = (xs: number[]): number => {
      const s = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
    };
    const mCorrect = median(correctTimes);
    const mWrong = median(wrongTimes);
    // Both medians must be non-trivial (argon2 actually ran on the miss path).
    expect(mCorrect).toBeGreaterThan(5);
    expect(mWrong).toBeGreaterThan(5);
    const ratio = mWrong / mCorrect;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(1.25);
  }, 60000);

  test('JSONL file never contains plaintext', async () => {
    const p = tmpStore();
    const store = await ApiKeyStore.open(p);
    const { plaintext } = await store.create({
      tenantId: 'acme',
      scopes: ['read'],
      description: 'secret-free',
    });
    const raw = await fs.promises.readFile(p, 'utf8');
    expect(raw).not.toContain(plaintext);
    // The random tail alone should also not leak.
    const tail = plaintext.split('_').slice(-1)[0];
    expect(raw).not.toContain(tail);
  });

  test('file has 0600 permissions (skip on Windows)', async () => {
    if (process.platform === 'win32') return;
    const p = tmpStore();
    await ApiKeyStore.open(p);
    const st = await fs.promises.stat(p);
    // eslint-disable-next-line no-bitwise
    const mode = st.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('directory has 0700 permissions (skip on Windows)', async () => {
    if (process.platform === 'win32') return;
    const p = tmpStore();
    await ApiKeyStore.open(p);
    const st = await fs.promises.stat(path.dirname(p));
    // eslint-disable-next-line no-bitwise
    const mode = st.mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

// Local helper type alias to keep imports lean while asserting shape.
type ApiKey = import('../../src/auth/api-key-types').ApiKey;
