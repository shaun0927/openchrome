/**
 * Runtime schema validator for MCP tool registration.
 * Warns about patterns incompatible with various AI APIs (Gemini, OpenAI, etc.).
 * Does NOT throw — only logs warnings via console.error.
 */

import { MCPToolDefinition } from '../types/mcp';

type PropertySchema = Record<string, unknown>;

/**
 * Walk all properties in a schema object recursively, collecting warnings.
 */
function walkProperties(
  toolName: string,
  properties: Record<string, unknown>,
  path: string,
  warnings: string[]
): void {
  for (const [key, value] of Object.entries(properties)) {
    const prop = value as PropertySchema;
    const propPath = path ? `${path}.${key}` : key;

    if (prop === null || typeof prop !== 'object') {
      continue;
    }

    // Check 1: enum only on string type
    if ('enum' in prop) {
      const enumVal = prop['enum'];

      // Check 3: no empty enum arrays
      if (Array.isArray(enumVal) && enumVal.length === 0) {
        warnings.push(
          `Property "${propPath}" has an empty "enum" array (rejected by Gemini and OpenAI)`
        );
      }

      // Check 1: enum only on string type
      if ('type' in prop && prop['type'] !== 'string') {
        warnings.push(
          `Property "${propPath}" has "enum" but type is "${prop['type']}" — Gemini requires enum only on string-typed properties`
        );
      }

      // Check 2: no empty strings in enum
      if (Array.isArray(enumVal) && enumVal.includes('')) {
        warnings.push(
          `Property "${propPath}" has an empty string in "enum" (rejected by Gemini)`
        );
      }
    }

    // Check 5: no oneOf/anyOf/allOf at property level
    for (const keyword of ['oneOf', 'anyOf', 'allOf'] as const) {
      if (keyword in prop) {
        warnings.push(
          `Property "${propPath}" uses "${keyword}" which is not supported by Gemini`
        );
      }
    }

    // Recurse into nested object properties
    if (
      prop['type'] === 'object' &&
      prop['properties'] !== null &&
      typeof prop['properties'] === 'object'
    ) {
      walkProperties(
        toolName,
        prop['properties'] as Record<string, unknown>,
        propPath,
        warnings
      );
    }
  }
}

/**
 * Validate a tool's input schema for cross-API compatibility.
 * Logs warnings via console.error. Does NOT throw.
 */
export function validateToolSchema(
  name: string,
  schema: MCPToolDefinition['inputSchema']
): void {
  const warnings: string[] = [];

  // Check 4: required items must exist in properties
  if (schema.required && schema.required.length > 0) {
    for (const requiredField of schema.required) {
      if (!(requiredField in schema.properties)) {
        warnings.push(
          `Required field "${requiredField}" is not defined in "properties"`
        );
      }
    }
  }

  // Walk all top-level properties (and recurse into nested objects)
  walkProperties(name, schema.properties, '', warnings);

  // Emit all warnings
  for (const warning of warnings) {
    console.error(`[OpenChrome] Schema warning for tool "${name}": ${warning}`);
  }
}
