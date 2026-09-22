import * as fs from 'fs';
import * as path from 'path';

const outDir = path.join('artifacts', 'decision', 'G3');
const statusPath = path.join(outDir, 'logs', 'status.json');
const freezeGapPath = path.join(outDir, 'freeze-gap-packet.json');
const hostValidationPath = path.join(outDir, 'host-answer-batch', 'validation-report.json');
const approvalValidationPath = path.join(outDir, 'approval-validation-report.json');
const insertionTablesPath = path.join(outDir, 'insertion-tables.json');
const summaryPath = path.join(outDir, 'closure-preflight.json');
const summaryMdPath = path.join(outDir, 'closure-preflight.md');

interface Check {
  readonly id: string;
  readonly ok: boolean;
  readonly evidence: string;
  readonly detail: string;
}

interface PreflightReport {
  readonly generated_at: string;
  readonly ok_to_close: boolean;
  readonly checks: readonly Check[];
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusCheck(): Check {
  const status = readJson(statusPath);
  if (!isRecord(status)) return { id: 'verification_status', ok: false, evidence: statusPath, detail: 'status is not an object' };
  const failing = Object.entries(status).filter(([key, value]) => !key.endsWith('_expected_failure') && value !== 0);
  return {
    id: 'verification_status',
    ok: Object.keys(status).length > 0 && failing.length === 0,
    evidence: statusPath,
    detail: failing.length === 0 ? 'all required verification commands exited 0' : `nonzero commands: ${failing.map(([key]) => key).join(', ')}`,
  };
}

function freezeCheck(): Check {
  const packet = readJson(freezeGapPath);
  if (!isRecord(packet) || !isRecord(packet.verdict)) return { id: 'threshold_freeze', ok: false, evidence: freezeGapPath, detail: 'freeze verdict missing' };
  const canClose = packet.verdict.can_close_g3_threshold_freeze === true;
  const reason = typeof packet.verdict.reason === 'string' ? packet.verdict.reason : 'no reason';
  return {
    id: 'threshold_freeze',
    ok: canClose,
    evidence: freezeGapPath,
    detail: reason,
  };
}

function hostCheck(): Check {
  const report = readJson(hostValidationPath);
  if (!isRecord(report)) return { id: 'host_file_column', ok: false, evidence: hostValidationPath, detail: 'host validation report missing' };
  const ok = report.ok === true && typeof report.answers_path === 'string' && typeof report.answer_count === 'number' && report.answer_count > 0 && report.answer_count === report.request_count;
  return {
    id: 'host_file_column',
    ok,
    evidence: hostValidationPath,
    detail: ok
      ? `validated ${report.answer_count} host answers`
      : 'host answers file is not supplied or does not cover every request',
  };
}

function approvalCheck(): Check {
  const report = readJson(approvalValidationPath);
  if (!isRecord(report)) return { id: 'approval_records', ok: false, evidence: approvalValidationPath, detail: 'approval validation report missing' };
  const ok = report.ok === true && typeof report.approvals_path === 'string' && typeof report.approval_count === 'number' && report.approval_count > 0 && report.approval_count === report.request_count;
  return {
    id: 'approval_records',
    ok,
    evidence: approvalValidationPath,
    detail: ok
      ? `validated ${report.approval_count} approval records`
      : 'approval response file is not supplied or does not cover every request',
  };
}

function decisionModelCheck(): Check {
  const tables = readJson(insertionTablesPath);
  if (!isRecord(tables) || !Array.isArray(tables.tables)) return { id: 'decision_model_column', ok: false, evidence: insertionTablesPath, detail: 'insertion tables missing' };
  const requiredInsertions = new Set(['outcome_classification', 'irreversible_policy']);
  const insertionTables = tables.tables;
  const missing = [...requiredInsertions].filter((insertion) => !insertionTables.some((table) =>
    isRecord(table) && table.insertion === insertion && Array.isArray(table.providers) &&
    table.providers.some((provider) => isRecord(provider) &&
      (provider.provider === 'typesafe' || provider.provider === 'laya-local') && provider.status === 'ok' &&
      typeof provider.count === 'number' && provider.count > 0)));
  return {
    id: 'decision_model_column',
    ok: missing.length === 0,
    evidence: insertionTablesPath,
    detail: missing.length === 0
      ? 'A non-skipped model column exists for outcome_classification and irreversible_policy'
      : `model column missing/skipped for: ${missing.join(', ')}`,
  };
}

function markdown(report: PreflightReport): string {
  const lines = [
    '# G3 closure preflight',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Verdict: ${report.ok_to_close ? 'ok to close' : 'not ready'}`,
    '',
    '| check | ok | evidence | detail |',
    '| --- | --- | --- | --- |',
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.id} | ${check.ok ? 'yes' : 'no'} | \`${check.evidence}\` | ${check.detail} |`);
  }
  return `${lines.join('\n')}\n`;
}

function main(): void {
  fs.mkdirSync(outDir, { recursive: true });
  const checks = [statusCheck(), freezeCheck(), hostCheck(), approvalCheck(), decisionModelCheck()];
  const report: PreflightReport = {
    generated_at: new Date().toISOString(),
    ok_to_close: checks.every((check) => check.ok),
    checks,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(summaryMdPath, markdown(report), 'utf8');
  console.log(JSON.stringify({
    output: summaryPath,
    ok_to_close: report.ok_to_close,
    failed: report.checks.filter((check) => !check.ok).map((check) => check.id),
  }, null, 2));
}

main();
