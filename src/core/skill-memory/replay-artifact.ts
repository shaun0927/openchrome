/**
 * Replay artifact types + validator (#875).
 *
 * A "replay artifact" is the persistable, deterministic encoding of a single
 * step's selector strategies plus the action to perform. When `oc_skill_record`
 * stores a skill, each step may carry a `replay_artifact`; `oc_skill_replay`
 * later walks the artifacts and re-issues actions without an LLM round-trip.
 *
 * Design constraints (per the portability-harness contract):
 *   - P3: no outbound HTTP / no LLM API. The artifact contains only data
 *     captured at record time; replay does no external calls.
 *   - P4: facts, not decisions. Selector strategies are stored verbatim. The
 *     replay tool tries them in order — no scoring, no LLM judgment.
 *   - The selector kinds are a strict subset of what Ralph (S1–S6) can issue
 *     so replay reuses the existing strategy stack — HITL (S7) is never
 *     persisted.
 *
 * Schema version is pinned at 1. Bumping it requires a back-compat plan in
 * `SkillMemoryStore.readFileSync` so older records still load.
 */

/** Pinned at 1 — bumping requires a back-compat plan in the store loader. */
export const REPLAY_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * The set of action kinds replay can re-issue. A strict subset of what the
 * recorder hooks observe; whatever HITL or pilot extensions add lives outside
 * this enum so the core surface stays small.
 */
export const REPLAY_STEP_KINDS = [
  'click',
  'fill',
  'navigate',
  'press',
  'select',
  'submit',
  'scroll',
] as const;
export type ReplayStepKind = (typeof REPLAY_STEP_KINDS)[number];

/** Selector strategy variants — ordered list, first successful resolution wins. */
export type ReplaySelector =
  | { type: 'node_ref'; value: string }
  | { type: 'xpath'; value: string }
  | { type: 'css'; value: string }
  | { type: 'role_name'; role: string; name: string }
  | { type: 'accessible_name'; value: string }
  | { type: 'text'; value: string };

export const REPLAY_SELECTOR_TYPES = [
  'node_ref',
  'xpath',
  'css',
  'role_name',
  'accessible_name',
  'text',
] as const;
export type ReplaySelectorType = (typeof REPLAY_SELECTOR_TYPES)[number];

/** One persisted step's artifact. */
export interface ReplayArtifactStep {
  /** Action verb. Strict subset of Ralph S1–S6. HITL (S7) is never persisted. */
  kind: ReplayStepKind;
  /**
   * Tried in declaration order; first successful resolution wins. An empty
   * array is invalid — the validator rejects it so we never persist a step
   * with no recoverable strategy.
   */
  selectors: ReplaySelector[];
  /**
   * Frame ordinal. 0 = main frame. Non-zero is a per-target ordinal assigned
   * at first observation and used only internally — NOT surfaced on the
   * public MCP `tools/list` schema. If a future issue formalises frame
   * addressing this field re-aligns there.
   */
  frameOrdinal?: number;
  /**
   * Action-specific payload. For `fill`, contains `value`. For `navigate`,
   * contains `url`. The schema is intentionally loose so additions are
   * additive — the replay tool validates per-kind requirements at execute time.
   */
  args?: Record<string, unknown>;
  /**
   * Optional inline contract check; if present, the replay tool calls
   * `oc_assert` against this contract id after the step.
   */
  post_assert?: { contract_id: string };
}

/** Top-level artifact carried on a step or attached at record time. */
export interface ReplayArtifact {
  schema_version: typeof REPLAY_ARTIFACT_SCHEMA_VERSION;
  /** Wall-clock ms epoch at which the artifact was captured. */
  recorded_at: number;
  recorder: { openchrome_version: string };
  steps: ReplayArtifactStep[];
}

/** Outcome of `validateReplayArtifact`. */
export interface ValidationResult {
  ok: boolean;
  /** Human-readable error path (empty when ok). */
  error?: string;
}

/**
 * Strict structural validator. Returns `{ ok: true }` for a valid artifact;
 * otherwise an `error` string naming the first invalid path. Pure function;
 * does not throw.
 *
 * Used by both `oc_skill_record` (input validation when callers attach an
 * artifact to a step) and `oc_skill_replay` (storage integrity check before
 * walking the steps).
 */
export function validateReplayArtifact(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'artifact must be an object' };
  }
  const a = value as Partial<ReplayArtifact>;
  if (a.schema_version !== REPLAY_ARTIFACT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `schema_version must be ${REPLAY_ARTIFACT_SCHEMA_VERSION} (got ${String(a.schema_version)})`,
    };
  }
  if (typeof a.recorded_at !== 'number' || !Number.isFinite(a.recorded_at)) {
    return { ok: false, error: 'recorded_at must be a finite number' };
  }
  if (
    !a.recorder ||
    typeof a.recorder !== 'object' ||
    typeof (a.recorder as { openchrome_version?: unknown }).openchrome_version !== 'string'
  ) {
    return { ok: false, error: 'recorder.openchrome_version must be a string' };
  }
  if (!Array.isArray(a.steps) || a.steps.length === 0) {
    return { ok: false, error: 'steps must be a non-empty array' };
  }
  for (let i = 0; i < a.steps.length; i++) {
    const stepResult = validateReplayArtifactStep(a.steps[i]);
    if (!stepResult.ok) {
      return { ok: false, error: `steps[${i}]: ${stepResult.error}` };
    }
  }
  return { ok: true };
}

