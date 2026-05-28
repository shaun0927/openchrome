/// <reference types="jest" />

import {
  classify,
  diffAgainstSchema,
  SchemaDefinition,
} from '../../../src/core/contracts/schema-diff';

describe('classify', () => {
  test('maps each JS shape to the declared bucket', () => {
    expect(classify('hello')).toBe('string');
    expect(classify(42)).toBe('number');
    expect(classify(true)).toBe('boolean');
    expect(classify(null)).toBe('null');
    expect(classify([])).toBe('array');
    expect(classify({})).toBe('object');
  });

  test('untracked JS shapes collapse to null bucket', () => {
    expect(classify(undefined)).toBe('null');
    expect(classify(() => 0)).toBe('null');
    expect(classify(Symbol('x'))).toBe('null');
  });
});

describe('diffAgainstSchema', () => {
  test('empty schema yields vacuous full coverage and empty arrays', () => {
    const schema: SchemaDefinition = { version: 1, fields: [] };
    const diff = diffAgainstSchema(schema, { title: 'irrelevant' });
    expect(diff).toEqual({
      matched: [],
      missing: [],
      extra: ['title'],
      typeMismatch: [],
      coverage: 1,
    });
  });

  test('full match yields coverage 1 and listed matched fields', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'statusCode', type: 'number' },
        { name: 'ok', type: 'boolean' },
      ],
    };
    const diff = diffAgainstSchema(schema, {
      title: 'Example',
      statusCode: 200,
      ok: true,
    });
    expect(diff.matched).toEqual(['title', 'statusCode', 'ok']);
    expect(diff.missing).toEqual([]);
    expect(diff.typeMismatch).toEqual([]);
    expect(diff.coverage).toBe(1);
  });

  test('missing required fields are reported and lower coverage', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'description', type: 'string' },
        { name: 'statusCode', type: 'number' },
      ],
    };
    const diff = diffAgainstSchema(schema, { title: 'Only title' });
    expect(diff.matched).toEqual(['title']);
    expect(diff.missing).toEqual(['description', 'statusCode']);
    expect(diff.coverage).toBeCloseTo(1 / 3);
  });

  test('optional missing fields do not appear in missing or denominator', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'preview', type: 'string', required: false },
      ],
    };
    const diff = diffAgainstSchema(schema, { title: 'x' });
    expect(diff.matched).toEqual(['title']);
    expect(diff.missing).toEqual([]);
    expect(diff.coverage).toBe(1);
  });

  test('type mismatches do not count as matched and are itemized', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'statusCode', type: 'number' },
      ],
    };
    const diff = diffAgainstSchema(schema, {
      title: 'ok',
      statusCode: '200',
    });
    expect(diff.matched).toEqual(['title']);
    expect(diff.missing).toEqual([]);
    expect(diff.typeMismatch).toEqual([
      { field: 'statusCode', expected: 'number', got: 'string' },
    ]);
    expect(diff.coverage).toBe(0.5);
  });

  test('null is its own type bucket distinct from object', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'meta', type: 'object' },
        { name: 'parent', type: 'null' },
      ],
    };
    const diff = diffAgainstSchema(schema, { meta: null, parent: null });
    expect(diff.matched).toEqual(['parent']);
    expect(diff.typeMismatch).toEqual([
      { field: 'meta', expected: 'object', got: 'null' },
    ]);
  });

  test('array bucket is distinct from object', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [{ name: 'items', type: 'array' }],
    };
    expect(diffAgainstSchema(schema, { items: [] }).matched).toEqual(['items']);
    expect(diffAgainstSchema(schema, { items: {} }).typeMismatch).toEqual([
      { field: 'items', expected: 'array', got: 'object' },
    ]);
  });

  test('dot-path nested fields resolve through plain objects', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'user.email', type: 'string' },
        { name: 'user.profile.handle', type: 'string' },
      ],
    };
    const diff = diffAgainstSchema(schema, {
      user: { email: 'a@b.c', profile: { handle: 'aa' } },
    });
    expect(diff.matched).toEqual(['user.email', 'user.profile.handle']);
    expect(diff.coverage).toBe(1);
  });

  test('dot-path through a non-object yields missing, not throw', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [{ name: 'user.email', type: 'string' }],
    };
    expect(() => diffAgainstSchema(schema, { user: 'not-an-object' })).not.toThrow();
    const diff = diffAgainstSchema(schema, { user: 'not-an-object' });
    expect(diff.missing).toEqual(['user.email']);
    expect(diff.matched).toEqual([]);
  });

  test('extra reports top-level observed keys not declared in the schema', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [{ name: 'title', type: 'string' }],
    };
    const diff = diffAgainstSchema(schema, {
      title: 'ok',
      description: 'extra-1',
      ssr: true,
    });
    expect(diff.extra).toEqual(['description', 'ssr']);
  });

  test('extra is the top-level slice only — nested unknowns are silent', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [{ name: 'user.email', type: 'string' }],
    };
    const diff = diffAgainstSchema(schema, {
      user: { email: 'a@b.c', surprise: 1 },
    });
    expect(diff.extra).toEqual([]);
  });

  test('non-object observed roots are tolerated', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [{ name: 'title', type: 'string' }],
    };
    expect(diffAgainstSchema(schema, null).missing).toEqual(['title']);
    expect(diffAgainstSchema(schema, 'string-root').missing).toEqual(['title']);
    expect(diffAgainstSchema(schema, []).missing).toEqual(['title']);
    expect(diffAgainstSchema(schema, []).extra).toEqual([]);
  });

  test('output is deterministic — repeated calls produce identical structures', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'url', type: 'string' },
        { name: 'meta.lang', type: 'string', required: false },
      ],
    };
    const observed = { title: 't', url: 'u', meta: { lang: 'en' }, other: 1 };
    const a = diffAgainstSchema(schema, observed);
    const b = diffAgainstSchema(schema, observed);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('matched/missing follow schema declaration order; extra is sorted', () => {
    const schema: SchemaDefinition = {
      version: 1,
      fields: [
        { name: 'b', type: 'string' },
        { name: 'a', type: 'string' },
      ],
    };
    const diff = diffAgainstSchema(schema, { a: 'A', b: 'B', z: 1, k: 2 });
    expect(diff.matched).toEqual(['b', 'a']);
    expect(diff.extra).toEqual(['k', 'z']);
  });
});
