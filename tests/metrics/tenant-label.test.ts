import {
  MAX_TENANT_LABEL_LEN,
  TENANT_UNKNOWN,
  isTenantLabelEnabled,
  normaliseTenantLabel,
  withTenantLabel,
} from '../../src/metrics/collector';
import { runWithRequestContext } from '../../src/observability/request-id';

describe('normaliseTenantLabel', () => {
  test('falls back to unknown for non-strings', () => {
    expect(normaliseTenantLabel(undefined)).toBe(TENANT_UNKNOWN);
    expect(normaliseTenantLabel(null)).toBe(TENANT_UNKNOWN);
    expect(normaliseTenantLabel(42)).toBe(TENANT_UNKNOWN);
  });

  test('strips disallowed characters', () => {
    expect(normaliseTenantLabel('t_acme-corp.io')).toBe('t_acmecorpio');
    expect(normaliseTenantLabel('  evil*value  ')).toBe('evilvalue');
  });

  test('empty after strip falls back to unknown', () => {
    expect(normaliseTenantLabel('---')).toBe(TENANT_UNKNOWN);
    expect(normaliseTenantLabel('')).toBe(TENANT_UNKNOWN);
  });

  test('enforces max length', () => {
    const long = 'a'.repeat(MAX_TENANT_LABEL_LEN + 20);
    const out = normaliseTenantLabel(long);
    expect(out.length).toBe(MAX_TENANT_LABEL_LEN);
  });
});

describe('withTenantLabel', () => {
  beforeEach(() => {
    delete process.env.OPENCHROME_TENANT_METRICS;
  });

  test('adds tenant=unknown when no context and no arg', () => {
    const out = withTenantLabel({ tool: 'navigate' });
    expect(out).toEqual({ tool: 'navigate', tenant: TENANT_UNKNOWN });
  });

  test('prefers explicit tenantId over context', () => {
    runWithRequestContext({ requestId: 'r', tenantId: 'ctx_tenant' }, () => {
      const out = withTenantLabel({ tool: 'navigate' }, 'explicit');
      expect(out.tenant).toBe('explicit');
    });
  });

  test('picks up tenantId from RequestContext', () => {
    runWithRequestContext({ requestId: 'r', tenantId: 't_acme' }, () => {
      const out = withTenantLabel({ tool: 'navigate' });
      expect(out.tenant).toBe('t_acme');
    });
  });

  test('OPENCHROME_TENANT_METRICS=false strips tenant label', () => {
    process.env.OPENCHROME_TENANT_METRICS = 'false';
    expect(isTenantLabelEnabled()).toBe(false);
    runWithRequestContext({ requestId: 'r', tenantId: 't_acme' }, () => {
      const out = withTenantLabel({ tool: 'navigate' });
      expect(out).toEqual({ tool: 'navigate' });
      expect(out.tenant).toBeUndefined();
    });
    delete process.env.OPENCHROME_TENANT_METRICS;
  });

  test('normalises tenantId when adding the label', () => {
    const out = withTenantLabel({ tool: 'x' }, 'evil*value');
    expect(out.tenant).toBe('evilvalue');
  });
});
