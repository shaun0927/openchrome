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
  if (/[:#"\r\n]|^\s|\s$/.test(value)) return JSON.stringify(value);
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

/**
 * Reserved property names that cannot appear as keys in parsed
 * frontmatter — they would either mutate `Object.prototype` (whole-
 * process pollution) or alias `Object`'s constructor / prototype slot
 * on the parsed map and propagate through downstream property access.
 * The frontmatter schema does not legitimately use any of these.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Minimal `key: value` parser with dotted-path support. */
function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  // Use a null-prototype map so even if a forbidden key slipped past
  // the explicit guard below, it could only land on this object — it
  // could never reach `Object.prototype`.
  const out = Object.create(null) as Record<string, unknown>;
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
  for (const seg of parts) {
    if (FORBIDDEN_KEYS.has(seg)) {
      // Refuse the whole assignment rather than partially writing the
      // path. A crafted frontmatter cannot mutate `Object.prototype`
      // through this parser.
      throw new FrontmatterError(`forbidden frontmatter key segment: "${seg}"`);
    }
  }
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const existing = cursor[k];
    if (!existing || typeof existing !== 'object') {
      cursor[k] = Object.create(null);
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function coerce(raw: string): unknown {
  // Strings stay strings — type coercion is deferred to validation
  // time for the small closed set of non-string fields:
  //   number-typed: schema_version, verified_runs, budget.*
  //   none of the schema fields are boolean
  // Eager Number.parseInt() destroyed string-typed fields like
  // contract_ref / graph_node_anchor when they happened to be all
  // digits, and eager `true`/`false` → boolean coercion likewise
  // destroyed string-typed fields like `name: true` (a SKILL.md
  // written through `stringifySkillMd` does not quote those tokens
  // because the writer does not know they are reserved literals;
  // the next read then turned the value into a boolean and
  // `validateFrontmatter` threw). Returning the raw string lets
  // both writers and validators stay in charge of their own
  // type expectations.
  return raw;
}

/** Best-effort coerce-to-number used inside validateFrontmatter. */
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate + cast unknown → SkillFrontmatter. */
export function validateFrontmatter(raw: unknown): SkillFrontmatter {
  if (!isObj(raw)) throw new FrontmatterError('frontmatter must be an object');
  const fm = raw as Record<string, unknown>;
  const schemaVersion = asNumber(fm.schema_version);
  must(schemaVersion === SKILL_SCHEMA_VERSION, `schema_version must be ${SKILL_SCHEMA_VERSION}`);
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
  const verifiedRuns = asNumber(fm.verified_runs);
  if (verifiedRuns === undefined) {
    throw new FrontmatterError('field "verified_runs" must be a finite number');
  }
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
    const tokens = asNumber(b.tokens_typical);
    if (tokens !== undefined) out.budget.tokens_typical = tokens;
    const wall = asNumber(b.wall_ms_typical);
    if (wall !== undefined) out.budget.wall_ms_typical = wall;
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

function must(cond: boolean, message: string): void {
  if (!cond) throw new FrontmatterError(message);
}
