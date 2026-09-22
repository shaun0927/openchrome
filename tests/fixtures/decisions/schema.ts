/**
 * Decision corpus schema — TypeScript types and validator.
 *
 * Human-readable documentation lives next to this file in SCHEMA.md; keep
 * both in sync. The evaluator (`scripts/eval-decisions.ts`) and the
 * extraction / split scripts import from here.
 */

export type CaseKind = 'element' | 'outcome' | 'irreversible' | 'gate';
export type CaseLang = 'ko' | 'en';
export type CasePool = 'trajectory' | 'fixture' | 'public';
export type CaseSplit = 'A' | 'B';

export const CASE_KINDS: readonly CaseKind[] = ['element', 'outcome', 'irreversible', 'gate'];
export const CASE_LANGS: readonly CaseLang[] = ['ko', 'en'];
export const CASE_POOLS: readonly CasePool[] = ['trajectory', 'fixture', 'public'];
export const CASE_SPLITS: readonly CaseSplit[] = ['A', 'B'];

export const OUTCOME_ANSWERS = [
  'SUCCESS', 'SILENT_CLICK', 'WRONG_ELEMENT', 'ELEMENT_NOT_FOUND', 'TIMEOUT', 'EXCEPTION',
] as const;
export const IRREVERSIBLE_ANSWERS = [
  'allow', 'preview_required', 'elicitation_required', 'checkpoint_required', 'blocked',
] as const;
export const GATE_ANSWERS = ['bot_check', 'login', 'paywall', 'two_factor', 'none'] as const;

export type OutcomeAnswer = typeof OUTCOME_ANSWERS[number];
export type IrreversibleAnswer = typeof IRREVERSIBLE_ANSWERS[number];
export type GateAnswer = typeof GATE_ANSWERS[number];

/** The abstain / "no target" answer, shared by every kind. */
export const NONE_ANSWER = 'none';

export interface ElementTarget {
  ref: string;
  role: string;
  name: string;
  value: string;
  state: string;
}

export interface ElementResolutionTelemetry {
  resolver: 'ax' | 'css' | 'none';
  ax_match_level?: number;
  css_score?: number;
}

export interface ElementHistoryEntry {
  action: string;
  result: string;
  resolution?: ElementResolutionTelemetry;
}

export interface ElementView {
  targets: ElementTarget[];
  above: number;
  below: number;
  history: ElementHistoryEntry[];
}

export interface ElementInput {
  query: string;
  view: ElementView;
  raw_snapshot_path?: string;
}

export interface OutcomeInput {
  delta: string;
  target_role?: string;
  before_url?: string;
  after_url?: string;
}

export interface IrreversibleInput {
  tool: string;
  args: Record<string, unknown>;
  page_context: Record<string, unknown>;
}

export interface GateInput {
  title: string;
  text_excerpt: string;
  html_excerpt?: string;
}

export interface CaseLabel {
  answer: string;
  labeler: string;
  notes?: string;
}

