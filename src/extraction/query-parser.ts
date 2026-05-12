import type { ExtractionSchema, SchemaProperty } from './schema-validator';

const SAFE_FIELD = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'url', 'date']);

type TokenType = 'braceL' | 'braceR' | 'bracketL' | 'bracketR' | 'parenL' | 'parenR' | 'comma' | 'identifier' | 'string' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export interface QueryFieldNode {
  name: string;
  list: boolean;
  type?: string;
  description?: string;
  children?: QueryFieldNode[];
}

export interface QueryAst {
  fields: QueryFieldNode[];
}

export interface ExtractionQueryPlan {
  schema: ExtractionSchema;
  multiple: boolean;
  normalizedQuery: string;
  rootListField?: string;
}

export class ExtractionQueryParseError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} at position ${position}`);
    this.name = 'ExtractionQueryParseError';
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{') { tokens.push({ type: 'braceL', value: ch, pos: i++ }); continue; }
    if (ch === '}') { tokens.push({ type: 'braceR', value: ch, pos: i++ }); continue; }
    if (ch === '[') { tokens.push({ type: 'bracketL', value: ch, pos: i++ }); continue; }
    if (ch === ']') { tokens.push({ type: 'bracketR', value: ch, pos: i++ }); continue; }
    if (ch === '(') { tokens.push({ type: 'parenL', value: ch, pos: i++ }); continue; }
    if (ch === ')') { tokens.push({ type: 'parenR', value: ch, pos: i++ }); continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ch, pos: i++ }); continue; }
    if (ch === '"') {
      const start = i;
      i++;
      let value = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i++];
        }
      }
      if (i >= input.length) throw new ExtractionQueryParseError('Unterminated string literal', start);
      i++;
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < input.length && /[a-zA-Z0-9_-]/.test(input[i])) i++;
      tokens.push({ type: 'identifier', value: input.slice(start, i), pos: start });
      continue;
    }
    throw new ExtractionQueryParseError(`Unexpected token "${ch}"`, i);
  }
  tokens.push({ type: 'eof', value: '', pos: input.length });
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): QueryAst {
    this.expect('braceL');
    const fields = this.parseFields('braceR');
    this.expect('braceR');
    this.expect('eof');
    if (fields.length === 0) throw new ExtractionQueryParseError('Query must contain at least one field', 0);
    return { fields };
  }

  private parseFields(end: TokenType): QueryFieldNode[] {
    const fields: QueryFieldNode[] = [];
    while (this.peek().type !== end && this.peek().type !== 'eof') {
      fields.push(this.parseField());
      if (this.peek().type === 'comma') this.index++;
    }
    return fields;
  }

  private parseField(): QueryFieldNode {
    const nameToken = this.expect('identifier');
    if (!SAFE_FIELD.test(nameToken.value)) {
      throw new ExtractionQueryParseError(`Unsafe field name "${nameToken.value}"`, nameToken.pos);
    }

    let list = false;
    if (this.peek().type === 'bracketL') {
      this.index++;
      this.expect('bracketR');
      list = true;
    }

    let type: string | undefined;
    let description: string | undefined;
    if (this.peek().type === 'parenL') {
      this.index++;
      const args = this.parseArgs();
      type = args.type;
      description = args.description;
      this.expect('parenR');
    }

    let children: QueryFieldNode[] | undefined;
    if (this.peek().type === 'braceL') {
      this.index++;
      children = this.parseFields('braceR');
      this.expect('braceR');
      if (children.length === 0) {
        throw new ExtractionQueryParseError(`List/object field "${nameToken.value}" must contain at least one child field`, nameToken.pos);
      }
    }

    if (list && !children) {
      throw new ExtractionQueryParseError(`List field "${nameToken.value}" must have a child block`, nameToken.pos);
    }

    return { name: nameToken.value, list, type, description, children };
  }

  private parseArgs(): { type?: string; description?: string } {
    let type: string | undefined;
    let description: string | undefined;
    while (this.peek().type !== 'parenR' && this.peek().type !== 'eof') {
      const token = this.peek();
      if (token.type === 'identifier') {
        this.index++;
        const normalized = token.value.toLowerCase();
        if (!SUPPORTED_TYPES.has(normalized)) {
          throw new ExtractionQueryParseError(`Unsupported type "${token.value}"`, token.pos);
        }
        type = normalized === 'url' || normalized === 'date' ? 'string' : normalized;
        if (normalized === 'url' || normalized === 'date') {
          description = description ? `${description}; type hint: ${normalized}` : `type hint: ${normalized}`;
        }
      } else if (token.type === 'string') {
        this.index++;
        description = description ? `${description}; ${token.value}` : token.value;
      } else if (token.type === 'comma') {
        this.index++;
      } else {
        throw new ExtractionQueryParseError(`Unexpected argument token "${token.value}"`, token.pos);
      }
    }
    return { type, description };
  }

  private peek(): Token { return this.tokens[this.index]; }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new ExtractionQueryParseError(`Expected ${type}, got ${token.type}${token.value ? ` "${token.value}"` : ''}`, token.pos);
    }
    this.index++;
    return token;
  }
}


function assertScalarFields(fields: QueryFieldNode[], context: string): void {
  for (const field of fields) {
    if (field.list || field.children) {
      throw new ExtractionQueryParseError(
        `Nested field "${field.name}" is not supported in the local query subset (${context}). Use flat fields or one root list block.`,
        0,
      );
    }
  }
}

function normalizeFields(fields: QueryFieldNode[]): string {
  return fields.map((field) => {
    const typePart = field.type ? `(${field.type})` : '';
    const descPart = field.description ? `:${field.description}` : '';
    if (field.list) {
      return `${field.name}[]{${normalizeFields(field.children || [])}}${descPart}`;
    }
    if (field.children) {
      return `${field.name}{${normalizeFields(field.children)}}${descPart}`;
    }
    return `${field.name}${typePart}${descPart}`;
  }).join(' ');
}

function fieldToProperty(field: QueryFieldNode): SchemaProperty {
  if (field.list) {
    return {
      type: 'array',
      description: field.description,
      items: {
        type: 'object',
        properties: fieldsToProperties(field.children || []),
        required: (field.children || []).map(child => child.name),
      },
    };
  }
  if (field.children) {
    return {
      type: 'object',
      description: field.description,
      properties: fieldsToProperties(field.children),
      required: field.children.map(child => child.name),
    };
  }
  return {
    type: field.type || 'string',
    ...(field.description ? { description: field.description } : {}),
  };
}

function fieldsToProperties(fields: QueryFieldNode[]): Record<string, SchemaProperty> {
  const props: Record<string, SchemaProperty> = {};
  for (const field of fields) {
    props[field.name] = fieldToProperty(field);
  }
  return props;
}

export function parseExtractionQuery(query: string): QueryAst {
  if (!query || query.trim().length === 0) {
    throw new ExtractionQueryParseError('Query must be a non-empty string', 0);
  }
  return new Parser(tokenize(query)).parse();
}

export function buildExtractionQueryPlan(query: string): ExtractionQueryPlan {
  const ast = parseExtractionQuery(query);
  const normalizedQuery = `{ ${normalizeFields(ast.fields)} }`;
  if (ast.fields.length === 1 && ast.fields[0].list) {
    const root = ast.fields[0];
    assertScalarFields(root.children || [], `root list ${root.name}`);
    return {
      multiple: true,
      normalizedQuery,
      rootListField: root.name,
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: fieldsToProperties(root.children || []),
          required: (root.children || []).map(child => child.name),
        },
      },
    };
  }

  assertScalarFields(ast.fields, 'root object');

  return {
    multiple: false,
    normalizedQuery,
    schema: {
      type: 'object',
      properties: fieldsToProperties(ast.fields),
      required: ast.fields.map(field => field.name),
    },
  };
}
