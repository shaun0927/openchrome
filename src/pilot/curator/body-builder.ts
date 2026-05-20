/**
 * Deterministic SKILL.md body builder — turns a slice of journal
 * entries into a structured Steps section.
 *
 * Why deterministic (not LLM): the portability-harness contract
 * forbids server-side LLM egress (P3 in `src/pilot/index.ts`).
 * Bundling an LLM body distiller would either need a third-party
 * credential (banned) or a local model fork (out of scope). A
 * deterministic transform is also reproducible, byte-stable, and
 * cheap — three properties the curator's idempotency story depends
 * on. A future LLM-augmented refinement can live in the separate
 * package the curator already references (#776).
 *
 * Output shape (markdown):
 *
 *   ## Steps
 *
 *   1. **navigate**(url=https://example.com/cart) — Add to cart page
 *   2. **fill_form**(selector=#qty) — Quantity set
 *   3. **click**(label="Add to cart") — Item added
 *
 *   _Distilled from N journal entries (skipped K read-only steps)._
 *
 * Selection rules:
 *   - Keep entries where `ok === true` (failed steps don't belong
 *     in a verified skill macro).
 *   - Drop entries from `OBSERVATION_TOOLS` (read-only / probing
 *     tools that don't advance state).
 *   - Cap at `MAX_STEPS` (default 12) to keep SKILL.md compact.
 *   - Preserve journal order — assume callers already passed in
 *     entries sorted by `ts ASC`.
 */

export interface JournalLikeEntry {
  readonly ts: number;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
  readonly summary?: string;
}

export interface BuildSkillBodyOptions {
  /** Skill intent (currently passed through as a header context line). */
  readonly intent?: string;
  /** Maximum number of steps to retain. Default 12. */
  readonly maxSteps?: number;
}

const MAX_STEPS_DEFAULT = 12;
const ARGS_PREVIEW_CHARS = 80;
const SUMMARY_PREVIEW_CHARS = 80;

/**
 * Tools that observe state without changing it. These get dropped
 * from the Steps section because replaying them would not progress
 * the macro — they're useful for the original LLM context but noise
 * in a verified skill.
 */
const OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  'read_page',
  'query_dom',
  'inspect',
  'oc_observe',
  'oc_assert',
  'oc_diff',
  'oc_query',
  'oc_reflect',
  'oc_vitals',
  'oc_journal',
  'oc_evidence_bundle',
  'oc_progress_status',
  'oc_get_connection_info',
  'oc_connection_health',
  'oc_devtools_url',
  'oc_doctor_report',
  'screenshot',
  'console_log',
  'console_capture',
  'tabs_context',
  'wait_for',
  'validate_page',
  'find',
  'oc_lane_get',
  'oc_lane_list',
  'oc_task_get',
  'oc_task_list',
  'oc_task_run_get',
  'oc_task_run_list',
  'oc_task_wait',
]);

/**
 * Build a SKILL.md body from a sequence of journal entries.
 * Always returns a syntactically valid markdown body — even when the
 * filter yields zero retained steps, the caller gets back a useful
 * placeholder explaining why.
 */
export function buildSkillBody(
  entries: ReadonlyArray<JournalLikeEntry>,
  opts: BuildSkillBodyOptions = {},
): string {
  const maxSteps = opts.maxSteps ?? MAX_STEPS_DEFAULT;
  const successful: JournalLikeEntry[] = [];
  let droppedRead = 0;
  let droppedFailure = 0;
  for (const e of entries) {
    if (!e || typeof e.tool !== 'string') continue;
    if (!e.ok) {
      droppedFailure += 1;
      continue;
    }
    if (OBSERVATION_TOOLS.has(e.tool)) {
      droppedRead += 1;
      continue;
    }
    successful.push(e);
  }

  const retained = successful.slice(0, maxSteps);
  const truncated = successful.length - retained.length;

  const intro = opts.intent
    ? `_Extracted from a contract-verified successful trajectory for "${escapeForMd(opts.intent).slice(0, 120)}"._\n\n`
    : '_Extracted from a contract-verified successful trajectory._\n\n';

  if (retained.length === 0) {
    return (
      intro +
      `## Steps\n\n` +
      `_No actionable journal entries survived the read-only filter ` +
      `(skipped ${droppedRead} observation calls and ${droppedFailure} failures)._\n`
    );
  }

  let body = intro + '## Steps\n\n';
  for (let i = 0; i < retained.length; i++) {
    body += `${i + 1}. ${renderStep(retained[i]!)}\n`;
  }
  body += `\n_Distilled from ${entries.length} journal entries`;
  if (droppedRead > 0) body += ` (skipped ${droppedRead} read-only)`;
  if (droppedFailure > 0) body += ` (skipped ${droppedFailure} failed)`;
  if (truncated > 0) body += ` (truncated ${truncated} extra steps)`;
  body += '._\n';
  return body;
}

function renderStep(entry: JournalLikeEntry): string {
  const tool = escapeForMd(entry.tool);
  const argsPreview = renderArgs(entry.args);
  const summary = typeof entry.summary === 'string' && entry.summary.length > 0
    ? ` — ${escapeForMd(entry.summary).slice(0, SUMMARY_PREVIEW_CHARS)}`
    : '';
  return `**${tool}**(${argsPreview})${summary}`;
}

/**
 * Render a tool's args as a single short string. We pick the
 * lexically-first key-value pair that has a small primitive value;
 * full args persistence is the journal's job. SKILL.md is for
 * humans / planners scanning the macro.
 */
function renderArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== 'object') return '';
  const keys = Object.keys(args).sort();
  for (const key of keys) {
    const value = args[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.length > 0) {
      return `${escapeForMd(key)}=${escapeForMd(value).slice(0, ARGS_PREVIEW_CHARS)}`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return `${escapeForMd(key)}=${String(value)}`;
    }
  }
  return '';
}

/**
 * Escape characters that would otherwise close out the markdown
 * context — primarily backticks (would break our inline rendering)
 * and newlines (would break the numbered-list flow).
 */
function escapeForMd(text: string): string {
  return text.replace(/[`\r\n]/g, ' ');
}
