import * as fs from 'fs';
import * as path from 'path';

const requestPath = path.join('artifacts', 'decision', 'G3', 'approval-request.json');
const reportPath = path.join('artifacts', 'decision', 'G3', 'approval-validation-report.json');

type RequestedDecision = 'approve_freeze' | 'provide_more_evidence' | 'approve_exclusion';
type ApprovalDecision = 'approved' | 'rejected' | 'needs_more_evidence';

interface ApprovalItem {
  readonly id: string;
  readonly requested_decision: RequestedDecision;
}

interface ApprovalRequest {
  readonly items: readonly ApprovalItem[];
}

interface ApprovalRecord {
  readonly decision: ApprovalDecision;
  readonly approver: string;
  readonly notes: string;
}

interface Finding {
  readonly id: string;
  readonly problem: string;
}

interface ValidationReport {
  readonly generated_at: string;
  readonly request_path: string;
  readonly approvals_path: string | null;
  readonly request_count: number;
  readonly approval_count: number | null;
  readonly ok: boolean;
  readonly findings: readonly Finding[];
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequest(): ApprovalRequest {
  const parsed: unknown = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) throw new Error(`invalid approval request: ${requestPath}`);
  const items = parsed.items.flatMap((item): ApprovalItem[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRequestedDecision(item.requested_decision)) return [];
    return [{ id: item.id, requested_decision: item.requested_decision }];
  });
  if (items.length !== parsed.items.length) throw new Error(`invalid approval request item in ${requestPath}`);
  return { items };
}

function isRequestedDecision(value: unknown): value is RequestedDecision {
  return value === 'approve_freeze' || value === 'provide_more_evidence' || value === 'approve_exclusion';
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'approved' || value === 'rejected' || value === 'needs_more_evidence';
}

function readApprovals(file: string): Map<string, ApprovalRecord> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const container = isRecord(parsed) && isRecord(parsed.approvals) ? parsed.approvals : parsed;
  if (!isRecord(container)) throw new Error('approval response must be an object map or {approvals:{...}}');
  const approvals = new Map<string, ApprovalRecord>();
  for (const [id, value] of Object.entries(container)) {
    if (!isRecord(value)) continue;
    const decision = value.decision;
    const approver = value.approver;
    const notes = value.notes;
    if (!isApprovalDecision(decision) || typeof approver !== 'string' || approver.length === 0 || typeof notes !== 'string') continue;
    approvals.set(id, { decision, approver, notes });
  }
  return approvals;
}

function validateRecord(item: ApprovalItem, record: ApprovalRecord | undefined): Finding[] {
  if (!record) return [{ id: item.id, problem: 'missing approval record' }];
  const findings: Finding[] = [];
  if (item.requested_decision === 'provide_more_evidence' && record.decision === 'approved') {
    findings.push({ id: item.id, problem: 'cannot approve an item that requested more evidence' });
  }
  if (item.requested_decision === 'approve_exclusion' && record.decision === 'approved' && !/exclu|exclude|제외/i.test(record.notes)) {
    findings.push({ id: item.id, problem: 'approved exclusion must include an exclusion rationale in notes' });
  }
  if (item.requested_decision === 'approve_freeze' && record.decision === 'approved' && !/freeze|trigger|동결|임계/i.test(record.notes)) {
    findings.push({ id: item.id, problem: 'approved freeze must mention freeze/trigger rationale in notes' });
  }
  return findings;
}

function writeReport(report: ValidationReport): void {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function main(): void {
  const approvalsPath = argValue('--approvals') ?? process.env.G3_APPROVALS;
  const request = readRequest();
  const findings: Finding[] = [];
  let approvalCount: number | null = null;
  if (approvalsPath) {
    if (!fs.existsSync(approvalsPath)) {
      findings.push({ id: '<approvals>', problem: `approval file not found: ${approvalsPath}` });
    } else {
      const approvals = readApprovals(approvalsPath);
      approvalCount = approvals.size;
      const validIds = new Set(request.items.map((item) => item.id));
      for (const item of request.items) findings.push(...validateRecord(item, approvals.get(item.id)));
      for (const id of approvals.keys()) {
        if (!validIds.has(id)) findings.push({ id, problem: 'approval id is not present in approval request' });
      }
    }
  } else {
    findings.push({ id: '<approvals>', problem: 'approval file not supplied' });
  }
  const report: ValidationReport = {
    generated_at: new Date().toISOString(),
    request_path: requestPath,
    approvals_path: approvalsPath ?? null,
    request_count: request.items.length,
    approval_count: approvalCount,
    ok: findings.length === 0,
    findings,
  };
  writeReport(report);
  console.log(JSON.stringify({
    output: reportPath,
    request_count: report.request_count,
    approval_count: report.approval_count,
    ok: report.ok,
    findings: report.findings.length,
  }, null, 2));
  if (approvalsPath && !report.ok) process.exitCode = 1;
}

main();
