/**
 * SKILL.md frontmatter parser/serializer (#713 v2).
 *
 * Tiny, deliberately not-yaml: the canonical schema is a closed
 * key-value set with primitive types. Pulling in a YAML dep just to
 * round-trip `name: foo` is overkill — and the extractor + curator
 * are the only writers, so format stability is enforceable in code.
 *
 * Handles:
 *   - leading frontmatter delimited by `---` lines
 *   - `key: value` entries (string, number, boolean, ISO-8601)
 *   - nested `budget:` object via dotted keys (`budget.tokens_typical: 4200`)
 *
 * Anything richer should not appear in this schema — the body is
 * plain Markdown.
 */

import {
  SKILL_SCHEMA_VERSION,
  type SkillFile,
  type SkillFrontmatter,
} from './types';

const NAME_PATTERN = /^[a-z0-9._-]{1,64}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX_PATTERN = /^[0-9a-f]+$/;
const DELIMITER = '---';

export class FrontmatterError extends Error {}

/** Parse a SKILL.md text. Throws FrontmatterError on shape problems. */
export function parseSkillMd(text: string): SkillFile {
  if (!text.startsWith(DELIMITER)) {
    throw new FrontmatterError('SKILL.md must start with `---` frontmatter delimiter');
  }
  const lines = text.split('\n');
  // Find closing delimiter (not at index 0).
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === DELIMITER) {
      close = i;
      break;
    }
  }
  if (close < 0) {
    throw new FrontmatterError('SKILL.md frontmatter has no closing `---`');
  }
  const fmLines = lines.slice(1, close);
  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '');

  const raw = parseSimpleYaml(fmLines);
  const frontmatter = validateFrontmatter(raw);
  return { frontmatter, body };
}

/** Build a SKILL.md text from a frontmatter + body. */
export function stringifySkillMd(file: SkillFile): string {
  validateFrontmatter(file.frontmatter as unknown as Record<string, unknown>);
  const fm = file.frontmatter;
  const lines: string[] = [DELIMITER];
  lines.push(`schema_version: ${fm.schema_version}`);
  lines.push(`name: ${fm.name}`);
  lines.push(`domain: ${fm.domain}`);
  lines.push(`intent: ${escapeStr(fm.intent)}`);
  lines.push(`status: ${fm.status}`);
  lines.push(`verified_runs: ${fm.verified_runs}`);
  lines.push(`last_verified_at: ${fm.last_verified_at}`);
  lines.push(`contract_ref: ${fm.contract_ref}`);
  lines.push(`graph_node_anchor: ${fm.graph_node_anchor}`);
  lines.push(`author: ${fm.author}`);
  if (fm.budget) {
    if (typeof fm.budget.tokens_typical === 'number') {
      lines.push(`budget.tokens_typical: ${fm.budget.tokens_typical}`);
    }
    if (typeof fm.budget.wall_ms_typical === 'number') {
      lines.push(`budget.wall_ms_typical: ${fm.budget.wall_ms_typical}`);
    }
  }
  lines.push(DELIMITER);
  lines.push('');
  lines.push(file.body.trimStart());
  if (!lines[lines.length - 1].endsWith('\n')) lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function escapeStr(value: string): string {
  // Quote only when the value contains a leading/trailing space, a
  // colon, a hash, or a double-quote — keeps the output tidy for
  // typical strings.
  if (/[:#"]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

function unescapeStr(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/** Minimal `key: value` parser with dotted-path support. */
function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) {
      throw new FrontmatterError(`malformed frontmatter line: ${line}`);
    }
    const key = line.slice(0, colon).trim();
    const value = unescapeStr(line.slice(colon + 1).trim());
    setNested(out, key, coerce(value));
  }
  return out;
}

function setNested(target: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cursor[k] || typeof cursor[k] !== 'object') {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function coerce(raw: string): unknown {
  if (raw === '') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate + cast unknown → SkillFrontmatter. */
export function validateFrontmatter(raw: unknown): SkillFrontmatter {
  if (!isObj(raw)) throw new FrontmatterError('frontmatter must be an object');
  const fm = raw as Record<string, unknown>;
  must(fm.schema_version === SKILL_SCHEMA_VERSION, `schema_version must be ${SKILL_SCHEMA_VERSION}`);
  const name = mustString(fm, 'name');
  must(NAME_PATTERN.test(name), `name "${name}" must match ${NAME_PATTERN.source}`);
  const domain = mustString(fm, 'domain');
  const intent = mustString(fm, 'intent');
  must(intent.length <= 512, `intent must be ≤ 512 chars (got ${intent.length})`);
  const status = mustString(fm, 'status');
  must(
    status === 'candidate' || status === 'promoted' || status === 'archived',
    `status must be one of candidate|promoted|archived (got "${status}")`,
  );
  const verifiedRuns = mustNumber(fm, 'verified_runs');
  must(verifiedRuns >= 0, 'verified_runs must be ≥0');
  const lastVerifiedAt = mustString(fm, 'last_verified_at');
  must(ISO_PATTERN.test(lastVerifiedAt), `last_verified_at must be ISO-8601 with Z suffix`);
  const contractRef = mustString(fm, 'contract_ref');
  const graphNodeAnchor = mustString(fm, 'graph_node_anchor');
  must(HEX_PATTERN.test(graphNodeAnchor), 'graph_node_anchor must be hex');
  const author = mustString(fm, 'author');
  must(author === 'agent' || author === 'user', `author must be agent|user (got "${author}")`);
  const out: SkillFrontmatter = {
    schema_version: SKILL_SCHEMA_VERSION,
    name,
    domain,
    intent,
    status: status as SkillFrontmatter['status'],
    verified_runs: verifiedRuns,
    last_verified_at: lastVerifiedAt,
    contract_ref: contractRef,
    graph_node_anchor: graphNodeAnchor,
    author: author as SkillFrontmatter['author'],
  };
  if (isObj(fm.budget)) {
    const b = fm.budget;
    out.budget = {};
    if (typeof b.tokens_typical === 'number') out.budget.tokens_typical = b.tokens_typical;
    if (typeof b.wall_ms_typical === 'number') out.budget.wall_ms_typical = b.wall_ms_typical;
  }
  return out;
}

function mustString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new FrontmatterError(`field "${field}" must be a non-empty string`);
  }
  return v;
}

function mustNumber(obj: Record<string, unknown>, field: string): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new FrontmatterError(`field "${field}" must be a finite number`);
  }
  return v;
}

function must(cond: boolean, message: string): void {
  if (!cond) throw new FrontmatterError(message);
}
