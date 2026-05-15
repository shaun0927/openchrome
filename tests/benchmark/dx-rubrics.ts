/**
 * Developer Experience rubrics for axis #1261.
 *
 * Three rubrics committed up front (issue #1261 mandate — "the rubric is
 * defined before measurement"):
 *
 *   - LOC counting rule (imports counted; blank + comments excluded)
 *   - Schema-completeness rubric (per-property descriptor checklist)
 *   - Error-actionability rubric (0-3 score: cause / location / suggestion)
 *
 * Pure data + tiny pure functions; no I/O. The runner imports these and
 * applies them uniformly to every library so the comparison cannot be
 * accused of moving the goalposts mid-measurement.
 */

// ----- LOC counter --------------------------------------------------

export interface LocResult {
  loc: number;
  blankLines: number;
  commentLines: number;
  totalLines: number;
}

/**
 * LOC counter shared with the auth-setup-scripts measurement. Rules:
 *   - blank lines excluded
 *   - single-line `//` comments excluded
 *   - block `/* … *\/` comments excluded
 *   - imports counted
 *   - JSDoc / docblock comments excluded
 */
export function countLoc(source: string): LocResult {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '\n');
  const lines = stripped.split('\n');
  let loc = 0;
  let blankLines = 0;
  let commentLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) blankLines += 1;
    else if (line.startsWith('//')) commentLines += 1;
    else loc += 1;
  }
  return { loc, blankLines, commentLines, totalLines: lines.length };
}

// ----- Schema completeness ------------------------------------------

/**
 * Per-tool JSON Schema completeness scorer. Each tool gets one point per
 * checklist item satisfied, divided by total items for a 0-1 score.
 *
 * Checklist (in order, weight = 1 each):
 *   1. tool has a non-empty `description`
 *   2. every input property has a `description`
 *   3. every input property declares a `type`
 *   4. every required property appears in `required`
 *   5. the schema has at least one example or default for non-primitive props
 */
export interface ToolSchemaInput {
  name: string;
  description?: unknown;
  inputSchema?: {
    type?: unknown;
    properties?: Record<string, { description?: unknown; type?: unknown; default?: unknown; examples?: unknown }>;
    required?: unknown;
  };
}

export interface SchemaScore {
  toolName: string;
  /** 0-1 fraction of the 5-item checklist this tool satisfies. */
  score: number;
  failures: string[];
}

export function scoreToolSchema(tool: ToolSchemaInput): SchemaScore {
  const failures: string[] = [];
  const checks: Array<[string, boolean]> = [];

  const description = typeof tool.description === 'string' && tool.description.trim().length > 0;
  checks.push(['description', description]);

  const properties = tool.inputSchema?.properties && typeof tool.inputSchema.properties === 'object'
    ? tool.inputSchema.properties
    : {};
  const propEntries = Object.entries(properties);

  const everyPropHasDescription =
    propEntries.length === 0 ||
    propEntries.every(([, v]) => typeof v?.description === 'string' && v.description.trim().length > 0);
  checks.push(['property-descriptions', everyPropHasDescription]);

  const everyPropHasType =
    propEntries.length === 0 ||
    propEntries.every(([, v]) => typeof v?.type === 'string' && v.type.length > 0);
  checks.push(['property-types', everyPropHasType]);

  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema!.required : [];
  const requiredOk = (required as unknown[]).every((r) => typeof r === 'string' && r in properties);
  checks.push(['required-listed-in-properties', requiredOk]);

  const hasExamples =
    propEntries.length === 0 ||
    propEntries.some(([, v]) => v?.examples !== undefined || v?.default !== undefined);
  checks.push(['examples-or-defaults', hasExamples]);

  for (const [name, ok] of checks) if (!ok) failures.push(name);
  return {
    toolName: tool.name,
    score: checks.filter((c) => c[1]).length / checks.length,
    failures,
  };
}

// ----- Error actionability ------------------------------------------

/**
 * Rule-based 0-3 score on a returned error string. One point per item:
 *   1. names the CAUSE (e.g. "selector not found", "navigation timeout")
 *   2. names the LOCATION (e.g. the URL or selector that failed)
 *   3. names a SUGGESTED NEXT ACTION (e.g. "increase timeout", "use
 *      waitForSelector")
 *
 * The rubric is intentionally rule-based + case-insensitive — Issue #1261
 * forbids subjective scoring. The CAUSE / LOCATION / SUGGESTION keyword
 * sets below are the committed dictionaries.
 */
export const CAUSE_KEYWORDS = [
  'not found', 'timeout', 'timed out', 'detached', 'navigation', 'crashed',
  'closed', 'denied', 'refused', 'invalid', 'missing', 'unsupported', 'no such',
];
export const LOCATION_KEYWORDS = [
  'url', 'http://', 'https://', 'selector', 'frame', 'element', 'page', 'tab',
];
export const SUGGESTION_KEYWORDS = [
  'try', 'use ', 'increase', 'consider', 'should', 'recommend', 'pass',
  'set ', 'switch to', 'configure', 'instead',
];

export interface ActionabilityScore {
  raw: string;
  /** 0-3. */
  score: number;
  cause: boolean;
  location: boolean;
  suggestion: boolean;
}

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

export function scoreErrorActionability(message: string): ActionabilityScore {
  const cause = matchesAny(message, CAUSE_KEYWORDS);
  const location = matchesAny(message, LOCATION_KEYWORDS);
  const suggestion = matchesAny(message, SUGGESTION_KEYWORDS);
  const score = (cause ? 1 : 0) + (location ? 1 : 0) + (suggestion ? 1 : 0);
  return { raw: message, score, cause, location, suggestion };
}
