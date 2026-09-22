import * as fs from 'fs';
import * as path from 'path';
import {
  detectLang, parseCorpus, serializeCorpus, validateCase,
} from '../fixtures/decisions/schema';
import type { DecisionCase } from '../fixtures/decisions/schema';

const elementCase: DecisionCase = {
  id: 'fixture-element-1',
  kind: 'element',
  lang: 'en',
  pool: 'fixture',
  input: {
    query: 'Sign in button',
    view: {
      targets: [
        { ref: 'ref_1', role: 'button', name: 'Sign in', value: '', state: '' },
        { ref: 'ref_2', role: 'link', name: 'Help', value: '', state: '' },
      ],
      above: 0,
      below: 3,
      history: [{ action: 'click ref_2', result: 'SILENT_CLICK' }],
    },
  },
  label: { answer: 'ref_1', labeler: 'test' },
};

describe('decision corpus schema', () => {
  it('accepts a well-formed element case with and without a label', () => {
    expect(validateCase(elementCase)).toEqual({ ok: true, errors: [] });
    const { label: _label, ...unlabeled } = elementCase;
    expect(validateCase({ ...unlabeled, truth_hint: { from: 'harness' } }).ok).toBe(true);
  });

  it('accepts optional element resolution telemetry in history entries', () => {
    const withTelemetry = {
      ...elementCase,
      input: {
        ...elementCase.input,
        view: {
          ...elementCase.input.view,
          history: [
            { action: 'click ref_2', result: 'SILENT_CLICK', resolution: { resolver: 'ax', ax_match_level: 3 } },
            { action: 'click ref_1', result: 'SUCCESS', resolution: { resolver: 'css', css_score: 42 } },
          ],
        },
      },
    };
    expect(validateCase(withTelemetry)).toEqual({ ok: true, errors: [] });
  });

  it('accepts every kind with a valid answer', () => {
    const cases: DecisionCase[] = [
      { id: 'o1', kind: 'outcome', lang: 'en', pool: 'public', input: { delta: '', target_role: 'button' }, label: { answer: 'SILENT_CLICK', labeler: 't' } },
      { id: 'i1', kind: 'irreversible', lang: 'ko', pool: 'fixture', input: { tool: 'act', args: { query: '결제' }, page_context: {} }, label: { answer: 'elicitation_required', labeler: 't' } },
      { id: 'g1', kind: 'gate', lang: 'en', pool: 'public', split: 'B', input: { title: 'Just a moment...', text_excerpt: 'cloudflare' }, label: { answer: 'bot_check', labeler: 't' } },
    ];
    for (const c of cases) expect(validateCase(c)).toEqual({ ok: true, errors: [] });
  });

  it('rejects bad enum values, bad labels, and refs missing from the view', () => {
    expect(validateCase({ ...elementCase, kind: 'thing' }).errors).toContain('kind must be one of element|outcome|irreversible|gate');
    expect(validateCase({ ...elementCase, lang: 'jp' }).errors[0]).toMatch(/lang must be/);
    expect(validateCase({ ...elementCase, pool: 'web' }).errors[0]).toMatch(/pool must be/);
    expect(validateCase({ ...elementCase, split: 'C' }).errors[0]).toMatch(/split must be/);
    expect(validateCase({ ...elementCase, label: { answer: 'ref_9', labeler: 't' } }).errors[0]).toMatch(/not a ref in input.view.targets/);
    expect(validateCase({ ...elementCase, label: { answer: 'ref_1' } }).errors[0]).toMatch(/label.labeler/);
    const outcome = { id: 'o', kind: 'outcome', lang: 'en', pool: 'fixture', input: { delta: 'x' }, label: { answer: 'MAYBE', labeler: 't' } };
    expect(validateCase(outcome).errors[0]).toMatch(/label.answer "MAYBE" is not in/);
    const irreversible = { id: 'i', kind: 'irreversible', lang: 'en', pool: 'fixture', input: { tool: '', args: {}, page_context: {} } };
    expect(validateCase(irreversible).errors[0]).toMatch(/input.tool must be non-empty/);
    const gate = { id: 'g', kind: 'gate', lang: 'en', pool: 'fixture', input: { title: 1, text_excerpt: 'x' } };
    expect(validateCase(gate).errors[0]).toMatch(/input.title must be a string/);
  });

  it('rejects malformed element resolution telemetry', () => {
    const bad = {
      ...elementCase,
      input: {
        ...elementCase.input,
        view: {
          ...elementCase.input.view,
          history: [{ action: 'click ref_2', result: 'SILENT_CLICK', resolution: { resolver: 'ax', ax_match_level: 9, css_score: 'low' } }],
        },
      },
    };
    expect(validateCase(bad).errors).toEqual([
      'input.view.history[0].resolution.ax_match_level must be an integer 1..4 when present',
      'input.view.history[0].resolution.css_score must be a finite number when present',
    ]);
  });

  it('rejects duplicate refs inside one view and duplicate ids across a file', () => {
    const dup = {
      ...elementCase,
      input: { ...elementCase.input, view: { ...elementCase.input.view, targets: [...elementCase.input.view.targets, { ref: 'ref_1', role: 'button', name: 'x', value: '', state: '' }] } },
    };
    expect(validateCase(dup).errors.some((e) => e.includes('duplicated'))).toBe(true);
    const text = serializeCorpus([elementCase, elementCase]);
    const parsed = parseCorpus(text);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.errors[0].errors).toContain('duplicate id "fixture-element-1"');
  });

  it('reports non-JSON lines by line number and skips blank lines', () => {
    const text = `${JSON.stringify(elementCase)}\n\nnot json\n`;
    const parsed = parseCorpus(text);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.errors).toEqual([{ line: 3, errors: [expect.stringMatching(/invalid JSON/)] }]);
  });

  it('detects Hangul as ko', () => {
    expect(detectLang('로그인 버튼')).toBe('ko');
    expect(detectLang('Sign in')).toBe('en');
    expect(detectLang('ㄱㄴㄷ compat jamo')).toBe('ko');
  });

  it('validates the extracted trajectory pool when present', () => {
    const file = path.join(__dirname, '..', 'fixtures', 'decisions', 'pool-trajectory.unlabeled.jsonl');
    if (!fs.existsSync(file)) return;
    const parsed = parseCorpus(fs.readFileSync(file, 'utf8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.cases.every((c) => c.pool === 'trajectory' && !c.label)).toBe(true);
  });
});
