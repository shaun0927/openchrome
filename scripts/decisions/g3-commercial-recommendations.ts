import * as fs from 'fs';
import * as path from 'path';

const outDir = path.join('artifacts', 'decision', 'G3');
const jsonOut = path.join(outDir, 'commercial-recommendations.json');
const mdOut = path.join(outDir, 'COMMERCIAL_RECOMMENDATIONS.md');

interface ProviderTable {
  readonly insertion: string;
  readonly providers: readonly {
    readonly provider: string;
    readonly role: string;
    readonly status: string;
    readonly accuracy: number | null;
    readonly note: string | null;
  }[];
}

interface InsertionTables {
  readonly tables: readonly ProviderTable[];
}

interface ReadinessCounts {
  readonly a_element_cases?: number;
  readonly a_cases_ready?: number;
  readonly gate_cases_total?: number;
  readonly a_gate_cases?: number;
  readonly b_gate_cases?: number;
}

interface CommercialRecommendation {
  readonly generated_at: string;
  readonly verdict: 'do_not_ship_jev_claim_yet';
  readonly executive_summary: string;
  readonly recommended_sequence: readonly {
    readonly rank: number;
    readonly item: string;
    readonly action: string;
    readonly commercial_value: string;
    readonly evidence: readonly string[];
    readonly blocking_condition: string | null;
  }[];
  readonly do_not_claim: readonly string[];
  readonly external_inputs_required: readonly string[];
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function tableFor(tables: InsertionTables, insertion: string): ProviderTable {
  const table = tables.tables.find((item) => item.insertion === insertion);
  if (!table) throw new Error(`missing insertion table: ${insertion}`);
  return table;
}

function providerSummary(table: ProviderTable, provider: string): string {
  const row = table.providers.find((item) => item.provider === provider);
  if (!row) return `${provider}: missing`;
  const accuracy = row.accuracy === null ? '-' : String(row.accuracy);
  return `${provider}: ${row.status}, accuracy ${accuracy}${row.note ? `, ${row.note}` : ''}`;
}

function markdown(report: CommercialRecommendation): string {
  const lines = [
    '# OpenChrome / Jev commercial recommendations',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Verdict: ${report.verdict}`,
    '',
    report.executive_summary,
    '',
    '## Recommended Sequence',
    '',
    '| rank | item | action | commercial value | blocking condition |',
    '| ---: | --- | --- | --- | --- |',
  ];
  for (const item of report.recommended_sequence) {
    lines.push(`| ${item.rank} | ${item.item} | ${item.action} | ${item.commercial_value} | ${item.blocking_condition ?? '-'} |`);
  }
  lines.push('', '## Evidence', '');
  for (const item of report.recommended_sequence) {
    lines.push(`### ${item.rank}. ${item.item}`, '');
    for (const evidence of item.evidence) lines.push(`- ${evidence}`);
    lines.push('');
  }
  lines.push('## Do Not Claim', '');
  for (const item of report.do_not_claim) lines.push(`- ${item}`);
  lines.push('', '## External Inputs Required', '');
  for (const item of report.external_inputs_required) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const tables = readJson<InsertionTables>(path.join(outDir, 'insertion-tables.json'));
  const element = readJson<{ counts: ReadinessCounts }>(path.join(outDir, 'element-telemetry-readiness.json'));
  const gate = readJson<{ counts: ReadinessCounts; verdict: { recommendation: string } }>(path.join(outDir, 'gate-readiness.json'));
  const outcomeTable = tableFor(tables, 'outcome_classification');
  const irreversibleTable = tableFor(tables, 'irreversible_policy');
  const elementTable = tableFor(tables, 'element_search');
  const gateTable = tableFor(tables, 'gate_detection');
  const report: CommercialRecommendation = {
    generated_at: new Date().toISOString(),
    verdict: 'do_not_ship_jev_claim_yet',
    executive_summary: 'The evidence supports building Jev as a bounded reviewer surface, not as a replacement for OpenChrome deterministic automation. The first commercially meaningful path is reliability and safety review around failed/suspicious actions and irreversible actions. Element routing and gate detection need more evidence before they can become product claims.',
    recommended_sequence: [
      {
        rank: 1,
        item: 'Outcome review for failed or suspicious interactions',
        action: 'Pilot Jev only when deterministic outcome classification returns SILENT_CLICK or WRONG_ELEMENT.',
        commercial_value: 'Improves enterprise reliability story by turning silent failures into explainable recovery decisions without slowing successful actions.',
        evidence: [
          providerSummary(outcomeTable, 'regex'),
          providerSummary(outcomeTable, 'typesafe'),
          providerSummary(outcomeTable, 'laya-local'),
          'IMPLEMENTATION_MAP.md maps this path to classifyOutcome, act, interact, Ralph, and createTypeSafeDecisionProvider.',
        ],
        blocking_condition: 'Needs approval record and host answers before benefit can be claimed.',
      },
      {
        rank: 2,
        item: 'Irreversible-action policy review',
        action: 'Use Jev as an additional reviewer for mutation actions while deterministic policy remains the hard boundary.',
        commercial_value: 'Supports commercial safety, auditability, and compliance positioning for browser automation that can submit forms, order items, or mutate account state.',
        evidence: [
          providerSummary(irreversibleTable, 'regex'),
          providerSummary(irreversibleTable, 'typesafe'),
          providerSummary(irreversibleTable, 'laya-local'),
          'IMPLEMENTATION_MAP.md maps this path to evaluateToolRiskPolicy, oc_policy, irreversible-action lifecycle events, and pilot runtime hooks.',
        ],
        blocking_condition: 'Needs trust-model approval, approval record, and host answers.',
      },
      {
        rank: 3,
        item: 'Element-search telemetry before Jev routing',
        action: 'Record AX match level and CSS score in A-run history before considering Jev for element selection.',
        commercial_value: 'Prevents over-selling element selection while creating the telemetry needed for future high-value self-healing target resolution.',
        evidence: [
          providerSummary(elementTable, 'regex'),
          `ELEMENT_TELEMETRY_READINESS.md: ${element.counts.a_element_cases ?? 0} A element cases, ${element.counts.a_cases_ready ?? 0} ready.`,
        ],
        blocking_condition: 'A element cases need AX match level and CSS score telemetry or an approved trigger revision.',
      },
      {
        rank: 4,
        item: 'Gate detection exclusion for current G3',
        action: 'Exclude gate_detection from this G3 unless labeled gate cases are added.',
        commercial_value: 'Avoids unsupported claims around CAPTCHA/login/paywall/2FA handling while keeping a clear future product lane.',
        evidence: [
          providerSummary(gateTable, 'regex'),
          `GATE_READINESS.md: ${gate.counts.gate_cases_total ?? 0} gate cases, recommendation ${gate.verdict.recommendation}.`,
        ],
        blocking_condition: 'Needs approval-based exclusion or labeled A/B gate cases.',
      },
    ],
    do_not_claim: [
      'Do not claim Jev or Laya improves OpenChrome until insertion tables and approvals support the specific insertion point.',
      'Do not claim host-file degradation works until host answers cover every request.',
      'Do not claim element_search is ready for Jev routing while A element telemetry readiness is 0.',
      'Do not claim gate_detection coverage from a zero-case corpus.',
    ],
    external_inputs_required: [
      'Approval response for approval-request.json.',
      'Host answers for host-answer-batch/requests.jsonl.',
      'AI_GATEWAY_API_KEY, TYPESAFE_API_KEY, or local Laya runtime evidence plus trust-model approval.',
      'AX/CSS element telemetry or an approved element trigger revision.',
      'Gate exclusion approval or labeled A/B gate cases.',
    ],
  };
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOut, markdown(report), 'utf8');
  console.log(JSON.stringify({ output: mdOut, verdict: report.verdict, recommendations: report.recommended_sequence.length }, null, 2));
}

main();
