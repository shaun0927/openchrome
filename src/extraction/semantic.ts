import type { ExtractionSchema, SchemaProperty } from './schema-validator';

export const SEMANTIC_DEFAULT_MAX_CHARS = 12000;
export const SEMANTIC_HARD_MAX_CHARS = 50000;

export interface SemanticExtractionOptions {
  markdown: string;
  schema: ExtractionSchema;
  schemaProps: Record<string, SchemaProperty>;
  query: string;
  startFromChar?: number;
  maxChars?: number;
  alreadyCollected?: unknown[];
}

export interface SemanticExtractionPayload {
  action: 'extract_data';
  modeUsed: 'semantic';
  semanticProvider: 'host';
  query: string;
  schema: ExtractionSchema;
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  nextStartChar: number | null;
  contentStats: {
    rawChars: number;
    sanitizedChars: number;
    filteredChars: number;
    chunkChars: number;
    maxChars: number;
    startFromChar: number;
    redactions: number;
  };
  fieldsFound: number;
  fieldsTotal: number;
  fieldsMissing: string[];
  hostExtraction: {
    instruction: string;
    schema: ExtractionSchema;
    query: string;
    chunk: string;
    alreadyCollected: unknown[];
  };
}

interface RedactionResult {
  text: string;
  count: number;
}

const SENSITIVE_LINE = /\b(password|passcode|token|secret|api[_ -]?key|credential|authorization|cookie|session)\b/i;
const SENSITIVE_ASSIGNMENT = /\b(password|passcode|token|secret|api[_ -]?key|credential|authorization|cookie|session)\b\s*[:=]\s*([^\n\r]+)/gi;

export function normalizeSemanticMaxChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return SEMANTIC_DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(value), SEMANTIC_HARD_MAX_CHARS);
}

export function normalizeSemanticStart(value: unknown, rawLength: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Math.max(0, rawLength));
}

export function redactSemanticContent(markdown: string): RedactionResult {
  let count = 0;
  const lines = markdown.split('\n').map(line => {
    if (!SENSITIVE_LINE.test(line)) return line;
    count += 1;
    return line.replace(SENSITIVE_ASSIGNMENT, (_match, key) => `${key}: [REDACTED]`)
      .replace(/value="[^"]*"/gi, 'value="[REDACTED]"')
      .replace(/`[^`]{3,}`/g, '`[REDACTED]`');
  });
  return { text: lines.join('\n'), count };
}

export function buildSemanticHostExtractionPayload(options: SemanticExtractionOptions): SemanticExtractionPayload {
  const query = options.query.trim();
  const maxChars = normalizeSemanticMaxChars(options.maxChars);
  const alreadyCollected = Array.isArray(options.alreadyCollected) ? options.alreadyCollected : [];
  const redacted = redactSemanticContent(options.markdown);
  const filtered = filterMarkdownForQuery(redacted.text, query, alreadyCollected);
  const startFromChar = normalizeSemanticStart(options.startFromChar, filtered.length);
  const chunk = filtered.slice(startFromChar, startFromChar + maxChars);
  const nextStartChar = startFromChar + chunk.length < filtered.length ? startFromChar + chunk.length : null;
  const totalChunks = Math.max(1, Math.ceil(filtered.length / maxChars));
  const chunkIndex = Math.floor(startFromChar / maxChars);
  const fieldNames = Object.keys(options.schemaProps);

  return {
    action: 'extract_data',
    modeUsed: 'semantic',
    semanticProvider: 'host',
    query,
    schema: options.schema,
    chunk,
    chunkIndex,
    totalChunks,
    nextStartChar,
    contentStats: {
      rawChars: options.markdown.length,
      sanitizedChars: redacted.text.length,
      filteredChars: filtered.length,
      chunkChars: chunk.length,
      maxChars,
      startFromChar,
      redactions: redacted.count,
    },
    fieldsFound: 0,
    fieldsTotal: fieldNames.length,
    fieldsMissing: fieldNames,
    hostExtraction: {
      instruction: 'Use this bounded markdown chunk to extract data matching schema and query. If nextStartChar is non-null, call extract_data again with startFromChar=nextStartChar to continue.',
      schema: options.schema,
      query,
      chunk,
      alreadyCollected,
    },
  };
}

function filterMarkdownForQuery(markdown: string, query: string, alreadyCollected: unknown[]): string {
  const blocks = splitBlocks(markdown);
  const queryTerms = tokenize(query);
  const seenTerms = new Set(alreadyCollected.map(item => normalizeText(String(item))).filter(Boolean));
  const scored = blocks.map((block, index) => ({ block, index, score: scoreBlock(block, queryTerms, index) }))
    .filter(item => !seenTerms.has(normalizeText(item.block).slice(0, 160)));

  const positive = scored.filter(item => item.score > 0);
  const selected = positive.length > 0
    ? positive.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 80).sort((a, b) => a.index - b.index)
    : scored.slice(0, 80);

  return selected.map(item => item.block.trim()).filter(Boolean).join('\n\n').trim();
}

function splitBlocks(markdown: string): string[] {
  const lines = markdown.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

function scoreBlock(block: string, queryTerms: string[], index: number): number {
  const text = normalizeText(block);
  let score = block.startsWith('#') ? 2 : 0;
  for (const term of queryTerms) {
    if (text.includes(term)) score += 3;
  }
  if (index < 3) score += 1;
  return score;
}

function tokenize(text: string): string[] {
  return normalizeText(text).split(' ').filter(token => token.length >= 3).slice(0, 32);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
