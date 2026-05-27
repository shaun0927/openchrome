/// <reference types="jest" />

/**
 * Tests for public-web.page-meta template (A2-PR2 of #1359).
 *
 * The template is data-only; tests pin:
 *   - identity (id, version, kebab-case, well-formed description)
 *   - schema format and required/optional field discrimination
 *   - registration round-trip through TemplateRegistry
 *   - portability: JSON-serializable
 */

import {
  PAGE_META_TEMPLATE,
  TemplateRegistry,
} from '../../../../src/contracts/templates';

describe('PAGE_META_TEMPLATE — identity', () => {
  test('id is "public-web.page-meta" and version is 1', () => {
    expect(PAGE_META_TEMPLATE.id).toBe('public-web.page-meta');
    expect(PAGE_META_TEMPLATE.version).toBe(1);
  });

  test('description is non-empty and starts with the task family', () => {
    expect(PAGE_META_TEMPLATE.description.length).toBeGreaterThan(10);
    expect(PAGE_META_TEMPLATE.description.toLowerCase()).toContain('page-level meta extraction');
  });

  test('tags include public-web and tier-1', () => {
    expect(PAGE_META_TEMPLATE.tags).toEqual(
      expect.arrayContaining(['public-web', 'meta', 'tier-1']),
    );
  });
});

describe('PAGE_META_TEMPLATE — schema shape', () => {
  test('targetSchema.format is schema-diff.v1', () => {
    expect(PAGE_META_TEMPLATE.targetSchema?.format).toBe('schema-diff.v1');
  });

  test('schema declares title/url/statusCode as required', () => {
    const def = PAGE_META_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string; required?: boolean }>;
    };
    const required = def.fields
      .filter((f) => f.required !== false)
      .map((f) => f.name);

    expect(required).toEqual(
      expect.arrayContaining(['title', 'url', 'statusCode']),
    );
  });

  test('description and og:* are optional', () => {
    const def = PAGE_META_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string; required?: boolean }>;
    };
    const optional = def.fields
      .filter((f) => f.required === false)
      .map((f) => f.name);

    expect(optional).toEqual(
      expect.arrayContaining([
        'description',
        'og.title',
        'og.description',
        'og.image',
        'og.type',
        'twitter.card',
      ]),
    );
  });

  test('every field declares a primitive JS-type bucket', () => {
    const def = PAGE_META_TEMPLATE.targetSchema?.definition as {
      fields: Array<{ name: string; type: string }>;
    };
    const allowed = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);
    for (const f of def.fields) {
      expect(allowed.has(f.type)).toBe(true);
    }
  });
});

describe('PAGE_META_TEMPLATE — portability', () => {
  test('round-trips through JSON without loss', () => {
    const copy = JSON.parse(JSON.stringify(PAGE_META_TEMPLATE));
    expect(copy).toEqual(PAGE_META_TEMPLATE);
  });
});

describe('PAGE_META_TEMPLATE — registry round-trip', () => {
  test('registers and resolves through TemplateRegistry', () => {
    const r = new TemplateRegistry();
    r.register(PAGE_META_TEMPLATE);

    expect(r.has('public-web.page-meta')).toBe(true);
    expect(r.has('public-web.page-meta', 1)).toBe(true);
    expect(r.get('public-web.page-meta')).toEqual(PAGE_META_TEMPLATE);
  });

  test('listing surfaces the public-web.page-meta entry with version 1 as latest', () => {
    const r = new TemplateRegistry();
    r.register(PAGE_META_TEMPLATE);

    expect(r.list()).toEqual([
      {
        id: 'public-web.page-meta',
        versions: [1],
        latest: 1,
        description: PAGE_META_TEMPLATE.description,
      },
    ]);
  });
});
