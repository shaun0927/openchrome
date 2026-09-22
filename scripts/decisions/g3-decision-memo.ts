import * as fs from 'fs';
import * as path from 'path';

const outDir = path.join('artifacts', 'decision', 'G3');
const memoJsonPath = path.join(outDir, 'decision-memo.json');
const memoMdPath = path.join(outDir, 'DECISION_MEMO.md');

type Recommendation = 'candidate' | 'defer' | 'exclude_candidate';

interface ProviderCell {
  readonly provider: string;
  readonly role: string;
  readonly status: string;
  readonly count: number;
  readonly accuracy: number | null;
  readonly note: string | null;
}

interface InsertionTable {
  readonly insertion: string;
  readonly trigger: string;
  readonly threshold_status: string;
  readonly threshold_missing: readonly string[];
  readonly case_ids: readonly string[];
  readonly providers: readonly ProviderCell[];
}

interface FreezeGap {
  readonly insertion: string;
  readonly status: string;
  readonly a_count: number;
  readonly a_accuracy: number | null;
  readonly missing: readonly string[];
  readonly required_next_evidence: readonly string[];
}

interface PreflightCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface InsertionDecision {
  readonly insertion: string;
  readonly recommendation: Recommendation;
  readonly trigger: string;
  readonly b_cases: number;
  readonly a_status: string;
  readonly current_regex_accuracy: number | null;
  readonly jev_status: string;
  readonly host_status: string;
  readonly rationale: readonly string[];
  readonly next_evidence: readonly string[];
}

interface DecisionMemo {
  readonly generated_at: string;
  readonly verdict: 'g3_open';
  readonly summary: string;
  readonly gateway: {
    readonly jev_model_available: boolean;
    readonly model_id: string | null;
    readonly endpoint: string | null;
    readonly key_variable: string | null;
  };
  readonly closure_blockers: readonly PreflightCheck[];
  readonly insertions: readonly InsertionDecision[];
  readonly implementation_takeaways: readonly string[];
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`missing string: ${key}`);
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') throw new Error(`missing number: ${key}`);
  return value;
}

function nullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function providerCell(value: unknown): ProviderCell {
  if (!isRecord(value)) throw new Error('invalid provider cell');
  return {
    provider: stringValue(value, 'provider'),
    role: stringValue(value, 'role'),
    status: stringValue(value, 'status'),
    count: numberValue(value, 'count'),
    accuracy: nullableNumber(value, 'accuracy'),
    note: nullableString(value, 'note'),
  };
}

function insertionTables(): InsertionTable[] {
  const report = readJson(path.join(outDir, 'insertion-tables.json'));
  if (!isRecord(report) || !Array.isArray(report.tables)) throw new Error('invalid insertion tables report');
  return report.tables.map((value) => {
    if (!isRecord(value) || !Array.isArray(value.providers) || !Array.isArray(value.case_ids)) throw new Error('invalid insertion table');
    return {
      insertion: stringValue(value, 'insertion'),
      trigger: stringValue(value, 'trigger'),
      threshold_status: stringValue(value, 'threshold_status'),
      threshold_missing: stringArray(value.threshold_missing),
      case_ids: stringArray(value.case_ids),
      providers: value.providers.map(providerCell),
    };
  });
}

function freezeGaps(): Map<string, FreezeGap> {
  const packet = readJson(path.join(outDir, 'freeze-gap-packet.json'));
  if (!isRecord(packet) || !Array.isArray(packet.gaps)) throw new Error('invalid freeze gap packet');
  return new Map(packet.gaps.map((value) => {
    if (!isRecord(value)) throw new Error('invalid freeze gap');
    const gap: FreezeGap = {
      insertion: stringValue(value, 'insertion'),
      status: stringValue(value, 'status'),
      a_count: numberValue(value, 'a_count'),
      a_accuracy: nullableNumber(value, 'a_accuracy'),
      missing: stringArray(value.missing),
      required_next_evidence: stringArray(value.required_next_evidence),
    };
    return [gap.insertion, gap];
  }));
}

function preflightBlockers(): PreflightCheck[] {
  const report = readJson(path.join(outDir, 'closure-preflight.json'));
  if (!isRecord(report) || !Array.isArray(report.checks)) throw new Error('invalid preflight report');
  return report.checks.flatMap((value): PreflightCheck[] => {
    if (!isRecord(value) || typeof value.ok !== 'boolean') return [];
    if (value.ok) return [];
    return [{
      id: stringValue(value, 'id'),
      ok: false,
      detail: stringValue(value, 'detail'),
    }];
  });
}

function gatewaySummary(): DecisionMemo['gateway'] {
  const report = readJson(path.join(outDir, 'vercel-gateway', 'models-report.json'));
  if (!isRecord(report)) throw new Error('invalid gateway report');
  const jev = isRecord(report.jev_model) ? report.jev_model : null;
  const env = isRecord(report.recommended_env) ? report.recommended_env : {};
  return {
    jev_model_available: jev !== null,
    model_id: jev ? nullableString(jev, 'id') : null,
    endpoint: nullableString(env, 'TYPESAFE_ENDPOINT'),
    key_variable: nullableString(env, 'key_variable'),
  };
}

function provider(table: InsertionTable, name: string): ProviderCell {
  const found = table.providers.find((cell) => cell.provider === name);
  if (!found) throw new Error(`missing provider ${name} for ${table.insertion}`);
  return found;
}

