/**
 * Lightweight JSON Schema Validator
 * No external dependencies.
 */

export interface SchemaProperty {
  type?: string | string[];
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
  required?: string[];
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

export interface ExtractionSchema {
  type: 'object' | 'array';
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
  required?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSchema(schema: unknown): { valid: boolean; error?: string } {
  if (!schema || typeof schema !== 'object') {
    return { valid: false, error: 'Schema must be a non-null object' };
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object' && s.type !== 'array') {
    return { valid: false, error: 'Schema root type must be "object" or "array"' };
  }
  if (s.type === 'object') {
    if (!s.properties || typeof s.properties !== 'object') {
      return { valid: false, error: 'Object schema must have a "properties" field' };
    }
    for (const [key, prop] of Object.entries(s.properties as Record<string, unknown>)) {
      if (!prop || typeof prop !== 'object') {
        return { valid: false, error: `Property "${key}" must be an object` };
      }
    }
  }
  if (s.type === 'array') {
    if (!s.items || typeof s.items !== 'object') {
      return { valid: false, error: 'Array schema must have an "items" field' };
    }
  }
  return { valid: true };
}

function coerceValue(value: unknown, prop: SchemaProperty): unknown {
  if (value === null || value === undefined) {
    return prop.default ?? null;
  }
  const targetType = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (targetType) {
    case 'string':
      return String(value);
    case 'number':
    case 'integer': {
      if (typeof value === 'string') {
        const cleaned = value.replace(/[^0-9.\-]/g, '');
        const num = parseFloat(cleaned);
        if (!isNaN(num)) return targetType === 'integer' ? Math.round(num) : num;
      }
      if (typeof value === 'number') return targetType === 'integer' ? Math.round(value) : value;
      return null;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim();
        if (lower === 'true' || lower === 'yes' || lower === '1') return true;
        if (lower === 'false' || lower === 'no' || lower === '0') return false;
      }
      return null;
    case 'array':
      if (Array.isArray(value)) return value;
      return [value];
    case 'object':
      if (typeof value === 'object' && !Array.isArray(value)) return value;
      return null;
    default:
      return value;
  }
}

export function validateAndCoerce(
  data: Record<string, unknown>,
  schema: ExtractionSchema
): { result: Record<string, unknown>; validation: ValidationResult } {
  const errors: string[] = [];
  const result: Record<string, unknown> = {};
  if (schema.type === 'object' && schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const rawValue = data[key];
      if (rawValue === undefined || rawValue === null) {
        result[key] = prop.default !== undefined ? prop.default : null;
        continue;
      }
      if (prop.type === 'object' && prop.properties && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        const nested = validateAndCoerce(rawValue as Record<string, unknown>, { type: 'object', properties: prop.properties, required: prop.required });
        result[key] = nested.result;
        errors.push(...nested.validation.errors.map(e => `${key}.${e}`));
        continue;
      }
      if (prop.type === 'array' && prop.items && Array.isArray(rawValue)) {
        const items: unknown[] = [];
        for (let i = 0; i < rawValue.length; i++) {
          const item = rawValue[i];
          if (prop.items.type === 'object' && prop.items.properties && typeof item === 'object' && item !== null) {
            const nested = validateAndCoerce(item as Record<string, unknown>, { type: 'object', properties: prop.items.properties, required: prop.items.required });
            items.push(nested.result);
            errors.push(...nested.validation.errors.map(e => `${key}[${i}].${e}`));
          } else {
            items.push(coerceValue(item, prop.items));
          }
        }
        result[key] = items;
        continue;
      }
      result[key] = coerceValue(rawValue, prop);
    }
    if (schema.required) {
      for (const req of schema.required) {
        if (result[req] === null || result[req] === undefined) {
          errors.push(`Missing required field: "${req}"`);
        }
      }
    }
  }
  return { result, validation: { valid: errors.length === 0, errors } };
}