interface CaseBase {
  id: string;
  lang: CaseLang;
  pool: CasePool;
  split?: CaseSplit;
  label?: CaseLabel;
  truth_hint?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface ElementCase extends CaseBase { kind: 'element'; input: ElementInput }
export interface OutcomeCase extends CaseBase { kind: 'outcome'; input: OutcomeInput }
export interface IrreversibleCase extends CaseBase { kind: 'irreversible'; input: IrreversibleInput }
export interface GateCase extends CaseBase { kind: 'gate'; input: GateInput }

export type DecisionCase = ElementCase | OutcomeCase | IrreversibleCase | GateCase;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Answer set for a kind, or null when the answer space is open (element: any ref or "none"). */
export function answerSetFor(kind: CaseKind): readonly string[] | null {
  switch (kind) {
    case 'outcome': return OUTCOME_ANSWERS;
    case 'irreversible': return IRREVERSIBLE_ANSWERS;
    case 'gate': return GATE_ANSWERS;
    case 'element': return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function requireString(obj: Record<string, unknown>, key: string, where: string, errors: string[], allowEmpty = true): void {
  const v = obj[key];
  if (!isString(v)) errors.push(`${where}.${key} must be a string`);
  else if (!allowEmpty && v.length === 0) errors.push(`${where}.${key} must be non-empty`);
}

function optionalString(obj: Record<string, unknown>, key: string, where: string, errors: string[]): void {
  if (obj[key] !== undefined && !isString(obj[key])) errors.push(`${where}.${key} must be a string when present`);
}

function validateElementInput(input: Record<string, unknown>, errors: string[]): void {
  requireString(input, 'query', 'input', errors);
  optionalString(input, 'raw_snapshot_path', 'input', errors);
  const view = input.view;
  if (!isRecord(view)) { errors.push('input.view must be an object'); return; }
  if (typeof view.above !== 'number') errors.push('input.view.above must be a number');
  if (typeof view.below !== 'number') errors.push('input.view.below must be a number');
  if (!Array.isArray(view.targets)) {
    errors.push('input.view.targets must be an array');
  } else {
    const refs = new Set<string>();
    view.targets.forEach((t, i) => {
      const where = `input.view.targets[${i}]`;
      if (!isRecord(t)) { errors.push(`${where} must be an object`); return; }
      requireString(t, 'ref', where, errors, false);
      for (const k of ['role', 'name', 'value', 'state']) requireString(t, k, where, errors);
      if (isString(t.ref)) {
        if (refs.has(t.ref)) errors.push(`${where}.ref "${t.ref}" is duplicated`);
        refs.add(t.ref);
      }
    });
  }
  if (!Array.isArray(view.history)) {
    errors.push('input.view.history must be an array');
  } else {
    view.history.forEach((h, i) => {
      const where = `input.view.history[${i}]`;
      if (!isRecord(h)) { errors.push(`${where} must be an object`); return; }
      requireString(h, 'action', where, errors);
      requireString(h, 'result', where, errors);
      validateElementResolutionTelemetry(h.resolution, `${where}.resolution`, errors);
    });
  }
}

function validateElementResolutionTelemetry(value: unknown, where: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${where} must be an object when present`);
    return;
  }
  if (!isString(value.resolver) || !['ax', 'css', 'none'].includes(value.resolver)) {
    errors.push(`${where}.resolver must be ax|css|none`);
  }
  if (value.ax_match_level !== undefined) {
    if (typeof value.ax_match_level !== 'number' || !Number.isInteger(value.ax_match_level) || value.ax_match_level < 1 || value.ax_match_level > 4) {
      errors.push(`${where}.ax_match_level must be an integer 1..4 when present`);
    }
  }
  if (value.css_score !== undefined) {
    if (typeof value.css_score !== 'number' || !Number.isFinite(value.css_score)) {
      errors.push(`${where}.css_score must be a finite number when present`);
    }
  }
}

function validateOutcomeInput(input: Record<string, unknown>, errors: string[]): void {
  requireString(input, 'delta', 'input', errors);
  for (const k of ['target_role', 'before_url', 'after_url']) optionalString(input, k, 'input', errors);
}

function validateIrreversibleInput(input: Record<string, unknown>, errors: string[]): void {
  requireString(input, 'tool', 'input', errors, false);
  if (!isRecord(input.args)) errors.push('input.args must be an object');
  if (!isRecord(input.page_context)) errors.push('input.page_context must be an object');
}

function validateGateInput(input: Record<string, unknown>, errors: string[]): void {
  requireString(input, 'title', 'input', errors);
  requireString(input, 'text_excerpt', 'input', errors);
  optionalString(input, 'html_excerpt', 'input', errors);
}

/**
 * Validate one corpus line. Returns every problem found rather than the first,
 * so a labeling pass can fix a file in one round.
 */
export function validateCase(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['case must be an object'] };

  if (!isString(value.id) || value.id.length === 0) errors.push('id must be a non-empty string');
  const kind = value.kind;
  const kindKnown = isString(kind) && (CASE_KINDS as readonly string[]).includes(kind);
  if (!kindKnown) errors.push(`kind must be one of ${CASE_KINDS.join('|')}`);
  if (!isString(value.lang) || !(CASE_LANGS as readonly string[]).includes(value.lang)) errors.push(`lang must be one of ${CASE_LANGS.join('|')}`);
  if (!isString(value.pool) || !(CASE_POOLS as readonly string[]).includes(value.pool)) errors.push(`pool must be one of ${CASE_POOLS.join('|')}`);
  if (value.split !== undefined && !(CASE_SPLITS as readonly string[]).includes(value.split as string)) errors.push('split must be A or B when present');
  if (value.truth_hint !== undefined && !isRecord(value.truth_hint)) errors.push('truth_hint must be an object when present');
  if (value.meta !== undefined && !isRecord(value.meta)) errors.push('meta must be an object when present');

  const input = value.input;
  if (!isRecord(input)) {
    errors.push('input must be an object');
  } else if (kindKnown) {
    switch (kind as CaseKind) {
      case 'element': validateElementInput(input, errors); break;
      case 'outcome': validateOutcomeInput(input, errors); break;
      case 'irreversible': validateIrreversibleInput(input, errors); break;
      case 'gate': validateGateInput(input, errors); break;
    }
  }

  const label = value.label;
  if (label !== undefined) {
    if (!isRecord(label)) {
      errors.push('label must be an object when present');
    } else {
      requireString(label, 'answer', 'label', errors, false);
      requireString(label, 'labeler', 'label', errors, false);
      optionalString(label, 'notes', 'label', errors);
      if (isString(label.answer) && kindKnown) {
        const set = answerSetFor(kind as CaseKind);
        if (set && !set.includes(label.answer)) {
          errors.push(`label.answer "${label.answer}" is not in ${set.join('|')}`);
        }
        if (kind === 'element' && label.answer !== NONE_ANSWER && isRecord(input) && isRecord(input.view) && Array.isArray(input.view.targets)) {
          const refs = (input.view.targets as unknown[]).map((t) => (isRecord(t) ? t.ref : undefined));
          if (!refs.includes(label.answer)) errors.push(`label.answer "${label.answer}" is not a ref in input.view.targets`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Parse a JSONL string into cases, validating each line. Line numbers are 1-based. */
export function parseCorpus(text: string): { cases: DecisionCase[]; errors: Array<{ line: number; errors: string[] }> } {
  const cases: DecisionCase[] = [];
  const errors: Array<{ line: number; errors: string[] }> = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      errors.push({ line: i + 1, errors: [`invalid JSON: ${(err as Error).message}`] });
      return;
    }
    const result = validateCase(parsed);
    const id = isRecord(parsed) && isString(parsed.id) ? parsed.id : undefined;
    if (id !== undefined) {
      if (seen.has(id)) result.errors.push(`duplicate id "${id}"`);
      seen.add(id);
    }
    if (result.errors.length > 0) {
      errors.push({ line: i + 1, errors: result.errors });
      return;
    }
    cases.push(parsed as DecisionCase);
  });
  return { cases, errors };
}

/** Serialize cases to JSONL (one compact object per line, trailing newline). */
export function serializeCorpus(cases: readonly DecisionCase[]): string {
  return cases.map((c) => JSON.stringify(c)).join('\n') + (cases.length > 0 ? '\n' : '');
}

// Hangul Jamo, Compatibility Jamo, Jamo Extended-A, Syllables, Jamo Extended-B.
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;

/** `ko` when any Hangul is present in the text, else `en`. */
export function detectLang(text: string): CaseLang {
  return HANGUL.test(text) ? 'ko' : 'en';
}
