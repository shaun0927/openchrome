import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  EncryptedFilePersistence,
  HandoffManager,
  PlaintextFilePersistence,
  autoSelectHandoffPersistence,
} from '../../src/contracts/handoff';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-hopst-'));
}

function key32(): Buffer {
  return crypto.randomBytes(32);
}

describe('PlaintextFilePersistence', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('loadAll returns empty for fresh install', () => {
    const p = new PlaintextFilePersistence({ rootDir: root });
    expect(p.loadAll()).toEqual([]);
  });

  test('round-trips records via saveAll → loadAll', () => {
    const p = new PlaintextFilePersistence({ rootDir: root });
    p.saveAll([
      {
        txn_id: 't1',
        attempt: 1,
        token: 'a'.repeat(64),
        status: 'pending',
        reason: 'two_factor',
        summary: '2FA',
        created_at: 1000,
        expires_at: 2000,
      },
    ]);
    const loaded = p.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].txn_id).toBe('t1');
    expect(loaded[0].status).toBe('pending');
  });

  test('saveAll writes file with mode 0o600', () => {
    const p = new PlaintextFilePersistence({ rootDir: root });
    p.saveAll([]);
    const target = path.join(root, 'handoff.json');
    const stat = fs.statSync(target);
    // Mask out higher mode bits and inspect the lower 9.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('clear() removes the file', () => {
    const p = new PlaintextFilePersistence({ rootDir: root });
    p.saveAll([]);
    expect(fs.existsSync(path.join(root, 'handoff.json'))).toBe(true);
    p.clear();
    expect(fs.existsSync(path.join(root, 'handoff.json'))).toBe(false);
  });

  test('corrupt JSON falls through to empty (does not throw)', () => {
    fs.writeFileSync(path.join(root, 'handoff.json'), 'not json {{');
    const p = new PlaintextFilePersistence({ rootDir: root });
    expect(p.loadAll()).toEqual([]);
  });
});

