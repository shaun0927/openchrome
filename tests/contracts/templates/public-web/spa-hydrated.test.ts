/// <reference types="jest" />

/**
 * Tests for public-web.spa-hydrated template (A2-PR3 of #1359).
 */

import {
  SPA_HYDRATED_TEMPLATE,
  TemplateRegistry,
} from '../../../../src/contracts/templates';

describe('SPA_HYDRATED_TEMPLATE — identity', () => {
  test('id is "public-web.spa-hydrated" and version is 1', () => {
    expect(SPA_HYDRATED_TEMPLATE.id).toBe('public-web.spa-hydrated');
    expect(SPA_HYDRATED_TEMPLATE.version).toBe(1);
  });

  test('description mentions single-page-app extraction and hydration', () => {
    expect(SPA_HYDRATED_TEMPLATE.description.toLowerCase()).toContain('single-page');
    expect(SPA_HYDRATED_TEMPLATE.description.toLowerCase()).toContain('hydration');
  });

  test('tags include public-web, spa, dynamic, tier-1', () => {
    expect(SPA_HYDRATED_TEMPLATE.tags).toEqual(
      expect.arrayContaining(['public-web', 'spa', 'dynamic', 'tier-1']),
    );
  });
});

describe('SPA_HYDRATED_TEMPLATE — schema shape', () => {
  test('targetSchema.format is schema-diff.v1', () => {
    expect(SPA_HYDRATED_TEMPLATE.targetSchema?.format).toBe('schema-diff.v1');
  });

  test('required fields include identity + mainContent characterization + readiness', () => {
    const def = SPA_HYDRATED_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string; required?: boolean }>;
    };
    const required = def.fields
      .filter((f) => f.required !== false)
      .map((f) => f.name);

    expect(required).toEqual(
      expect.arrayContaining([
        'title',
        'url',
        'route',
        'mainContent.length',
        'mainContent.hasHeadings',
        'readiness.domStable',
        'readiness.framework',
      ]),
    );
  });

  test('description / structuredData / og.* are optional', () => {
    const def = SPA_HYDRATED_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string; required?: boolean }>;
    };
    const optional = def.fields
      .filter((f) => f.required === false)
      .map((f) => f.name);

    expect(optional).toEqual(
      expect.arrayContaining([
        'description',
        'structuredData',
        'structuredData.count',
        'og.title',
        'og.description',
        'og.image',
        'twitter.card',
      ]),
    );
  });

  test('mainContent NEVER appears as raw text in the schema (only characterizations)', () => {
    // Per the design note: ship features the host can diff, not raw
    // content that changes every run.
    const def = SPA_HYDRATED_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string }>;
    };
    const names = def.fields.map((f) => f.name);
    expect(names).not.toContain('mainContent');
    expect(names).not.toContain('mainContent.text');
    expect(names).not.toContain('mainContent.html');
  });

  test('every field declares a primitive JS-type bucket', () => {
    const def = SPA_HYDRATED_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ type: string }>;
    };
    const allowed = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);
    for (const f of def.fields) {
      expect(allowed.has(f.type)).toBe(true);
    }
  });

  test('readiness.domStable is the explicit hydration-completed signal', () => {
    const def = SPA_HYDRATED_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string; required?: boolean }>;
    };
    const field = def.fields.find((f) => f.name === 'readiness.domStable');
    expect(field).toBeDefined();
    expect(field?.type).toBe('boolean');
    expect(field?.required).not.toBe(false);
  });
});

describe('SPA_HYDRATED_TEMPLATE — portability and registry', () => {
  test('round-trips through JSON without loss', () => {
    const copy = JSON.parse(JSON.stringify(SPA_HYDRATED_TEMPLATE));
    expect(copy).toEqual(SPA_HYDRATED_TEMPLATE);
  });

  test('coexists with public-web.page-meta in the registry without id collision', async () => {
    const { PAGE_META_TEMPLATE } = await import(
      '../../../../src/contracts/templates'
    );
    const r = new TemplateRegistry();
    r.register(PAGE_META_TEMPLATE);
    r.register(SPA_HYDRATED_TEMPLATE);

    expect(r.size()).toBe(2);
    expect(r.has('public-web.page-meta')).toBe(true);
    expect(r.has('public-web.spa-hydrated')).toBe(true);
    expect(r.get('public-web.spa-hydrated')?.version).toBe(1);
  });
});
