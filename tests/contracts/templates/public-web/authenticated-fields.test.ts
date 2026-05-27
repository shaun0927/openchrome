/// <reference types="jest" />

/**
 * Tests for public-web.authenticated-fields template (A2-PR5 of #1359).
 */

import {
  AUTHENTICATED_FIELDS_TEMPLATE,
  PAGE_META_TEMPLATE,
  SPA_HYDRATED_TEMPLATE,
  LINK_GRAPH_TEMPLATE,
  TemplateRegistry,
} from '../../../../src/contracts/templates';

describe('AUTHENTICATED_FIELDS_TEMPLATE — identity', () => {
  test('id is "public-web.authenticated-fields" and version is 1', () => {
    expect(AUTHENTICATED_FIELDS_TEMPLATE.id).toBe('public-web.authenticated-fields');
    expect(AUTHENTICATED_FIELDS_TEMPLATE.version).toBe(1);
  });

  test('description mentions post-authentication and profile-field extraction', () => {
    expect(AUTHENTICATED_FIELDS_TEMPLATE.description.toLowerCase()).toContain('post-authentication');
    expect(AUTHENTICATED_FIELDS_TEMPLATE.description.toLowerCase()).toContain('profile-field');
  });

  test('tags include auth + profile + tier-2', () => {
    expect(AUTHENTICATED_FIELDS_TEMPLATE.tags).toEqual(
      expect.arrayContaining(['public-web', 'auth', 'profile', 'tier-2']),
    );
  });
});

describe('AUTHENTICATED_FIELDS_TEMPLATE — schema shape', () => {
  test('targetSchema.format is schema-diff.v1', () => {
    expect(AUTHENTICATED_FIELDS_TEMPLATE.targetSchema?.format).toBe('schema-diff.v1');
  });

  test('required fields cover auth posture, gate fact, core profile, url', () => {
    const def = AUTHENTICATED_FIELDS_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string; required?: boolean }>;
    };
    const required = def.fields
      .filter((f) => f.required !== false)
      .map((f) => f.name);

    expect(required).toEqual(
      expect.arrayContaining([
        'authenticated',
        'authMethod',
        'gate.detected',
        'profile.userId',
        'profile.displayName',
        'profile.email',
        'url',
      ]),
    );
  });

  test('gate.kind / gate.gateType are optional (absent when no gate)', () => {
    const def = AUTHENTICATED_FIELDS_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; required?: boolean }>;
    };
    const optional = def.fields
      .filter((f) => f.required === false)
      .map((f) => f.name);

    expect(optional).toEqual(
      expect.arrayContaining(['gate.kind', 'gate.gateType']),
    );
  });

  test('profile enrichments (emailVerified, plan, avatarUrl, locale) are optional', () => {
    const def = AUTHENTICATED_FIELDS_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; required?: boolean }>;
    };
    const optional = def.fields
      .filter((f) => f.required === false)
      .map((f) => f.name);

    expect(optional).toEqual(
      expect.arrayContaining([
        'profile.emailVerified',
        'profile.plan',
        'profile.avatarUrl',
        'profile.locale',
      ]),
    );
  });

  test('authenticated is a boolean discriminator', () => {
    const def = AUTHENTICATED_FIELDS_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string }>;
    };
    const field = def.fields.find((f) => f.name === 'authenticated');
    expect(field?.type).toBe('boolean');
  });

  test('schema NEVER bundles credentials, tokens, or solver keys', () => {
    const def = AUTHENTICATED_FIELDS_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string }>;
    };
    const banned = ['password', 'token', 'apiKey', 'api_key', 'secret', 'credential'];
    for (const f of def.fields) {
      const lower = f.name.toLowerCase();
      for (const b of banned) {
        expect(lower).not.toContain(b);
      }
    }
  });

  test('every field declares a primitive JS-type bucket', () => {
    const def = AUTHENTICATED_FIELDS_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ type: string }>;
    };
    const allowed = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);
    for (const f of def.fields) {
      expect(allowed.has(f.type)).toBe(true);
    }
  });
});

describe('AUTHENTICATED_FIELDS_TEMPLATE — portability and registry', () => {
  test('round-trips through JSON without loss', () => {
    const copy = JSON.parse(JSON.stringify(AUTHENTICATED_FIELDS_TEMPLATE));
    expect(copy).toEqual(AUTHENTICATED_FIELDS_TEMPLATE);
  });

  test('coexists with all other public-web templates in the registry', () => {
    const r = new TemplateRegistry();
    r.register(PAGE_META_TEMPLATE);
    r.register(SPA_HYDRATED_TEMPLATE);
    r.register(LINK_GRAPH_TEMPLATE);
    r.register(AUTHENTICATED_FIELDS_TEMPLATE);

    expect(r.size()).toBe(4);
    expect(r.list().map((e) => e.id)).toEqual([
      'public-web.authenticated-fields',
      'public-web.link-graph',
      'public-web.page-meta',
      'public-web.spa-hydrated',
    ]);
  });
});
