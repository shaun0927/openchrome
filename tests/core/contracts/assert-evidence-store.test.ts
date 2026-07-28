/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AssertEvidenceStore,
  AssertEvidencePersistError,
  AssertEvidenceStoreError,
} from '../../../src/core/contracts/assert-evidence-store';
import {
  EMPTY_SECRET_STORE,
  makeSecretStore,
  setSecretStore,
} from '../../../src/core/secrets/loader';

function persist(store: AssertEvidenceStore, overrides: Record<string, unknown> = {}) {
  return store.persist({
    sessionId: 'session-a',
    tenantId: 'tenant-a',
    verdict: 'pass',
    contractSource: 'inline',
    targetId: 'tab-a',
    workerId: 'worker-a',
    pageUrl: 'https://alice:hunter2@example.com/account?token=super-secret-token-value',
    assertion: { kind: 'url', pattern: 'example\\.com' },
    result: {
      verdict: 'pass',
      evidence: {
        passed: true,
        assertion_kind: 'url',
        details: {
          url: 'https://alice:hunter2@example.com/account?token=super-secret-token-value',
          authorization: 'Bearer abcdefghijklmnop',
        },
      },
    },
    trace: {
      status: 'unavailable',
      reason: 'snapshot verification does not create runtime traces',
    },
    ...overrides,
  });
}

