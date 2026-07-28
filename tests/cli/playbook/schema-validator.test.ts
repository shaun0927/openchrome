/// <reference types="jest" />

import { validateValueAgainstSchema } from '../../../cli/playbook/schema-validator';

describe('validateValueAgainstSchema', () => {
  test('validates required fields, primitive types, and integer semantics', () => {
    const diagnostics = validateValueAgainstSchema(
      { count: 1.5 },
      {
        type: 'object',
        properties: {
          url: { type: 'string' },
          count: { type: 'integer' },
        },
        required: ['url', 'count'],
        additionalProperties: false,
      },
    );

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'schema.required', instancePath: '/url', severity: 'error' }),
      expect.objectContaining({ code: 'schema.type', instancePath: '/count', severity: 'error' }),
    ]));
  });

  test('supports type arrays, enum, and const without echoing values', () => {
    expect(validateValueAgainstSchema(null, { type: ['string', 'null'] })).toEqual([]);

    const enumDiagnostics = validateValueAgainstSchema('private-token', {
      type: 'string',
      enum: ['public'],
    });
    const constDiagnostics = validateValueAgainstSchema('private-token', {
      const: 'public',
    });

    expect(enumDiagnostics).toEqual([
      expect.objectContaining({ code: 'schema.enum', severity: 'error' }),
    ]);
    expect(constDiagnostics).toEqual([
      expect.objectContaining({ code: 'schema.const', severity: 'error' }),
    ]);
    expect(JSON.stringify([...enumDiagnostics, ...constDiagnostics])).not.toContain('private-token');
  });

  test('validates numeric and string bounds plus patterns', () => {
    const diagnostics = validateValueAgainstSchema(
      { score: 11, label: 'x' },
      {
        type: 'object',
        properties: {
          score: { type: 'number', minimum: 0, maximum: 10 },
          label: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[A-Z]+$' },
        },
        additionalProperties: false,
      },
    );

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'schema.maximum',
      'schema.min_length',
      'schema.pattern',
    ]);
  });

  test('validates array bounds and item schemas', () => {
    const diagnostics = validateValueAgainstSchema(
      [1, 2.5, 3],
      {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'integer' },
      },
    );

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'schema.max_items', instancePath: '' }),
      expect.objectContaining({ code: 'schema.type', instancePath: '/1' }),
    ]));
  });

  test('warns for open additional properties', () => {
    const diagnostics = validateValueAgainstSchema(
      { known: 'ok', extra: 'allowed' },
      {
        type: 'object',
        properties: { known: { type: 'string' } },
      },
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'schema.additional_property_open',
        instancePath: '/extra',
        severity: 'warning',
      }),
    ]);
  });

  test('rejects closed additional properties', () => {
    const diagnostics = validateValueAgainstSchema(
      { extra: true },
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'schema.additional_property',
        instancePath: '/extra',
        severity: 'error',
      }),
    ]);
  });

  test('validates schema-valued additional properties', () => {
    const diagnostics = validateValueAgainstSchema(
      { first: 'ok', second: 2 },
      {
        type: 'object',
        properties: {},
        additionalProperties: { type: 'string' },
      },
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'schema.type', instancePath: '/second', severity: 'error' }),
    ]);
  });

  test('supports oneOf, anyOf, and allOf', () => {
    expect(validateValueAgainstSchema('Alpha', {
      oneOf: [
        { type: 'string', pattern: '^A' },
        { type: 'number' },
      ],
    })).toEqual([]);

    expect(validateValueAgainstSchema('Alpha', {
      anyOf: [
        { type: 'number' },
        { type: 'string', minLength: 3 },
      ],
    })).toEqual([]);

    expect(validateValueAgainstSchema('Alpha', {
      allOf: [
        { type: 'string' },
        { minLength: 3 },
        { maxLength: 8 },
      ],
    })).toEqual([]);

    expect(validateValueAgainstSchema('Alpha', {
      oneOf: [{ type: 'string' }, { minLength: 1 }],
    })).toEqual([
      expect.objectContaining({ code: 'schema.one_of', severity: 'error' }),
    ]);

    expect(validateValueAgainstSchema(false, {
      anyOf: [{ type: 'string' }, { type: 'number' }],
    })).toEqual([
      expect.objectContaining({ code: 'schema.any_of', severity: 'error' }),
    ]);

    expect(validateValueAgainstSchema('Alpha', {
      allOf: [
        { type: 'string', minLength: 3 },
        { pattern: '^Beta$' },
      ],
    })).toEqual([
      expect.objectContaining({
        code: 'schema.pattern',
        schemaPath: '/allOf/1/pattern',
        severity: 'error',
      }),
    ]);
  });

  test('ignores unsupported schema keywords', () => {
    expect(validateValueAgainstSchema('anything', {
      type: 'string',
      format: 'uri-template',
      unevaluatedProperties: false,
    })).toEqual([]);
  });
});
