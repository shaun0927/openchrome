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
    pageUrl: 'https://alice:p@ss@example.com/account?token=super-secret-token-value',
    assertion: { kind: 'url', pattern: 'example\\.com' },
    result: {
      verdict: 'pass',
      evidence: {
        passed: true,
        assertion_kind: 'url',
        details: {
          url: 'https://alice:p@ss@example.com/account?token=super-secret-token-value',
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

function selectedFactTargetId(artifact: unknown): unknown {
  return (artifact as {
    result?: {
      evidence?: {
        details?: {
          fact?: {
            target_id?: unknown;
          };
        };
      };
    };
  }).result?.evidence?.details?.fact?.target_id;
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
    expect(raw).not.toContain('p@ss');
    expect(raw).not.toContain('ss@example.com');
    expect(raw).toContain('https://[REDACTED]@example.com/account?token=[REDACTED]');
    expect(raw).toContain('[REDACTED]');

    const artifact = store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });
    expect(JSON.stringify(artifact)).not.toContain('super-secret-token-value');
    expect(JSON.stringify(artifact)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(artifact)).not.toContain('alice');
    expect(JSON.stringify(artifact)).not.toContain('p@ss');
    expect(JSON.stringify(artifact)).not.toContain('ss@example.com');
  });

  test('preserves opaque 32-character provenance IDs without bypassing configured secrets', () => {
    const targetId = '0123456789abcdef0123456789abcdef';
    const workerId = 'abcdef0123456789abcdef0123456789';
    setSecretStore(makeSecretStore(new Map([
      ['WORKER_ID', workerId],
    ])));
    const store = new AssertEvidenceStore({ rootDir });
    const stored = persist(store, { targetId, workerId });
    const raw = fs.readFileSync(path.join(rootDir, `${stored.evidence_handle}.json`), 'utf8');

    expect(raw).toContain(targetId);
    expect(raw).not.toContain(workerId);
    expect(raw).toContain('${SECRET:WORKER_ID}');

    const artifact = store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });
    expect(artifact.provenance.target_id).toBe(targetId);
    expect(artifact.provenance.worker_id).toBe('${SECRET:WORKER_ID}');
  });

  test('preserves opaque target IDs in nested selected contract facts', () => {
    const factTargetId = '1234567890abcdef1234567890abcdef';
    const store = new AssertEvidenceStore({ rootDir });
    const stored = persist(store, {
      result: {
        verdict: 'pass',
        evidence: {
          passed: true,
          assertion_kind: 'performance',
          details: {
            fact: {
              schema_version: 1,
              kind: 'performance',
              source_tool: 'performance_metrics',
              session_id: 'session-a',
              target_id: factTargetId,
              captured_at: '2026-07-28T12:00:00.000Z',
              metric: 'navigation.duration',
              unit: 'ms',
              value: 750,
            },
          },
        },
      },
    });
    const record = JSON.parse(
      fs.readFileSync(path.join(rootDir, `${stored.evidence_handle}.json`), 'utf8'),
    ) as { artifact: unknown };

    expect(selectedFactTargetId(record.artifact)).toBe(factTargetId);
    const artifact = store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });
    expect(selectedFactTargetId(artifact)).toBe(factTargetId);
  });

  test('keeps configured secrets redacted in nested selected contract facts', () => {
    const factTargetId = 'fedcba0987654321fedcba0987654321';
    setSecretStore(makeSecretStore(new Map([
      ['FACT_TARGET_ID', factTargetId],
    ])));
    const store = new AssertEvidenceStore({ rootDir });
    const stored = persist(store, {
      result: {
        verdict: 'pass',
        evidence: {
          passed: true,
          assertion_kind: 'console',
          details: {
            fact: {
              schema_version: 1,
              kind: 'console',
              source_tool: 'console_capture',
              session_id: 'session-a',
              target_id: factTargetId,
              captured_at: '2026-07-28T12:00:00.000Z',
              entries: [],
              captured_types: null,
              message_encoding: 'plain',
              truncated: false,
            },
          },
        },
      },
    });
    const record = JSON.parse(
      fs.readFileSync(path.join(rootDir, `${stored.evidence_handle}.json`), 'utf8'),
    ) as { artifact: unknown };

    expect(selectedFactTargetId(record.artifact)).toBe('${SECRET:FACT_TARGET_ID}');
    const artifact = store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });
    expect(selectedFactTargetId(artifact)).toBe('${SECRET:FACT_TARGET_ID}');
  });

  test('redacts OAuth access tokens from persisted and retrieved URLs', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const callbackUrl = 'https://example.com/callback?access_token=ya29.example&token_type=Bearer';
    const stored = persist(store, {
      pageUrl: callbackUrl,
      result: {
        verdict: 'pass',
        evidence: {
          passed: true,
          assertion_kind: 'url',
          details: { url: callbackUrl },
        },
      },
    });
    const raw = fs.readFileSync(path.join(rootDir, `${stored.evidence_handle}.json`), 'utf8');

    expect(raw).not.toContain('ya29.example');
    expect(raw).toContain('access_token=[REDACTED]');
    expect(raw).toContain('token_type=Bearer');

    const artifact = store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });
    const retrieved = JSON.stringify(artifact);
    expect(retrieved).not.toContain('ya29.example');
    expect(retrieved).toContain('access_token=[REDACTED]');
    expect(retrieved).toContain('token_type=Bearer');
  });

  test('redacts nested raw and encoded URL credentials in durable artifacts', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const nestedUrl = 'https://example.com/?next=https://alice:secret@evil.example/private';
    const encodedUrl = 'https://example.com/?next=https%3A%2F%2Fbob%3Asecret%40evil.example%2Fprivate%3Faccess_token%3Dya29.example';
    const stored = persist(store, {
      pageUrl: nestedUrl,
      result: {
        verdict: 'pass',
        evidence: {
          passed: true,
          assertion_kind: 'url',
          details: { url: encodedUrl },
        },
      },
    });
    const raw = fs.readFileSync(path.join(rootDir, `${stored.evidence_handle}.json`), 'utf8');

    expect(raw).not.toContain('alice');
    expect(raw).not.toContain('bob');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('ya29.example');
    expect(raw).toContain('next=https://[REDACTED]@evil.example/private');
    expect(raw).toContain(
      'next=https%3A%2F%2F%5BREDACTED%5D%40evil.example%2Fprivate%3Faccess_token%3D%5BREDACTED%5D',
    );

    const artifact = store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    });
    const retrieved = JSON.stringify(artifact);
    expect(retrieved).not.toContain('alice');
    expect(retrieved).not.toContain('bob');
    expect(retrieved).not.toContain('secret');
    expect(retrieved).not.toContain('ya29.example');
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
    expect(store.evictSession('session-a', 'tenant-a')).toBe(1);
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
    expect(second.evictSession('session-a', 'tenant-a')).toBe(0);
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

  test('reports stale handles without mutating storage during retrieval', () => {
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
    const artifactPath = path.join(rootDir, `${stored.evidence_handle}.json`);
    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(store.cleanupExpired()).toBe(1);
    expect(fs.existsSync(artifactPath)).toBe(false);
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

  test('preserves a live artifact when the periodic sweep hits a transient read error', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const stored = persist(store);
    const artifactPath = path.join(rootDir, `${stored.evidence_handle}.json`);
    const nodeFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const realReadFileSync = nodeFs.readFileSync.bind(nodeFs);
    const read = jest.spyOn(nodeFs, 'readFileSync').mockImplementation(((filePath, ...args: unknown[]) => {
      if (String(filePath) === artifactPath) {
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
      return realReadFileSync(filePath, ...(args as []));
    }) as typeof nodeFs.readFileSync);

    try {
      expect(store.cleanupExpired()).toBe(0);
      expect(fs.existsSync(artifactPath)).toBe(true);
    } finally {
      read.mockRestore();
    }

    expect(store.loadAuthorized(stored.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    }).evidence_handle).toBe(stored.evidence_handle);
  });

  test('aborts an incomplete startup quota scan without deleting live evidence', () => {
    const first = new AssertEvidenceStore({
      rootDir,
      instanceId: 'scan-instance',
      maxOwnerArtifacts: 1,
    });
    const stored = persist(first);
    const artifactPath = path.join(rootDir, `${stored.evidence_handle}.json`);
    const second = new AssertEvidenceStore({
      rootDir,
      instanceId: 'scan-instance',
      maxOwnerArtifacts: 1,
    });
    const nodeFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const realReadFileSync = nodeFs.readFileSync.bind(nodeFs);
    const read = jest.spyOn(nodeFs, 'readFileSync').mockImplementation(((filePath, ...args: unknown[]) => {
      if (String(filePath) === artifactPath) {
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
      return realReadFileSync(filePath, ...(args as []));
    }) as typeof nodeFs.readFileSync);

    try {
      expect(() => persist(second)).toThrow(/EMFILE/);
      expect(fs.existsSync(artifactPath)).toBe(true);
    } finally {
      read.mockRestore();
    }

    expect(() => persist(second)).toThrow(
      expect.objectContaining<Partial<AssertEvidencePersistError>>({
        code: 'owner_quota_exceeded',
      }),
    );
  });

  test('deletes an artifact only after positively identifying corrupt JSON', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const corruptPath = path.join(rootDir, 'ev_00000000-0000-0000-0000-000000000000.json');
    fs.writeFileSync(corruptPath, '{not-json', 'utf8');

    expect(store.cleanupExpired()).toBe(1);
    expect(fs.existsSync(corruptPath)).toBe(false);
  });

  test('evicts only artifacts owned by the deleted session and tenant', () => {
    const store = new AssertEvidenceStore({ rootDir });
    const owned = persist(store);
    const other = persist(store, { sessionId: 'session-b' });
    const otherTenant = persist(store, { tenantId: 'tenant-b' });

    expect(store.evictSession('session-a', 'tenant-a')).toBe(1);
    expect(() => store.loadAuthorized(owned.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-a',
    })).toThrow(expect.objectContaining<Partial<AssertEvidenceStoreError>>({ code: 'not_found' }));
    expect(store.loadAuthorized(other.evidence_handle, {
      sessionId: 'session-b',
      tenantId: 'tenant-a',
    }).evidence_handle).toBe(other.evidence_handle);
    expect(store.loadAuthorized(otherTenant.evidence_handle, {
      sessionId: 'session-a',
      tenantId: 'tenant-b',
    }).evidence_handle).toBe(otherTenant.evidence_handle);
  });

  test('retains the artifact and quota index when session eviction cannot unlink it', () => {
    const store = new AssertEvidenceStore({ rootDir, maxOwnerArtifacts: 1 });
    const owned = persist(store);
    const artifactPath = path.join(rootDir, `${owned.evidence_handle}.json`);
    const nodeFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const realUnlinkSync = nodeFs.unlinkSync.bind(nodeFs);
    const unlink = jest.spyOn(nodeFs, 'unlinkSync').mockImplementation((filePath) => {
      if (String(filePath) === artifactPath) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(filePath);
    });

    try {
      expect(store.evictSession('session-a', 'tenant-a')).toBe(0);
      expect(fs.existsSync(artifactPath)).toBe(true);
      expect(() => persist(store)).toThrow(
        expect.objectContaining<Partial<AssertEvidencePersistError>>({
          code: 'owner_quota_exceeded',
        }),
      );
    } finally {
      unlink.mockRestore();
    }

    expect(store.evictSession('session-a', 'tenant-a')).toBe(1);
    expect(fs.existsSync(artifactPath)).toBe(false);
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
