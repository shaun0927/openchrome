import { WorkspaceHandleRegistry, isWorkspaceHandle } from '../../src/mcp/workspace-handles';

const RUNTIME = '0123abcd-0000-4000-8000-000000000000';

describe('WorkspaceHandleRegistry', () => {
  test('mints unguessable handles bound to a tenant and runtime generation', () => {
    const registry = new WorkspaceHandleRegistry(RUNTIME, { idleTtlMs: 1_000 });
    const first = registry.open('tenant-a');
    const second = registry.open('tenant-a');
    expect(isWorkspaceHandle(first.handle)).toBe(true);
    expect(first.handle).toMatch(/^ocw_0123abcd_[A-Za-z0-9_-]{24}$/);
    expect(first.handle).not.toBe(second.handle);
    expect(first.browserSessionId).not.toBe(second.browserSessionId);
    expect(registry.resolve(first.handle, 'tenant-a')).toMatchObject({ ok: true, record: { browserSessionId: first.browserSessionId } });
  });

  test('rejects other tenants without disclosing the session', () => {
    const registry = new WorkspaceHandleRegistry(RUNTIME);
    const record = registry.open('tenant-a');
    const denied = registry.resolve(record.handle, 'tenant-b');
    expect(denied).toMatchObject({ ok: false, code: 'WORKSPACE_FORBIDDEN' });
    expect(JSON.stringify(denied)).not.toContain(record.browserSessionId);
  });

  test('distinguishes stale-runtime handles from unknown ones', () => {
    const current = new WorkspaceHandleRegistry(RUNTIME);
    const previous = new WorkspaceHandleRegistry('ffff0000-0000-4000-8000-000000000000');
    const old = previous.open('tenant-a');
    expect(current.resolve(old.handle, 'tenant-a')).toMatchObject({ ok: false, code: 'STALE_RUNTIME' });
    expect(current.resolve('ocw_0123abcd_forged', 'tenant-a')).toMatchObject({ ok: false, code: 'WORKSPACE_UNKNOWN' });
    expect(current.resolve('default', 'tenant-a')).toMatchObject({ ok: false, code: 'WORKSPACE_UNKNOWN' });
  });

  test('expires idle workspaces and slides the deadline on use', () => {
    let now = 1_000;
    const registry = new WorkspaceHandleRegistry(RUNTIME, { idleTtlMs: 100, now: () => now });
    const kept = registry.open('tenant-a');
    const dropped = registry.open('tenant-a');
    now += 80;
    expect(registry.resolve(kept.handle, 'tenant-a').ok).toBe(true);
    now += 80;
    expect(registry.resolve(kept.handle, 'tenant-a').ok).toBe(true);
    expect(registry.resolve(dropped.handle, 'tenant-a')).toMatchObject({ ok: false, code: 'WORKSPACE_EXPIRED' });
    expect(registry.resolve(dropped.handle, 'tenant-a')).toMatchObject({ ok: false, code: 'WORKSPACE_UNKNOWN' });
    now += 200;
    expect(registry.sweepExpired().map(record => record.handle)).toEqual([kept.handle]);
    expect(registry.list('tenant-a')).toEqual([]);
  });

  test('close revokes the handle and lists only the caller tenant', () => {
    const registry = new WorkspaceHandleRegistry(RUNTIME);
    const a = registry.open('tenant-a');
    registry.open('tenant-b');
    expect(registry.list('tenant-a').map(record => record.handle)).toEqual([a.handle]);
    expect(registry.close(a.handle, 'tenant-b')).toMatchObject({ ok: false, code: 'WORKSPACE_FORBIDDEN' });
    expect(registry.close(a.handle, 'tenant-a').ok).toBe(true);
    expect(registry.resolve(a.handle, 'tenant-a')).toMatchObject({ ok: false, code: 'WORKSPACE_UNKNOWN' });
    expect(registry.findByBrowserSession(a.browserSessionId)).toBeUndefined();
  });
});
