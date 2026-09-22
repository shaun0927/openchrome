import * as fs from 'fs';
import * as path from 'path';

const freezeGapPath = path.join('artifacts', 'decision', 'G3', 'freeze-gap-packet.json');
const outputJsonPath = path.join('artifacts', 'decision', 'G3', 'approval-request.json');
const outputMdPath = path.join('artifacts', 'decision', 'G3', 'approval-request.md');

interface FreezeGap {
  readonly insertion: string;
  readonly current_frozen_trigger: string | null;
  readonly a_candidate_trigger: string | null;
  readonly status: string;
  readonly a_count: number;
  readonly a_accuracy: number | null;
  readonly missing: readonly string[];
  readonly required_next_evidence: readonly string[];
}

interface FreezeGapPacket {
  readonly generated_at: string;
  readonly gaps: readonly FreezeGap[];
}

interface ApprovalItem {
  readonly id: string;
  readonly insertion: string;
  readonly requested_decision: 'approve_freeze' | 'provide_more_evidence' | 'approve_exclusion';
  readonly current_frozen_trigger: string | null;
  readonly proposed_trigger: string | null;
  readonly evidence_summary: {
    readonly a_count: number;
    readonly a_accuracy: number | null;
    readonly missing: readonly string[];
  };
  readonly required_before_closure: readonly string[];
}

interface ApprovalRequest {
  readonly generated_at: string;
  readonly source: string;
  readonly items: readonly ApprovalItem[];
  readonly answer_file_shape: {
    readonly approve: Record<string, { readonly decision: string; readonly approver: string; readonly notes: string }>;
  };
}

function readPacket(): FreezeGapPacket {
  return JSON.parse(fs.readFileSync(freezeGapPath, 'utf8')) as FreezeGapPacket;
}

function decisionFor(gap: FreezeGap): ApprovalItem['requested_decision'] {
  if (gap.insertion === 'gate_detection' && gap.missing.length > 0) return 'approve_exclusion';
  if (gap.missing.length > 0) return 'provide_more_evidence';
  return 'approve_freeze';
}

function itemFor(gap: FreezeGap): ApprovalItem {
  const requested = decisionFor(gap);
  return {
    id: `g3-${gap.insertion}`,
    insertion: gap.insertion,
    requested_decision: requested,
    current_frozen_trigger: gap.current_frozen_trigger,
    proposed_trigger: requested === 'approve_freeze' ? gap.a_candidate_trigger : null,
    evidence_summary: {
      a_count: gap.a_count,
      a_accuracy: gap.a_accuracy,
      missing: gap.missing,
    },
    required_before_closure: gap.required_next_evidence,
  };
}

function markdown(request: ApprovalRequest): string {
  const lines = [
    '# G3 approval request',
    '',
    `Generated: ${request.generated_at}`,
    '',
    `Source: \`${request.source}\``,
    '',
    '## Items',
    '',
  ];
  for (const item of request.items) {
    lines.push(`### ${item.id}`, '');
    lines.push(`Insertion: ${item.insertion}`);
    lines.push('');
    lines.push(`Requested decision: ${item.requested_decision}`);
    lines.push('');
    lines.push(`Current frozen trigger: ${item.current_frozen_trigger ?? '-'}`);
    lines.push('');
    lines.push(`Proposed trigger: ${item.proposed_trigger ?? '-'}`);
    lines.push('');
    lines.push(`A count: ${item.evidence_summary.a_count}`);
    lines.push('');
    lines.push(`A accuracy: ${item.evidence_summary.a_accuracy ?? '-'}`);
    lines.push('');
    lines.push(`Missing: ${item.evidence_summary.missing.length === 0 ? '-' : item.evidence_summary.missing.join('; ')}`);
    lines.push('');
    lines.push('Required before G3 closure:');
    lines.push('');
    for (const requirement of item.required_before_closure) lines.push(`- ${requirement}`);
    lines.push('');
  }
  lines.push('## Answer File Shape', '', '```json', JSON.stringify(request.answer_file_shape.approve, null, 2), '```', '');
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const packet = readPacket();
  const request: ApprovalRequest = {
    generated_at: new Date().toISOString(),
    source: freezeGapPath,
    items: packet.gaps.map(itemFor),
    answer_file_shape: {
      approve: {
        'g3-outcome_classification': {
          decision: 'approved | rejected | needs_more_evidence',
          approver: '<name/session>',
          notes: '<short rationale>',
        },
      },
    },
  };
  fs.writeFileSync(outputJsonPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outputMdPath, markdown(request), 'utf8');
  console.log(JSON.stringify({
    output: outputJsonPath,
    items: request.items.map((item) => ({ id: item.id, requested_decision: item.requested_decision })),
  }, null, 2));
}

main();
