/// <reference types="jest" />

import * as http from 'node:http';
import * as net from 'node:net';
import { IncomingMessage } from 'node:http';
import { HTTPTransport } from '../../src/transports/http';
import { authorizeDashboardEndpoint } from '../../src/middleware/dashboard-authz';
import { requestPrincipals, PRINCIPAL_SYM } from '../../src/middleware/auth';
import type { Principal, Scope } from '../../src/auth/api-key-types';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('No port assigned')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

type ResponseTuple = { status: number; body: string; headers: http.IncomingHttpHeaders };

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<ResponseTuple> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        body: Buffer.concat(chunks).toString(),
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fakeStore(records: Record<string, { tenantId: string; scopes: Scope[] }>) {
  return {
    verify: jest.fn(async (token: string) => {
      const record = records[token];
      if (!record) return null;
      return {
        keyId: `k_${record.tenantId}`,
        keyHash: 'hash',
        tenantId: record.tenantId,
        scopes: record.scopes,
        createdAt: Date.now(),
        description: 'test',
      };
    }),
    touchLastUsed: jest.fn(async () => undefined),
  };
}

function sessionManager(extras: { defaultTenantId?: string } = {}) {
  const sessions = new Map<string, { id: string; tenantId: string }>([
    ['alpha-session', { id: 'alpha-session', tenantId: 'alpha' }],
    ['beta-session', { id: 'beta-session', tenantId: 'beta' }],
  ]);
  if (extras.defaultTenantId) {
    sessions.set('default', { id: 'default', tenantId: extras.defaultTenantId });
  }
  return {
    getAllSessionInfos: jest.fn(() => [
      {
        id: 'alpha-session',
        name: 'Alpha',
        targetCount: 0,
        workerCount: 0,
        workers: [],
        createdAt: 1,
        lastActivityAt: 2,
        tenantId: 'alpha',
      },
      {
        id: 'beta-session',
        name: 'Beta',
        targetCount: 0,
        workerCount: 0,
        workers: [],
        createdAt: 3,
        lastActivityAt: 4,
        tenantId: 'beta',
      },
    ]),
    getSession: jest.fn((id: string) => sessions.get(id)),
    getStats: jest.fn(() => ({ totalTargets: 0, activeSessions: 2 })),
  };
}

async function boot(
  authToken?: string,
  store?: ReturnType<typeof fakeStore>,
  smOverrides: { defaultTenantId?: string } = {},
) {
  const port = await freePort();
  const transport = new HTTPTransport(port, '127.0.0.1', authToken, store ? { apiKeyStore: store as never } : {});
  transport.setSessionManager(sessionManager(smOverrides) as never);
  transport.onMessage(async (msg: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : 0,
    result: { ok: true },
  }));
  transport.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { port, transport };
}

