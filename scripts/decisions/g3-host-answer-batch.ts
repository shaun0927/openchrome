import * as fs from 'fs';
import * as path from 'path';
import {
  GATE_ANSWERS,
  IRREVERSIBLE_ANSWERS,
  OUTCOME_ANSWERS,
  parseCorpus,
  type DecisionCase,
  type ElementCase,
  type GateCase,
  type IrreversibleCase,
  type OutcomeCase,
} from '../../tests/fixtures/decisions/schema';
import { buildElementDecisionView } from '../../src/pilot/decider/view';

const corpusPath = path.join('tests', 'fixtures', 'decisions', 'pool-fixture.labeled.jsonl');
const tablePath = path.join('artifacts', 'decision', 'G3', 'insertion-tables.json');
const outDir = path.join('artifacts', 'decision', 'G3', 'host-answer-batch');

interface InsertionTable {
  readonly insertion: string;
  readonly trigger: string;
  readonly case_ids: readonly string[];
}

interface InsertionTablesReport {
  readonly tables: readonly InsertionTable[];
}

interface Choice {
  readonly id: string;
  readonly label: string;
}

interface HostQuestion {
  readonly id: string;
  readonly insertion: string;
  readonly kind: DecisionCase['kind'];
  readonly instructions: string;
  readonly choices: readonly Choice[];
  readonly state: unknown;
}

interface BatchManifest {
  readonly generated_at: string;
  readonly corpus_path: string;
  readonly insertion_tables_path: string;
  readonly request_jsonl: string;
  readonly answer_schema: {
    readonly shape: 'answers_map';
    readonly example: Record<string, { readonly answer: string; readonly confidence: number }>;
  };
  readonly counts: Record<string, number>;
  readonly notes: readonly string[];
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readCorpus(): Map<string, DecisionCase> {
  const parsed = parseCorpus(fs.readFileSync(corpusPath, 'utf8'));
  if (parsed.errors.length > 0) throw new Error(`invalid corpus: ${JSON.stringify(parsed.errors)}`);
  return new Map(parsed.cases.map((caseItem) => [caseItem.id, caseItem]));
}

function readTables(): InsertionTable[] {
  const parsed = readJson(tablePath);
  if (!isRecord(parsed) || !Array.isArray(parsed.tables)) throw new Error(`invalid insertion table report: ${tablePath}`);
  return parsed.tables.filter(isInsertionTable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInsertionTable(value: unknown): value is InsertionTable {
  return isRecord(value)
    && typeof value.insertion === 'string'
    && typeof value.trigger === 'string'
    && Array.isArray(value.case_ids)
    && value.case_ids.every((id) => typeof id === 'string');
}

function choice(id: string, label: string): Choice {
  return { id, label };
}

function elementQuestion(caseItem: ElementCase, insertion: string): HostQuestion {
  const built = buildElementDecisionView({
    id: caseItem.id,
    query: caseItem.input.query,
    targets: caseItem.input.view.targets,
    above: caseItem.input.view.above,
    below: caseItem.input.view.below,
    history: caseItem.input.view.history,
  });
  return {
    id: caseItem.id,
    insertion,
    kind: 'element',
    instructions: built.question.instructions,
    choices: built.question.choices,
    state: built.question.state,
  };
}

function outcomeQuestion(caseItem: OutcomeCase, insertion: string): HostQuestion {
  return {
    id: caseItem.id,
    insertion,
    kind: 'outcome',
    instructions: 'Classify what happened after the browser action.',
    choices: OUTCOME_ANSWERS.map((answer) => choice(answer, answer)),
    state: caseItem.input,
  };
}

function irreversibleQuestion(caseItem: IrreversibleCase, insertion: string): HostQuestion {
  return {
    id: caseItem.id,
    insertion,
    kind: 'irreversible',
    instructions: 'Choose the policy gate required before this tool call may proceed.',
    choices: IRREVERSIBLE_ANSWERS.map((answer) => choice(answer, answer)),
    state: caseItem.input,
  };
}

function gateQuestion(caseItem: GateCase, insertion: string): HostQuestion {
  return {
    id: caseItem.id,
    insertion,
    kind: 'gate',
    instructions: 'Choose which access gate is blocking this page, or none.',
    choices: GATE_ANSWERS.map((answer) => choice(answer, answer)),
    state: caseItem.input,
  };
}

function buildQuestion(caseItem: DecisionCase, insertion: string): HostQuestion {
  switch (caseItem.kind) {
    case 'element': return elementQuestion(caseItem, insertion);
    case 'outcome': return outcomeQuestion(caseItem, insertion);
    case 'irreversible': return irreversibleQuestion(caseItem, insertion);
    case 'gate': return gateQuestion(caseItem, insertion);
  }
}

function markdown(manifest: BatchManifest): string {
  return [
    '# G3 host answer batch',
    '',
    `Generated: ${manifest.generated_at}`,
    '',
    `Requests: \`${manifest.request_jsonl}\``,
    '',
    'Answer file shape:',
    '',
    '```json',
    JSON.stringify(manifest.answer_schema.example, null, 2),
    '```',
    '',
    'Counts:',
    '',
    ...Object.entries(manifest.counts).map(([insertion, count]) => `- ${insertion}: ${count}`),
    '',
    'Notes:',
    '',
    ...manifest.notes.map((note) => `- ${note}`),
    '',
  ].join('\n');
}

function main(): void {
  const cases = readCorpus();
  const tables = readTables();
  const questions: HostQuestion[] = [];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table.insertion] = table.case_ids.length;
    for (const id of table.case_ids) {
      const caseItem = cases.get(id);
      if (!caseItem) throw new Error(`case id from insertion table not found in corpus: ${id}`);
      questions.push(buildQuestion(caseItem, table.insertion));
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const requestPath = path.join(outDir, 'requests.jsonl');
  const manifestPath = path.join(outDir, 'manifest.json');
  const instructionsPath = path.join(outDir, 'README.md');
  fs.writeFileSync(requestPath, questions.map((question) => JSON.stringify(question)).join('\n') + (questions.length > 0 ? '\n' : ''), 'utf8');
  const manifest: BatchManifest = {
    generated_at: new Date().toISOString(),
    corpus_path: corpusPath,
    insertion_tables_path: tablePath,
    request_jsonl: requestPath,
    answer_schema: {
      shape: 'answers_map',
      example: {
        '<case-id>': {
          answer: '<one choice id from that request>',
          confidence: 0.8,
        },
      },
    },
    counts,
    notes: [
      'Requests contain no label or truth_hint fields.',
      'Element requests use the G2 decision view builder and therefore the same bounded target set as G3 evaluation.',
      'Write host answers as a JSON object accepted by the file provider, run npm run validate-host:g3 -- --answers <answers.json>, then run npm run evidence:g3 -- --host-answers <answers.json> followed by npm run tables:g3.',
    ],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(instructionsPath, markdown(manifest), 'utf8');
  console.log(JSON.stringify({ output: requestPath, count: questions.length, counts }, null, 2));
}

main();
