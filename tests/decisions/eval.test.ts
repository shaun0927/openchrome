import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyBrokenInput, applyViewMode, checkRemoveCorrectGuard, computeCalibration, evaluateProvider, runEvaluation,
} from '../../scripts/decisions/evaluate';
import { createProvider } from '../../scripts/decisions/providers';
import type { DecisionProvider } from '../../scripts/decisions/providers';
import {
  buildOpenAIChatRequest,
  buildRequest,
  createTypeSafeProvider,
  parseOpenAIChatResponse,
  parseResponse,
} from '../../scripts/decisions/providers/typesafe';
import { parseCorpus, serializeCorpus } from '../fixtures/decisions/schema';
import type { DecisionCase, ElementCase } from '../fixtures/decisions/schema';

function element(id: string, query: string, targets: Array<[string, string, string]>, answer: string, lang: 'ko' | 'en' = 'en'): ElementCase {
  return {
    id, kind: 'element', lang, pool: 'fixture', split: 'A',
    input: { query, view: { targets: targets.map(([ref, role, name]) => ({ ref, role, name, value: '', state: '' })), above: 0, below: 0, history: [] } },
    label: { answer, labeler: 'synthetic' },
    meta: { cheat: answer },
  };
}

/** Ten labeled cases; every regex answer below is derived from the repo heuristics. */
const CORPUS: DecisionCase[] = [
  element('fx-el-1', 'Sign in button', [['ref_1', 'button', 'Sign in'], ['ref_2', 'link', 'Help']], 'ref_1'),
  element('fx-el-2', 'Help link', [['ref_1', 'button', 'Sign in'], ['ref_2', 'link', 'Help']], 'ref_2'),
  element('fx-el-3', '로그인', [['ref_1', 'button', '로그인'], ['ref_2', 'button', '취소']], 'ref_1', 'ko'),
  element('fx-el-4', 'Delete account', [['ref_1', 'button', 'Save'], ['ref_2', 'link', 'Home']], 'none'),
  { id: 'fx-out-1', kind: 'outcome', lang: 'en', pool: 'fixture', split: 'B', input: { delta: '', target_role: 'button' }, label: { answer: 'SILENT_CLICK', labeler: 'synthetic' } },
  { id: 'fx-out-2', kind: 'outcome', lang: 'en', pool: 'fixture', split: 'B', input: { delta: '~ button "Save" aria-pressed=true', target_role: 'button' }, label: { answer: 'SUCCESS', labeler: 'synthetic' } },
  { id: 'fx-irr-1', kind: 'irreversible', lang: 'en', pool: 'public', split: 'A', input: { tool: 'read_page', args: {}, page_context: {} }, label: { answer: 'allow', labeler: 'synthetic' } },
  { id: 'fx-irr-2', kind: 'irreversible', lang: 'en', pool: 'public', split: 'B', input: { tool: 'cookies', args: { action: 'delete' }, page_context: {} }, label: { answer: 'preview_required', labeler: 'synthetic' } },
  { id: 'fx-gate-1', kind: 'gate', lang: 'en', pool: 'public', split: 'A', input: { title: 'Just a moment...', text_excerpt: 'Checking your browser. Cloudflare' }, label: { answer: 'bot_check', labeler: 'synthetic' } },
  { id: 'fx-gate-2', kind: 'gate', lang: 'en', pool: 'public', split: 'B', input: { title: 'Weather', text_excerpt: 'Sunny, 24C' }, label: { answer: 'none', labeler: 'synthetic' } },
];

/** Answers by reading the view for the hidden correct ref: perfect on intact AND broken input. */
function perfectProvider(): DecisionProvider {
  return {
    name: 'perfect',
    async decide(c) {
      if (c.kind !== 'element') return { answer: c.label?.answer ?? 'none', confidence: 1, abstain: false };
      const cheat = String(c.meta?.cheat ?? 'none');
      const present = c.input.view.targets.some((t) => t.ref === cheat);
      return present ? { answer: cheat, confidence: 1, abstain: false } : { answer: 'none', confidence: 1, abstain: true };
    },
  };
}