function recommendation(table: InsertionTable, gap: FreezeGap): Recommendation {
  if (table.insertion === 'gate_detection' && gap.a_count === 0 && table.case_ids.length === 0) return 'exclude_candidate';
  if (gap.status === 'candidate' || gap.status === 'fixed_rule') return 'candidate';
  return 'defer';
}

function rationale(table: InsertionTable, gap: FreezeGap): string[] {
  const regex = provider(table, 'regex');
  const jev = provider(table, 'typesafe');
  const host = provider(table, 'file');
  const lines = [
    `A status is ${gap.status} with ${gap.a_count} A cases.`,
    `B trigger set has ${table.case_ids.length} cases; current-regex accuracy is ${regex.accuracy ?? 'unknown'}.`,
  ];
  if (gap.missing.length > 0) lines.push(`Missing evidence: ${gap.missing.join('; ')}.`);
  if (jev.status !== 'ok') lines.push(`Jev column is ${jev.status}${jev.note ? ` (${jev.note})` : ''}.`);
  if (host.status !== 'ok') lines.push(`Host-file column is ${host.status}${host.note ? ` (${host.note})` : ''}.`);
  return lines;
}

function nextEvidence(gap: FreezeGap): string[] {
  return gap.required_next_evidence.length > 0 ? [...gap.required_next_evidence] : ['Approval record for this insertion'];
}

function decisionFor(table: InsertionTable, gaps: Map<string, FreezeGap>): InsertionDecision {
  const gap = gaps.get(table.insertion);
  if (!gap) throw new Error(`missing gap for ${table.insertion}`);
  const jev = provider(table, 'typesafe');
  const host = provider(table, 'file');
  const regex = provider(table, 'regex');
  return {
    insertion: table.insertion,
    recommendation: recommendation(table, gap),
    trigger: table.trigger,
    b_cases: table.case_ids.length,
    a_status: gap.status,
    current_regex_accuracy: regex.accuracy,
    jev_status: jev.status,
    host_status: host.status,
    rationale: rationale(table, gap),
    next_evidence: nextEvidence(gap),
  };
}

function markdown(memo: DecisionMemo): string {
  const lines = [
    '# G3 decision memo',
    '',
    `Generated: ${memo.generated_at}`,
    '',
    `Verdict: ${memo.verdict}`,
    '',
    memo.summary,
    '',
    '## Gateway',
    '',
    `- Jev model available: ${memo.gateway.jev_model_available ? 'yes' : 'no'}`,
    `- Model: ${memo.gateway.model_id ?? '-'}`,
    `- Endpoint: ${memo.gateway.endpoint ?? '-'}`,
    `- Key variable: ${memo.gateway.key_variable ?? '-'}`,
    '',
    '## Insertions',
    '',
    '| insertion | recommendation | A status | B cases | regex accuracy | Jev | host |',
    '| --- | --- | --- | ---: | ---: | --- | --- |',
  ];
  for (const insertion of memo.insertions) {
    lines.push(`| ${insertion.insertion} | ${insertion.recommendation} | ${insertion.a_status} | ${insertion.b_cases} | ${insertion.current_regex_accuracy ?? '-'} | ${insertion.jev_status} | ${insertion.host_status} |`);
  }
  for (const insertion of memo.insertions) {
    lines.push('', `### ${insertion.insertion}`, '', `Trigger: ${insertion.trigger}`, '');
    lines.push('Rationale:');
    lines.push('');
    for (const item of insertion.rationale) lines.push(`- ${item}`);
    lines.push('', 'Next evidence:');
    lines.push('');
    for (const item of insertion.next_evidence) lines.push(`- ${item}`);
  }
  lines.push('', '## Closure Blockers', '');
  for (const blocker of memo.closure_blockers) lines.push(`- ${blocker.id}: ${blocker.detail}`);
  lines.push('', '## Implementation Takeaways', '');
  for (const takeaway of memo.implementation_takeaways) lines.push(`- ${takeaway}`);
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const tables = insertionTables();
  const gaps = freezeGaps();
  const decisions = tables.map((table) => decisionFor(table, gaps));
  const memo: DecisionMemo = {
    generated_at: new Date().toISOString(),
    verdict: 'g3_open',
    summary: 'Only outcome_classification and irreversible_policy are current implementation candidates. element_search is deferred pending AX/CSS telemetry, and gate_detection is an exclusion candidate because the corpus has no gate cases.',
    gateway: gatewaySummary(),
    closure_blockers: preflightBlockers(),
    insertions: decisions,
    implementation_takeaways: [
      'Keep the G2 bounded decision view as the provider input surface.',
      'Use Vercel AI Gateway chat-completions mode for Jev once an AI Gateway key is available.',
      'Do not route element_search to Jev until AX cascade and CSS-score telemetry support a frozen trigger.',
      'Do not claim Jev improves OpenChrome until the Jev column has non-skipped B results.',
    ],
  };
  fs.writeFileSync(memoJsonPath, `${JSON.stringify(memo, null, 2)}\n`, 'utf8');
  fs.writeFileSync(memoMdPath, markdown(memo), 'utf8');
  console.log(JSON.stringify({ output: memoJsonPath, verdict: memo.verdict, candidates: decisions.filter((item) => item.recommendation === 'candidate').map((item) => item.insertion) }, null, 2));
}

main();