describe('EncryptedFilePersistence', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('round-trips records under AES-256-GCM', () => {
    const k = key32();
    const p = new EncryptedFilePersistence({ rootDir: root, key: k });
    const record = {
      txn_id: 't',
      attempt: 1,
      token: 'b'.repeat(64),
      status: 'pending' as const,
      reason: 'login_required' as const,
      summary: 'login',
      created_at: 1000,
      expires_at: 2000,
    };
    p.saveAll([record]);
    const reloaded = new EncryptedFilePersistence({ rootDir: root, key: k });
    const loaded = reloaded.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].token).toBe('b'.repeat(64));
  });

  test('on-disk blob is NOT plaintext (token does not appear)', () => {
    const p = new EncryptedFilePersistence({ rootDir: root, key: key32() });
    const tok = 'c'.repeat(64);
    p.saveAll([
      {
        txn_id: 't',
        attempt: 1,
        token: tok,
        status: 'pending',
        reason: 'unknown',
        summary: 's',
        created_at: 1,
        expires_at: 2,
      },
    ]);
    const blob = fs.readFileSync(path.join(root, 'handoff.json'));
    // Substring search across the entire blob (treat as bytes/string).
    expect(blob.toString('binary').includes(tok)).toBe(false);
  });

  test('wrong key produces empty load (auth-tag mismatch swallowed)', () => {
    const original = new EncryptedFilePersistence({ rootDir: root, key: key32() });
    original.saveAll([
      {
        txn_id: 't',
        attempt: 1,
        token: 'a'.repeat(64),
        status: 'pending',
        reason: 'unknown',
        summary: 's',
        created_at: 1,
        expires_at: 2,
      },
    ]);
    const wrongKey = new EncryptedFilePersistence({ rootDir: root, key: key32() });
    expect(wrongKey.loadAll()).toEqual([]);
  });

  test('rejects non-32-byte key', () => {
    expect(
      () => new EncryptedFilePersistence({ rootDir: root, key: Buffer.alloc(16) }),
    ).toThrow();
  });

  test('reads OPENCHROME_HANDOFF_KEY env var (hex)', () => {
    const k = key32().toString('hex');
    const prev = process.env.OPENCHROME_HANDOFF_KEY;
    process.env.OPENCHROME_HANDOFF_KEY = k;
    try {
      const p = new EncryptedFilePersistence({ rootDir: root });
      p.saveAll([]);
      expect(p.loadAll()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.OPENCHROME_HANDOFF_KEY;
      else process.env.OPENCHROME_HANDOFF_KEY = prev;
    }
  });

  test('reads OPENCHROME_HANDOFF_KEY env var (base64)', () => {
    const k = key32().toString('base64');
    const prev = process.env.OPENCHROME_HANDOFF_KEY;
    process.env.OPENCHROME_HANDOFF_KEY = k;
    try {
      const p = new EncryptedFilePersistence({ rootDir: root });
      p.saveAll([]);
      expect(p.loadAll()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.OPENCHROME_HANDOFF_KEY;
      else process.env.OPENCHROME_HANDOFF_KEY = prev;
    }
  });

  test('throws when key is missing entirely', () => {
    const prev = process.env.OPENCHROME_HANDOFF_KEY;
    delete process.env.OPENCHROME_HANDOFF_KEY;
    try {
      expect(() => new EncryptedFilePersistence({ rootDir: root })).toThrow(/no key/);
    } finally {
      if (prev !== undefined) process.env.OPENCHROME_HANDOFF_KEY = prev;
    }
  });

  test('IV randomness — two saveAll calls produce different ciphertext', () => {
    const k = key32();
    const p = new EncryptedFilePersistence({ rootDir: root, key: k });
    p.saveAll([]);
    const a = fs.readFileSync(path.join(root, 'handoff.json'));
    p.saveAll([]);
    const b = fs.readFileSync(path.join(root, 'handoff.json'));
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe('autoSelectHandoffPersistence', () => {
  let root: string;
  let prev: string | undefined;
  beforeEach(() => {
    root = tempRoot();
    prev = process.env.OPENCHROME_HANDOFF_KEY;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPENCHROME_HANDOFF_KEY;
    else process.env.OPENCHROME_HANDOFF_KEY = prev;
  });

  test('returns Encrypted when OPENCHROME_HANDOFF_KEY is set', () => {
    process.env.OPENCHROME_HANDOFF_KEY = key32().toString('hex');
    const p = autoSelectHandoffPersistence({ rootDir: root });
    expect(p).toBeInstanceOf(EncryptedFilePersistence);
  });

  test('returns Plaintext when env var is unset', () => {
    delete process.env.OPENCHROME_HANDOFF_KEY;
    const p = autoSelectHandoffPersistence({ rootDir: root });
    expect(p).toBeInstanceOf(PlaintextFilePersistence);
  });
});

describe('HandoffManager — persistence integration', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('manager rebuilt from persistence sees previously-created handoffs', () => {
    const p = new PlaintextFilePersistence({ rootDir: root });
    const a = new HandoffManager({ persistence: p, now: () => 1000 });
    a.create({ txn_id: 't', reason: 'two_factor', summary: '2FA' });
    const tokenBefore = a.list()[0].token;

    // Simulate a process restart by constructing a fresh manager.
    const b = new HandoffManager({ persistence: p, now: () => 1100 });
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0].token).toBe(tokenBefore);
  });

  test('per-txn cap survives a restart', () => {
    const p = new PlaintextFilePersistence({ rootDir: root });
    const a = new HandoffManager({ persistence: p, maxPerTxn: 3 });
    a.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    a.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    a.create({ txn_id: 't', reason: 'unknown', summary: 's' });

    const b = new HandoffManager({ persistence: p, maxPerTxn: 3 });
    // Restart sees attempt count 3 → 4th attempt should still throw.
    expect(() => b.create({ txn_id: 't', reason: 'unknown', summary: 's' })).toThrow(
      /cap exhausted/,
    );
  });

  test('resume after restart with the original token works', () => {
    const p = new PlaintextFilePersistence({ rootDir: root });
    const a = new HandoffManager({ persistence: p, now: () => 1000 });
    const rec = a.create({ txn_id: 't', reason: 'unknown', summary: 's' });

    const b = new HandoffManager({ persistence: p, now: () => 1100 });
    const r = b.resume('t', rec.token);
    expect(r.ok).toBe(true);
    expect(r.record?.status).toBe('resumed');
  });

  test('reset() clears persisted file', () => {
    const p = new PlaintextFilePersistence({ rootDir: root });
    const m = new HandoffManager({ persistence: p });
    m.create({ txn_id: 't', reason: 'unknown', summary: 's' });
    expect(fs.existsSync(path.join(root, 'handoff.json'))).toBe(true);
    m.reset();
    expect(fs.existsSync(path.join(root, 'handoff.json'))).toBe(false);
  });
});