/** Validate a single step. Exposed for callers that build artifacts piecewise. */
export function validateReplayArtifactStep(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'step must be an object' };
  }
  const s = value as Partial<ReplayArtifactStep>;
  if (typeof s.kind !== 'string' || !REPLAY_STEP_KINDS.includes(s.kind as ReplayStepKind)) {
    return {
      ok: false,
      error: `kind must be one of ${REPLAY_STEP_KINDS.join('|')} (got ${String(s.kind)})`,
    };
  }
  // For navigate, selectors may legitimately be empty (the URL lives in
  // `args.url`). For every other kind, at least one selector is required.
  if (!Array.isArray(s.selectors)) {
    return { ok: false, error: 'selectors must be an array' };
  }
  if (s.kind !== 'navigate' && s.selectors.length === 0) {
    return { ok: false, error: 'selectors must be non-empty for non-navigate steps' };
  }
  for (let i = 0; i < s.selectors.length; i++) {
    const sel = s.selectors[i];
    const selResult = validateReplaySelector(sel);
    if (!selResult.ok) {
      return { ok: false, error: `selectors[${i}]: ${selResult.error}` };
    }
  }
  if (s.frameOrdinal !== undefined) {
    if (typeof s.frameOrdinal !== 'number' || !Number.isInteger(s.frameOrdinal) || s.frameOrdinal < 0) {
      return { ok: false, error: 'frameOrdinal must be a non-negative integer' };
    }
  }
  if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) {
    return { ok: false, error: 'args must be a plain object when present' };
  }
  if (s.post_assert !== undefined) {
    if (
      !s.post_assert ||
      typeof s.post_assert !== 'object' ||
      typeof (s.post_assert as { contract_id?: unknown }).contract_id !== 'string' ||
      (s.post_assert as { contract_id: string }).contract_id.length === 0
    ) {
      return { ok: false, error: 'post_assert.contract_id must be a non-empty string' };
    }
  }
  // Per-kind arg invariants — kept loose, only check the obviously-required
  // shape so additive args stay forward-compatible.
  if (s.kind === 'navigate') {
    const url = (s.args as Record<string, unknown> | undefined)?.url;
    if (typeof url !== 'string' || url.length === 0) {
      return { ok: false, error: 'navigate step requires args.url string' };
    }
  }
  if (s.kind === 'fill') {
    const value = (s.args as Record<string, unknown> | undefined)?.value;
    if (typeof value !== 'string') {
      return { ok: false, error: 'fill step requires args.value string' };
    }
  }
  if (s.kind === 'press') {
    const key = (s.args as Record<string, unknown> | undefined)?.key;
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: 'press step requires args.key string' };
    }
  }
  if (s.kind === 'select') {
    const value = (s.args as Record<string, unknown> | undefined)?.value;
    if (typeof value !== 'string') {
      return { ok: false, error: 'select step requires args.value string' };
    }
  }
  if (s.kind === 'scroll') {
    const args = s.args as Record<string, unknown> | undefined;
    if (args?.x !== undefined && typeof args.x !== 'number') {
      return { ok: false, error: 'scroll args.x must be a number when present' };
    }
    if (args?.y !== undefined && typeof args.y !== 'number') {
      return { ok: false, error: 'scroll args.y must be a number when present' };
    }
  }
  return { ok: true };
}

/** Validate a single selector entry. */
export function validateReplaySelector(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'selector must be an object' };
  }
  const s = value as { type?: unknown };
  if (typeof s.type !== 'string' || !REPLAY_SELECTOR_TYPES.includes(s.type as ReplaySelectorType)) {
    return {
      ok: false,
      error: `type must be one of ${REPLAY_SELECTOR_TYPES.join('|')} (got ${String(s.type)})`,
    };
  }
  if (s.type === 'node_ref') {
    return { ok: false, error: 'node_ref selectors are not replayable until the node-ref resolver can return a live element handle' };
  }
  if (s.type === 'role_name') {
    const r = value as { role?: unknown; name?: unknown };
    if (typeof r.role !== 'string' || r.role.length === 0) {
      return { ok: false, error: 'role_name.role must be a non-empty string' };
    }
    if (typeof r.name !== 'string') {
      return { ok: false, error: 'role_name.name must be a string' };
    }
    return { ok: true };
  }
  const v = value as { value?: unknown };
  if (typeof v.value !== 'string' || v.value.length === 0) {
    return { ok: false, error: `${s.type}.value must be a non-empty string` };
  }
  return { ok: true };
}

/**
 * JSON-Schema (Draft-07) dump for the artifact. Returned as a plain object
 * so MCP tool definitions can embed it inline. The structure mirrors what
 * `validateReplayArtifact` enforces; the runtime validator is authoritative.
 */
export function replayArtifactJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['schema_version', 'recorded_at', 'recorder', 'steps'],
    properties: {
      schema_version: { const: REPLAY_ARTIFACT_SCHEMA_VERSION },
      recorded_at: { type: 'number' },
      recorder: {
        type: 'object',
        required: ['openchrome_version'],
        properties: { openchrome_version: { type: 'string' } },
      },
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['kind', 'selectors'],
          properties: {
            kind: { enum: [...REPLAY_STEP_KINDS] },
            selectors: { type: 'array', items: { type: 'object' } },
            frameOrdinal: { type: 'integer', minimum: 0 },
            args: { type: 'object' },
            post_assert: {
              type: 'object',
              required: ['contract_id'],
              properties: { contract_id: { type: 'string' } },
            },
          },
        },
      },
    },
  };
}