let tmp: string;
let corpusPath: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-eval-'));
  corpusPath = path.join(tmp, 'corpus.jsonl');
  fs.writeFileSync(corpusPath, serializeCorpus(CORPUS));
  expect(parseCorpus(fs.readFileSync(corpusPath, 'utf8')).errors).toEqual([]);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('evaluator: providers on a synthetic corpus', () => {
  it('noop abstains everywhere and is right only where the label is none', async () => {
    const report = await evaluateProvider(createProvider('noop'), CORPUS);
    expect(report.evaluated).toBe(10);
    expect(report.overall.abstainRate).toBe(1);
    expect(report.overall.accuracy).toBe(0.2); // fx-el-4 and fx-gate-2
    expect(report.calibration[0]).toMatchObject({ count: 10, correct: 2 });
    expect(report.calibration.filter((b) => b.count > 0)).toHaveLength(1);
  });

  it('regex calls the repo heuristics and gets the synthetic corpus right', async () => {
    const report = await evaluateProvider(createProvider('regex'), CORPUS);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
    expect(byId['fx-el-1'].answer).toBe('ref_1');
    expect(byId['fx-el-2'].answer).toBe('ref_2');
    expect(byId['fx-el-3'].answer).toBe('ref_1');
    // Real heuristic behaviour: interactive targets get +20 unconditionally, so
    // scoreElement never abstains on a view that contains a button (see regex.ts).
    expect(byId['fx-el-4'].answer).toBe('ref_1');
    expect(byId['fx-out-1'].answer).toBe('SILENT_CLICK');
    expect(byId['fx-out-2'].answer).toBe('SUCCESS');
    expect(byId['fx-irr-1'].answer).toBe('allow');
    expect(byId['fx-irr-2'].answer).toBe('preview_required');
    expect(byId['fx-gate-1'].answer).toBe('bot_check');
    expect(byId['fx-gate-2'].answer).toBe('none');
    expect(report.overall.accuracy).toBe(0.9);
    expect(report.byKind.element.accuracy).toBe(0.75);
    expect(report.byLang.ko.count).toBe(1);
    expect(report.byPool.public.count).toBe(4);
    expect(report.bySplit.B.count).toBe(4);
    expect(report.byKind.element.count).toBe(4);
    expect(report.overall.p95LatencyMs).toBeGreaterThanOrEqual(report.overall.p50LatencyMs);
    // Confidence varies across branches so the calibration table has more than one live bin.
    expect(report.calibration.filter((b) => b.count > 0).length).toBeGreaterThan(1);
  });

  it('never shows the provider the label or truth_hint', async () => {
    const seen: DecisionCase[] = [];
    const spy: DecisionProvider = { name: 'spy', async decide(c) { seen.push(c); return { answer: 'none', confidence: 0, abstain: true }; } };
    await evaluateProvider(spy, CORPUS.map((c) => ({ ...c, truth_hint: { x: 1 } })));
    expect(seen.every((c) => !('label' in c) && !('truth_hint' in c))).toBe(true);
  });

  it('can evaluate element cases through the G2 view budget without labels in provider input', async () => {
    const cases = [
      element(
        'fx-view',
        'choose late target',
        Array.from({ length: 18 }, (_unused, index) => [`ref_${index}`, 'button', `Very long target name ${index}`]),
        'ref_17',
      ),
    ];
    const seen: DecisionCase[] = [];
    const spy: DecisionProvider = { name: 'spy', async decide(c) { seen.push(c); return { answer: 'none', confidence: 0, abstain: true }; } };
    const report = await evaluateProvider(spy, cases, { viewMode: 'g2-element' });
    expect(report.viewMode).toBe('g2-element');
    expect(seen).toHaveLength(1);
    expect('label' in seen[0]).toBe(false);
    expect('truth_hint' in seen[0]).toBe(false);
    expect(seen[0].kind === 'element' ? seen[0].input.view.targets.length : 0).toBeLessThanOrEqual(18);
    expect(seen[0].meta?.decision_view).toMatchObject({ mode: 'g2-element' });
  });

  it('file provider replays recorded answers and abstains on missing ids', async () => {
    const answers = path.join(tmp, 'answers.json');
    fs.writeFileSync(answers, JSON.stringify({ 'fx-el-1': { answer: 'ref_1', confidence: 0.9 }, 'fx-gate-2': 'none' }));
    const report = await evaluateProvider(createProvider('file', { answersFile: answers }), CORPUS);
    expect(report.overall.correct).toBe(2 + 1); // el-1, gate-2, and el-4 (abstain happens to be right)
    expect(report.overall.abstain).toBe(9);
    const skipped = await evaluateProvider(createProvider('file', {}), CORPUS);
    expect(skipped.skipped).toMatch(/no answers file/);
  });
});