describe('dashboard REST authorization', () => {
  let transport: InstanceType<typeof HTTPTransport> | undefined;
  const readAlpha = 'oc_live_alpha_read';
  const adminAlpha = 'oc_live_alpha_admin';

  afterEach(async () => {
    if (transport) await transport.close();
    transport = undefined;
  });

  it('returns 401 for dashboard REST endpoints when auth is configured but missing', async () => {
    const booted = await boot('shared-secret');
    transport = booted.transport;

    const res = await request(booted.port, '/api/sessions');

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('keeps disabled auth backward-compatible for dashboard REST', async () => {
    const booted = await boot();
    transport = booted.transport;

    const res = await request(booted.port, '/api/metrics');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).session_count).toBe(2);
  });

  it('reports per-tenant metrics counts to tenant-scoped admins', async () => {
    const booted = await boot(undefined, fakeStore({ [adminAlpha]: { tenantId: 'alpha', scopes: ['admin'] } }));
    transport = booted.transport;

    const res = await request(booted.port, '/api/metrics', { Authorization: `Bearer ${adminAlpha}` });

    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    // Two sessions exist globally (alpha, beta); the alpha admin must only see one.
    expect(data.session_count).toBe(1);
    expect(data.tab_count).toBe(0);
  });

  it('allows read-scoped session listing but omits other-tenant sessions', async () => {
    const booted = await boot(undefined, fakeStore({ [readAlpha]: { tenantId: 'alpha', scopes: ['read'] } }));
    transport = booted.transport;

    const res = await request(booted.port, '/api/sessions', { Authorization: `Bearer ${readAlpha}` });

    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.sessions.map((s: { id: string }) => s.id)).toEqual(['alpha-session']);
    expect(JSON.stringify(data)).not.toContain('beta-session');
  });

  it('requires admin for tool-call and global metrics endpoints', async () => {
    const booted = await boot(undefined, fakeStore({
      [readAlpha]: { tenantId: 'alpha', scopes: ['read'] },
      [adminAlpha]: { tenantId: 'alpha', scopes: ['admin'] },
    }));
    transport = booted.transport;

    const readToolCalls = await request(booted.port, '/api/tool-calls', { Authorization: `Bearer ${readAlpha}` });
    const readMetrics = await request(booted.port, '/api/metrics', { Authorization: `Bearer ${readAlpha}` });
    const adminToolCalls = await request(booted.port, '/api/tool-calls', { Authorization: `Bearer ${adminAlpha}` });
    const adminMetrics = await request(booted.port, '/api/metrics', { Authorization: `Bearer ${adminAlpha}` });

    expect(readToolCalls.status).toBe(403);
    expect(JSON.parse(readToolCalls.body)).toEqual({ error: 'Forbidden' });
    expect(readMetrics.status).toBe(403);
    expect(adminToolCalls.status).toBe(200);
    expect(adminMetrics.status).toBe(200);
  });

  it('rejects cross-tenant requested screenshots without leaking session details', async () => {
    const booted = await boot(undefined, fakeStore({ [readAlpha]: { tenantId: 'alpha', scopes: ['read'] } }));
    transport = booted.transport;

    const res = await request(booted.port, '/api/screenshot?session_id=beta-session', {
      Authorization: `Bearer ${readAlpha}`,
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
    expect(res.body).not.toContain('beta-session');
  });

  it('blocks default-session screenshots when the default belongs to another tenant', async () => {
    const booted = await boot(
      undefined,
      fakeStore({ [readAlpha]: { tenantId: 'alpha', scopes: ['read'] } }),
      { defaultTenantId: 'beta' },
    );
    transport = booted.transport;

    const res = await request(booted.port, '/api/screenshot', {
      Authorization: `Bearer ${readAlpha}`,
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
  });

  it('hides cross-tenant tool calls from tenant-scoped admins listing without session_id', async () => {
    const booted = await boot(
      undefined,
      fakeStore({ [adminAlpha]: { tenantId: 'alpha', scopes: ['admin'] } }),
    );
    transport = booted.transport;

    const { getDashboardState } = await import('../../src/desktop/dashboard-state');
    const state = getDashboardState();
    state.recordToolStart('alpha-session', 'navigate', { url: 'https://alpha.example' }, 'call-alpha');
    state.recordToolStart('beta-session', 'navigate', { url: 'https://beta.example' }, 'call-beta');

    try {
      const res = await request(booted.port, '/api/tool-calls', {
        Authorization: `Bearer ${adminAlpha}`,
      });

      expect(res.status).toBe(200);
      const data = JSON.parse(res.body) as { calls: Array<{ id: string; sessionId: string }> };
      const ids = data.calls.map((c) => c.id);
      expect(ids).toContain('call-alpha');
      expect(ids).not.toContain('call-beta');
    } finally {
      state.recordToolEnd('call-alpha', 'success');
      state.recordToolEnd('call-beta', 'success');
    }
  });

  it('rejects tool-call requests targeting another tenant\'s session', async () => {
    const booted = await boot(
      undefined,
      fakeStore({ [adminAlpha]: { tenantId: 'alpha', scopes: ['admin'] } }),
    );
    transport = booted.transport;

    const res = await request(booted.port, '/api/tool-calls?session_id=beta-session', {
      Authorization: `Bearer ${adminAlpha}`,
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
  });
});

describe('dashboard REST principal trust boundary', () => {
  it('uses requestPrincipals instead of forgeable request fields', () => {
    const req = new IncomingMessage(null as never) as IncomingMessage & {
      __principal?: Principal;
      [PRINCIPAL_SYM]?: Principal;
    };
    req.__principal = { tenantId: 'attacker', scopes: ['admin'], mode: 'api-key' };
    req[PRINCIPAL_SYM] = { tenantId: 'attacker', scopes: ['admin'], mode: 'api-key' };
    requestPrincipals.set(req, { tenantId: 'alpha', scopes: ['read'], mode: 'api-key' });

    const result = authorizeDashboardEndpoint(req, 'metrics');

    expect(result).toEqual({ ok: false, status: 403, error: 'Forbidden' });
  });
});
