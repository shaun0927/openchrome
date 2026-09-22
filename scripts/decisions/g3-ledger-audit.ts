import * as fs from 'fs';
import * as path from 'path';

const outDir = path.join('artifacts', 'decision', 'G3');
const ledgerPath = path.join('..', 'openchrome-decider-ledger.json');
const statusPath = path.join(outDir, 'logs', 'status.json');
const reportJsonPath = path.join(outDir, 'ledger-audit.json');
const reportMdPath = path.join(outDir, 'LEDGER_AUDIT.md');

interface LedgerGate {
  readonly state: string;
  readonly evidence: readonly string[];
  readonly closed_at: string | null;
}

interface Ledger {
  readonly gates: Record<string, LedgerGate>;
}

interface StatusFinding {
  readonly key: string;
  readonly value: unknown;
  readonly expected: number;
}

interface LedgerAudit {
  readonly generated_at: string;
  readonly gate: 'G3';
  readonly ok: boolean;
  readonly ledger_path: string;
  readonly evidence_count: number;
  readonly missing_evidence: readonly string[];
  readonly status_path: string;
  readonly bad_status_values: readonly StatusFinding[];
  readonly notes: readonly string[];
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evidenceExists(evidencePath: string): boolean {
  if (fs.existsSync(evidencePath)) return true;
  const normalized = evidencePath.replace(/\\/g, '/');
  return fs.existsSync(normalized);
}

function statusFindings(status: unknown): StatusFinding[] {
  if (!isRecord(status)) return [{ key: '<status>', value: status, expected: 0 }];
  const findings: StatusFinding[] = [];
  for (const [key, value] of Object.entries(status).sort(([left], [right]) => left.localeCompare(right))) {
    const expected = key.endsWith('_expected_failure') ? 1 : 0;
    if (value !== expected) findings.push({ key, value, expected });
  }
  return findings;
}

function markdown(report: LedgerAudit): string {
  const lines = [
    '# G3 ledger audit',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Verdict: ${report.ok ? 'ok' : 'not ok'}`,
    '',
    `Evidence entries: ${report.evidence_count}`,
    '',
    '## Missing Evidence',
    '',
  ];
  if (report.missing_evidence.length === 0) lines.push('- none');
  for (const item of report.missing_evidence) lines.push(`- \`${item}\``);
  lines.push('', '## Status Findings', '');
  if (report.bad_status_values.length === 0) lines.push('- none');
  for (const finding of report.bad_status_values) {
    lines.push(`- ${finding.key}: expected ${finding.expected}, got ${JSON.stringify(finding.value)}`);
  }
  lines.push('', '## Notes', '');
  for (const note of report.notes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const ledger = readJson<Ledger>(ledgerPath);
  const gate = ledger.gates.G3;
  if (!gate) throw new Error('G3 ledger gate missing');
  const missing = gate.evidence.filter((item) => !evidenceExists(item));
  const status = readJson<unknown>(statusPath);
  const badStatusValues = statusFindings(status);
  const report: LedgerAudit = {
    generated_at: new Date().toISOString(),
    gate: 'G3',
    ok: missing.length === 0 && badStatusValues.length === 0,
    ledger_path: ledgerPath,
    evidence_count: gate.evidence.length,
    missing_evidence: missing,
    status_path: statusPath,
    bad_status_values: badStatusValues,
    notes: [
      'This audit checks ledger evidence paths and command-status expectations only.',
      'It does not close G3; closure remains controlled by preflight and external evidence.',
    ],
  };
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportMdPath, markdown(report), 'utf8');
  console.log(JSON.stringify({ output: reportJsonPath, ok: report.ok, missing: missing.length, bad_status_values: badStatusValues.length }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main();