describe('evaluator: G2 view mode', () => {
  it('truncates element input with the same builder used by G2', () => {
    const source = element(
      'fx-view-mode',
      'choose the final target',
      Array.from({ length: 80 }, (_unused, index) => [`ref_${index}`, 'button', `Long target label ${index}`]),
      'ref_79',
    );
    const transformed = applyViewMode([source], 'g2-element');
    const first = transformed[0];
    expect(first.kind).toBe('element');
    if (first.kind !== 'element') return;
    expect(first.input.view.targets.length).toBeLessThan(source.input.view.targets.length);
    expect(first.meta?.decision_view).toMatchObject({ mode: 'g2-element' });
  });
});

describe('evaluator: broken input', () => {
  it('remove-correct deletes the labeled target and relabels to none, without mutating', () => {
    const broken = applyBrokenInput(CORPUS, 'remove-correct');
    const el1 = broken.find((c) => c.id === 'fx-el-1') as ElementCase;
    expect(el1.input.view.targets.map((t) => t.ref)).toEqual(['ref_2']);
    expect(el1.label?.answer).toBe('none');
    expect((CORPUS[0] as ElementCase).input.view.targets).toHaveLength(2);
    expect(broken.find((c) => c.id === 'fx-el-4')).toBe(CORPUS[3]); // already none: untouched
    expect(broken.find((c) => c.id === 'fx-out-1')).toBe(CORPUS[4]);
  });

  it('rejects flip-labels with an explicit message', async () => {
    expect(() => applyBrokenInput(CORPUS, 'flip-labels')).toThrow(/not an accepted broken input/);
    const result = await runEvaluation({ corpusPath, providerNames: ['noop'], outDir: path.join(tmp, 'flip'), broken: 'flip-labels', stdout: () => {}, stderr: () => {} });
    expect(result.exitCode).toBe(2);
    expect(result.messages.join('\n')).toMatch(/flip-labels rejected: label flipping is not an accepted broken input/);
  });

  it('regex drops on remove-correct, so the guard passes and files are written', async () => {
    const outDir = path.join(tmp, 'regex');
    const printed: string[] = [];
    const result = await runEvaluation({ corpusPath, providerNames: ['regex'], outDir, broken: 'remove-correct', stdout: (t) => printed.push(t), stderr: () => {} });
    expect(result.exitCode).toBe(0);
    expect(result.guard?.ok).toBe(true);
    const regex = result.guard?.findings.find((f) => f.provider === 'regex');
    expect(regex?.intactElementAccuracy).toBe(0.75);
    expect(regex?.brokenElementAccuracy).toBe(0); // answers a distractor every time
    expect(regex?.stillAnsweredRemovedRef).toBe(0);
    expect(fs.existsSync(path.join(outDir, 'eval-noop.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'eval-regex.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'eval-regex.broken-remove-correct.json'))).toBe(true);
    expect(printed.join('')).toMatch(/\| overall \| n \| accuracy \|/);
    expect(printed.join('')).toMatch(/remove-correct guard passed/);
  });

  it('fires (prints and returns non-zero) when a provider above noop does not drop', async () => {
    const outDir = path.join(tmp, 'perfect');
    const printed: string[] = [];
    const result = await runEvaluation({
      corpusPath, providerNames: ['perfect'], outDir, broken: 'remove-correct',
      providerFactory: (name) => (name === 'perfect' ? perfectProvider() : createProvider(name)),
      stdout: (t) => printed.push(t), stderr: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.guard?.ok).toBe(false);
    expect(printed.join('')).toMatch(/GUARD FAILED/);
    expect(result.messages.join('\n')).toMatch(/remove-correct guard FAILED/);
  });

  it('guard ignores providers that do not beat noop', () => {
    const mk = (acc: number, count = 4) => ({ byKind: { element: { count, accuracy: acc } }, cases: [] }) as never;
    const intact = { noop: mk(0.25), weak: mk(0.25), strong: mk(1) };
    const broken = { noop: mk(1), weak: mk(1), strong: mk(0.25) };
    const guard = checkRemoveCorrectGuard(intact, broken);
    expect(guard.ok).toBe(true);
    expect(guard.findings.map((f) => [f.provider, f.ok])).toEqual([['weak', true], ['strong', true]]);
    expect(checkRemoveCorrectGuard({ noop: mk(0.25), strong: mk(1) }, { noop: mk(1), strong: mk(1) }).ok).toBe(false);
  });
});

describe('evaluator: typesafe provider', () => {
  const key = process.env.TYPESAFE_API_KEY;
  afterEach(() => {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
  });

  it('is skipped cleanly without a key and the run exits 0', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const outDir = path.join(tmp, 'typesafe');
    const result = await runEvaluation({ corpusPath, providerNames: ['typesafe'], outDir, stdout: () => {}, stderr: () => {} });
    expect(result.exitCode).toBe(0);
    expect(result.reports.typesafe.skipped).toBe('no key');
    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'eval-typesafe.json'), 'utf8'));
    expect(written.skipped).toBe('no key');
    expect(written.evaluated).toBe(0);
  });

  it('builds the SystemOne request shape and backs off on 429/529', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      n += 1;
      if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
      if (n === 2) return new Response('overloaded', { status: 529 });
      return new Response(JSON.stringify({ answers: { q: { choice: 'ref_1', confidence: 0.83 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = createTypeSafeProvider({ apiKey: 'test-key', fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    expect(await provider.init!()).toBeUndefined();
    const answer = await provider.decide(CORPUS[0]);
    expect(answer).toMatchObject({ answer: 'ref_1', confidence: 0.83, abstain: false });
    expect(sleeps).toEqual([2000, 2000]); // retry-after honoured, then 2^1 * 1000
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0].body).toMatchObject({
      model: 'jev-latest',
      questions: { q: { type: 'choice', criteria: { ref_1: 'button "Sign in"', ref_2: 'link "Help"', none_of_the_above: null } } },
    });
  });

  it('parses probability maps and none_of_the_above', () => {
    const req = buildRequest(CORPUS[8]);
    expect(Object.keys(req.questions.q.criteria)).toEqual(['bot_check', 'login', 'paywall', 'two_factor', 'none_of_the_above']);
    expect(parseResponse({ q: { bot_check: 0.7, login: 0.2 } }, Object.keys(req.questions.q.criteria))).toMatchObject({ answer: 'bot_check', confidence: 0.7 });
    expect(parseResponse({ results: { q: 'none_of_the_above' } }, [])).toMatchObject({ answer: 'none', abstain: true });
    expect(parseResponse({ unexpected: true }, []).abstain).toBe(true);
  });

  it('can use Vercel AI Gateway chat completions for Jev', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ q: { choice: 'ref_1', confidence: 0.91 } }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = createTypeSafeProvider({
      apiKey: 'test-key',
      endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      fetchImpl,
    });
    const answer = await provider.decide(CORPUS[0]);
    expect(answer).toMatchObject({ answer: 'ref_1', confidence: 0.91, abstain: false });
    expect(calls[0]).toMatchObject({
      url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      body: { model: 'typesafe-ai/jev', temperature: 0 },
    });
    expect(buildOpenAIChatRequest(CORPUS[0]).messages[1].content).toContain('Criteria:');
    expect(parseOpenAIChatResponse({ choices: [{ message: { content: 'ref_2' } }] }, ['ref_1', 'ref_2'])).toMatchObject({ answer: 'ref_2' });
  });
});

describe('evaluator: calibration bins', () => {
  it('uses ten bins with the top bin closed at 1.0', () => {
    const mk = (confidence: number, correct: boolean) => ({ confidence, correct }) as never;
    const bins = computeCalibration([mk(0, false), mk(0.05, true), mk(0.95, true), mk(1, false)]);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toMatchObject({ count: 2, correct: 1, accuracy: 0.5 });
    expect(bins[9]).toMatchObject({ count: 2, correct: 1, bin: '[0.9, 1.0]' });
    expect(bins[5].accuracy).toBeNull();
  });
});