describe('AssertEvidenceStore', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-assert-evidence-'));
  });

  afterEach(() => {
    setSecretStore(EMPTY_SECRET_STORE);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('persists a durable handle that a new store instance can retrieve', () => {
    const first = new AssertEvidenceStore({ rootDir });
    const stored = persist(first);
    const second = new AssertEvidenceStore({ rootDir });

    const artifact = second.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });

    expect(artifact.evidence_handle).toBe(stored.evidence_handle);
    expect(artifact.provenance).toMatchObject({
      session_id: 'session-a',
      tenant_id: 'tenant-a',
      target_id: 'tab-a',
      worker_id: 'worker-a',
      verdict: 'pass',
    });
    expect(artifact.trace).toEqual({
      status: 'unavailable',
      reason: 'snapshot verification does not create runtime traces',
    });
  });

  test('redacts credential patterns before persistence and again on retrieval', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const stored = persist(store);
    const filePath = path.join(rootDir, `${stored.evidence_handle}.json`);
    const raw = fs.readFileSync(filePath, 'utf8');

    expect(raw).not.toContain('super-secret-token-value');
    expect(raw).not.toContain('abcdefghijklmnop');
    expect(raw).not.toContain('alice');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('https://[REDACTED]@example.com/account?token=[REDACTED]');
    expect(raw).toContain('[REDACTED]');

    const artifact = store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });
    expect(JSON.stringify(artifact)).not.toContain('super-secret-token-value');
    expect(JSON.stringify(artifact)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(artifact)).not.toContain('alice');
    expect(JSON.stringify(artifact)).not.toContain('hunter2');
  });

  test('keeps authorization stable when configured secrets match owner identifiers', () => {
    setSecretStore(makeSecretStore(new Map([
      ['SESSION_ID', 'session-a'],
      ['TENANT_ID', 'tenant-a'],
    ])));
    const store = new AssertEvidenceStore({ rootDir });
    const stored = persist(store);
    const raw = fs.readFileSync(path.join(rootDir, `${stored.evidence_handle}.json`), 'utf8');

    expect(raw).not.toContain('session-a');
    expect(raw).not.toContain('tenant-a');
    const artifact = store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });
    expect(artifact.provenance.session_id).toBe('${SECRET:SESSION_ID}');
    expect(artifact.provenance.tenant_id).toBe('${SECRET:TENANT_ID}');
    expect(store.evictSession('session-a')).toBe(1);
  });

  test.each([
    [{ sessionId: 'session-b', tenantId: 'tenant-a' }, 'session mismatch'],
    [{ sessionId: 'session-a', tenantId: 'tenant-b' }, 'tenant mismatch'],
  ])('rejects unauthorized retrieval for %s (%s)', (owner) => {
    const store = new AssertEvidenceStore({ rootDir });
    const stored = persist(store);

    expect(() => store.loadAuthorized(stored.evidence_handle, owner)).toThrow(
      expect.objectContaining<Partial<AssertEvidenceStoreError>>({ code: 'forbidden' }),
    );
  });

  test('isolates identical session and tenant IDs across OpenChrome instances', () => {
    const first = new AssertEvidenceStore({ rootDir, instanceId: 'instance-a' });
    const second = new AssertEvidenceStore({ rootDir, instanceId: 'instance-b' });
    const stored = persist(first);

    expect(() => second.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    })).toThrow(expect.objectContaining<Partial<AssertEvidenceStoreError>>({ code: 'forbidden' }));
    expect(second.evictSession('session-a')).toBe(0);
    expect(first.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    }).evidence_handle).toBe(stored.evidence_handle);
  });

  test('rejects an oversized artifact before writing it', () => {
    const store = new AssertEvidenceStore({ rootDir, maxArtifactBytes: 2_000 });

    expect(() => persist(store, {
      assertion: {
        kind: 'image_qa',
        question: 'x'.repeat(10_000),
        expected_pattern: 'yes',
      },
    })).toThrow(expect.objectContaining<Partial<AssertEvidencePersistError>>({
      code: 'artifact_too_large',
    }));
    expect(fs.readdirSync(rootDir).filter((file) => file.endsWith('.json'))).toHaveLength(0);
  });

  test('rebuilds quota usage once and enforces the owner cap across store instances', () => {
    const first = new AssertEvidenceStore({
      rootDir,
      instanceId: 'quota-instance',
      maxOwnerArtifacts: 1,
    });
    persist(first);

    const second = new AssertEvidenceStore({
      rootDir,
      instanceId: 'quota-instance',
      maxOwnerArtifacts: 1,
    });
    expect(() => persist(second)).toThrow(
      expect.objectContaining<Partial<AssertEvidencePersistError>>({ code: 'owner_quota_exceeded' }),
    );
    expect(() => persist(second, { sessionId: 'session-b' })).not.toThrow();
  });

  test('enforces the aggregate instance artifact cap across different owners', () => {
    const store = new AssertEvidenceStore({ rootDir, maxInstanceArtifacts: 1 });
    persist(store);

    expect(() => persist(store, { sessionId: 'session-b' })).toThrow(
      expect.objectContaining<Partial<AssertEvidencePersistError>>({
        code: 'instance_quota_exceeded',
      }),
    );
  });

  test('does not run the full cleanup sweep on each persist call', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const cleanup = jest.spyOn(store, 'cleanupExpired');

    persist(store);
    persist(store, { sessionId: 'session-b' });

    expect(cleanup).not.toHaveBeenCalled();
  });

  test('expires stale handles and deletes their files', () => {
    let now = 1_000;
    const store = new AssertEvidenceStore({
      rootDir,
      ttlMs: 500,
      now: () => now,
    });
    const stored = persist(store);
    now = 1_501;

    expect(() => store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    })).toThrow(expect.objectContaining<Partial<AssertEvidenceStoreError>>({ code: 'expired' }));
    expect(fs.existsSync(path.join(rootDir, `${stored.evidence_handle}.json`))).toBe(false);
  });

  test('removes crash-left temporary files after the retention window', () => {
    const now = Date.now();
    const store = new AssertEvidenceStore({ rootDir, ttlMs: 500, now: () => now });
    const tempPath = path.join(
      rootDir,
      'ev_00000000-0000-0000-0000-000000000000.json.123.11111111-1111-1111-1111-111111111111.tmp',
    );
    fs.writeFileSync(tempPath, '{}', 'utf8');
    fs.utimesSync(tempPath, new Date(now - 1_000), new Date(now - 1_000));

    expect(store.cleanupExpired()).toBe(1);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  test('evicts only artifacts owned by the deleted session', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const owned = persist(store);
    const other = persist(store, { sessionId: 'session-b' });

    expect(store.evictSession('session-a')).toBe(1);
    expect(() => store.loadAuthorized(owned.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    })).toThrow(expect.objectContaining<Partial<AssertEvidenceStoreError>>({ code: 'not_found' }));
    expect(store.loadAuthorized(other.evidence_handle, {
      sessionId: 'session-b',
      tenantId: 'tenant-a',
    }).evidence_handle).toBe(other.evidence_handle);
  });

  test('rejects artifacts whose required provenance no longer matches the result', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const stored = persist(store);
    const filePath = path.join(rootDir, `${stored.evidence_handle}.json`);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const artifact = record.artifact as Record<string, unknown>;
    const provenance = artifact.provenance as Record<string, unknown>;
    provenance.verdict = 'fail';
    fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');

    expect(() => store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-b',
      tenantId: 'tenant-a',
    })).toThrow(expect.objectContaining<Partial<AssertEvidenceStoreError>>({ code: 'forbidden' }));
    expect(() => store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    })).toThrow(expect.objectContaining<Partial<AssertEvidenceStoreError>>({ code: 'corrupt' }));
  });
});
