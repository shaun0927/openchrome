import { isDeepStrictEqual } from 'util';

export type SchemaSeverity = 'error' | 'warning';

export interface SchemaDiagnostic {
  severity: SchemaSeverity;
  code: string;
  instancePath: string;
  schemaPath: string;
  message: string;
}

export type JsonSchema = boolean | Record<string, unknown>;

const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'boolean' || isRecord(value);
}

function appendPointer(base: string, token: string | number): string {
  const escaped = String(token).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${base}/${escaped}`;
}

function diagnostic(
  severity: SchemaSeverity,
  code: string,
  instancePath: string,
  schemaPath: string,
  message: string,
): SchemaDiagnostic {
  return { severity, code, instancePath, schemaPath, message };
}

function hasErrors(diagnostics: SchemaDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === 'error');
}

function schemaBranches(value: unknown): JsonSchema[] | undefined {
  if (!Array.isArray(value) || !value.every(isSchema)) return undefined;
  return value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isRecord(value);
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  instancePath: string,
  schemaPath: string,
): SchemaDiagnostic[] {
  if (schema === true) return [];
  if (schema === false) {
    return [diagnostic(
      'error',
      'schema.false',
      instancePath,
      schemaPath,
      'Value is rejected by the registered schema.',
    )];
  }

  const diagnostics: SchemaDiagnostic[] = [];

  const oneOf = schemaBranches(schema.oneOf);
  if (oneOf) {
    const branchResults = oneOf.map((branch, index) => validateNode(
      value,
      branch,
      instancePath,
      appendPointer(appendPointer(schemaPath, 'oneOf'), index),
    ));
    const passing = branchResults.filter((result) => !hasErrors(result));
    if (passing.length !== 1) {
      diagnostics.push(diagnostic(
        'error',
        'schema.one_of',
        instancePath,
        appendPointer(schemaPath, 'oneOf'),
        'Value must match exactly one registered schema branch.',
      ));
    } else {
      diagnostics.push(...passing[0].filter((entry) => entry.severity === 'warning'));
    }
  }

  const anyOf = schemaBranches(schema.anyOf);
  if (anyOf) {
    const branchResults = anyOf.map((branch, index) => validateNode(
      value,
      branch,
      instancePath,
      appendPointer(appendPointer(schemaPath, 'anyOf'), index),
    ));
    const passing = branchResults.find((result) => !hasErrors(result));
    if (!passing) {
      diagnostics.push(diagnostic(
        'error',
        'schema.any_of',
        instancePath,
        appendPointer(schemaPath, 'anyOf'),
        'Value must match at least one registered schema branch.',
      ));
    } else {
      diagnostics.push(...passing.filter((entry) => entry.severity === 'warning'));
    }
  }

  const allOf = schemaBranches(schema.allOf);
  if (allOf) {
    for (let index = 0; index < allOf.length; index++) {
      diagnostics.push(...validateNode(
        value,
        allOf[index],
        instancePath,
        appendPointer(appendPointer(schemaPath, 'allOf'), index),
      ));
    }
  }

  const declaredTypes = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((entry): entry is string => typeof entry === 'string')
      : [];
  const supportedTypes = declaredTypes.filter((type) => JSON_SCHEMA_TYPES.has(type));
  if (declaredTypes.length > 0 && !supportedTypes.some((type) => matchesType(value, type))) {
    diagnostics.push(diagnostic(
      'error',
      'schema.type',
      instancePath,
      appendPointer(schemaPath, 'type'),
      'Value has the wrong type for the registered schema.',
    ));
    return diagnostics;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    diagnostics.push(diagnostic(
      'error',
      'schema.enum',
      instancePath,
      appendPointer(schemaPath, 'enum'),
      'Value is not one of the allowed registered schema choices.',
    ));
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !isDeepStrictEqual(schema.const, value)) {
    diagnostics.push(diagnostic(
      'error',
      'schema.const',
      instancePath,
      appendPointer(schemaPath, 'const'),
      'Value does not match the registered schema constant.',
    ));
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      diagnostics.push(diagnostic(
        'error',
        'schema.minimum',
        instancePath,
        appendPointer(schemaPath, 'minimum'),
        'Number is below the registered schema minimum.',
      ));
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      diagnostics.push(diagnostic(
        'error',
        'schema.maximum',
        instancePath,
        appendPointer(schemaPath, 'maximum'),
        'Number exceeds the registered schema maximum.',
      ));
    }
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      diagnostics.push(diagnostic(
        'error',
        'schema.min_length',
        instancePath,
        appendPointer(schemaPath, 'minLength'),
        'String is shorter than the registered schema minimum length.',
      ));
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      diagnostics.push(diagnostic(
        'error',
        'schema.max_length',
        instancePath,
        appendPointer(schemaPath, 'maxLength'),
        'String exceeds the registered schema maximum length.',
      ));
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          diagnostics.push(diagnostic(
            'error',
            'schema.pattern',
            instancePath,
            appendPointer(schemaPath, 'pattern'),
            'String does not match the registered schema pattern.',
          ));
        }
      } catch {
        // Invalid schema patterns are outside playbook validation scope.
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      diagnostics.push(diagnostic(
        'error',
        'schema.min_items',
        instancePath,
        appendPointer(schemaPath, 'minItems'),
        'Array has fewer items than the registered schema minimum.',
      ));
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      diagnostics.push(diagnostic(
        'error',
        'schema.max_items',
        instancePath,
        appendPointer(schemaPath, 'maxItems'),
        'Array has more items than the registered schema maximum.',
      ));
    }
    if (isSchema(schema.items)) {
      for (let index = 0; index < value.length; index++) {
        diagnostics.push(...validateNode(
          value[index],
          schema.items,
          appendPointer(instancePath, index),
          appendPointer(schemaPath, 'items'),
        ));
      }
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [];

    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        diagnostics.push(diagnostic(
          'error',
          'schema.required',
          appendPointer(instancePath, key),
          appendPointer(schemaPath, 'required'),
          'Required property is missing from the expanded tool arguments.',
        ));
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && isSchema(propertySchema)) {
        diagnostics.push(...validateNode(
          value[key],
          propertySchema,
          appendPointer(instancePath, key),
          appendPointer(appendPointer(schemaPath, 'properties'), key),
        ));
      }
    }

    const extraKeys = Object.keys(value)
      .filter((key) => !Object.prototype.hasOwnProperty.call(properties, key))
      .sort();
    for (const key of extraKeys) {
      const additional = schema.additionalProperties;
      if (additional === false) {
        diagnostics.push(diagnostic(
          'error',
          'schema.additional_property',
          appendPointer(instancePath, key),
          appendPointer(schemaPath, 'additionalProperties'),
          'Property is not allowed by the registered schema.',
        ));
      } else if (isSchema(additional) && additional !== true) {
        diagnostics.push(...validateNode(
          value[key],
          additional,
          appendPointer(instancePath, key),
          appendPointer(schemaPath, 'additionalProperties'),
        ));
      } else {
        diagnostics.push(diagnostic(
          'warning',
          'schema.additional_property_open',
          appendPointer(instancePath, key),
          appendPointer(schemaPath, 'additionalProperties'),
          'Property is not declared by the registered schema, which allows additional properties.',
        ));
      }
    }
  }

  return diagnostics;
}

export function validateValueAgainstSchema(value: unknown, schema: JsonSchema): SchemaDiagnostic[] {
  return validateNode(value, schema, '', '');
}
