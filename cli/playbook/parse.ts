/**
 * Playbook parser — accepts .yaml/.yml (via eemeli/yaml) and .json (via JSON.parse).
 *
 * Validates:
 *   { name?: string, vars?: Record<string,string>, steps: Step[] }
 * Each step must have exactly one verb key from SUPPORTED_VERBS.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as yamlParse, parseDocument } from 'yaml';

export const SUPPORTED_VERBS = [
  'navigate',
  'interact',
  'act',
  'fill_form',
  'wait_for',
  'page_screenshot',
  'read_page',
  'javascript_tool',
  'assert',
] as const;

export type Verb = (typeof SUPPORTED_VERBS)[number];

export interface Step {
  verb: Verb;
  args: Record<string, unknown>;
}

export interface Playbook {
  name?: string;
  vars?: Record<string, string>;
  steps: Step[];
}

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseRawStep(raw: unknown, index: number): Step {
  if (!isRecord(raw)) {
    throw new ParseError(`Step ${index} is not an object`);
  }
  const keys = Object.keys(raw);
  const verbKeys = keys.filter((k) => SUPPORTED_VERBS.includes(k as Verb));
  const unknownKeys = keys.filter((k) => !SUPPORTED_VERBS.includes(k as Verb));

  if (verbKeys.length === 0) {
    if (unknownKeys.length > 0) {
      throw new ParseError(
        `Step ${index}: unknown verb "${unknownKeys[0]}". Supported: ${SUPPORTED_VERBS.join(', ')}`,
      );
    }
    throw new ParseError(`Step ${index}: no verb key found. Supported: ${SUPPORTED_VERBS.join(', ')}`);
  }

  if (verbKeys.length > 1) {
    throw new ParseError(
      `Step ${index}: multiple verb keys found (${verbKeys.join(', ')}). Each step must have exactly one verb.`,
    );
  }

  const verb = verbKeys[0] as Verb;
  const args = raw[verb];

  // args can be an object or null (for verbs with no params)
  if (args !== null && args !== undefined && !isRecord(args)) {
    throw new ParseError(`Step ${index}: args for verb "${verb}" must be an object or null`);
  }

  return { verb, args: (isRecord(args) ? args : {}) as Record<string, unknown> };
}

function validateRawPlaybook(raw: unknown): Playbook {
  if (!isRecord(raw)) {
    throw new ParseError('Playbook must be an object at the top level');
  }

  if (!Array.isArray(raw['steps'])) {
    throw new ParseError('Playbook must have a "steps" array');
  }

  if (raw['vars'] !== undefined && raw['vars'] !== null) {
    if (!isRecord(raw['vars'])) {
      throw new ParseError('"vars" must be a key-value object');
    }
    for (const [k, v] of Object.entries(raw['vars'])) {
      if (typeof v !== 'string') {
        throw new ParseError(`vars["${k}"] must be a string`);
      }
    }
  }

  if (raw['name'] !== undefined && typeof raw['name'] !== 'string') {
    throw new ParseError('"name" must be a string');
  }

  const steps: Step[] = (raw['steps'] as unknown[]).map((s, i) => parseRawStep(s, i));

  return {
    name: raw['name'] as string | undefined,
    vars: raw['vars'] as Record<string, string> | undefined,
    steps,
  };
}

export function parsePlaybookContent(content: string, filePath: string): Playbook {
  const ext = path.extname(filePath).toLowerCase();
  let raw: unknown;

  if (ext === '.json') {
    try {
      raw = JSON.parse(content);
    } catch (err) {
      throw new ParseError(
        `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (ext === '.yaml' || ext === '.yml') {
    // Use parseDocument to surface YAML parse errors with line info
    const doc = parseDocument(content);
    if (doc.errors && doc.errors.length > 0) {
      const first = doc.errors[0];
      const line = first.linePos?.[0]?.line;
      throw new ParseError(`YAML parse error: ${first.message}`, line);
    }
    raw = yamlParse(content);
  } else {
    throw new ParseError(`Unsupported file extension "${ext}". Use .yaml, .yml, or .json.`);
  }

  return validateRawPlaybook(raw);
}

export function loadPlaybook(filePath: string): Playbook {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ParseError(
      `Cannot read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsePlaybookContent(content, filePath);
}
