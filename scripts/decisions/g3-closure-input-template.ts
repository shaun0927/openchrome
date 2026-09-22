import * as fs from 'fs';
import * as path from 'path';

const outDir = path.join('artifacts', 'decision', 'G3');
const approvalPath = path.join(outDir, 'approval-request.json');
const requestPath = path.join(outDir, 'host-answer-batch', 'requests.jsonl');
const jsonOut = path.join(outDir, 'closure-input-template.json');
const mdOut = path.join(outDir, 'CLOSURE_INPUT_TEMPLATE.md');

interface ApprovalRequest {
  readonly items: readonly {
    readonly id: string;
    readonly insertion: string;
    readonly requested_decision: string;
    readonly proposed_trigger: string | null;
    readonly required_before_closure: readonly string[];
  }[];
}

interface HostRequest {
  readonly id: string;
  readonly insertion: string;
  readonly choices: readonly {
    readonly id: string;
    readonly label?: string;
  }[];
}

interface ClosureInputTemplate {
  readonly generated_at: string;
  readonly approvals_template: {
    readonly approvals: Record<string, {
      readonly decision: '<approved | rejected | needs_more_evidence>';
      readonly approver: '<name/session>';
      readonly notes: string;
      readonly requested_decision: string;
      readonly proposed_trigger: string | null;
      readonly required_before_closure: readonly string[];
    }>;
  };
  readonly host_answers_template: Record<string, {
    readonly answer: '<one choice id>';
    readonly confidence: 0.8;
    readonly insertion: string;
    readonly choices: readonly string[];
  }>;
  readonly local_model_environment_template: {
    readonly LAYA_LOCAL_ENABLED: '1';
    readonly LAYA_PYTHON: '<path-to-python-with-laya>';
    readonly HF_HUB_DISABLE_SYMLINKS: '1';
  };
  readonly remote_jev_environment_template: {
    readonly AI_GATEWAY_API_KEY: '<vercel-ai-gateway-key>';
    readonly TYPESAFE_ENDPOINT: 'https://ai-gateway.vercel.sh/v1/chat/completions';
    readonly TYPESAFE_MODEL: 'typesafe-ai/jev';
    readonly TYPESAFE_PROTOCOL: 'openai-chat';
  };
  readonly commands_after_filling: readonly string[];
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function readRequests(file: string): HostRequest[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as HostRequest);
}

function markdown(template: ClosureInputTemplate): string {
  const lines = [
    '# G3 closure input template',
    '',
    `Generated: ${template.generated_at}`,
    '',
    'This file is a fill-in template only. Do not use placeholder values as approval or host-answer evidence.',
    '',
    '## Approval Items',
    '',
    '| id | requested decision | proposed trigger |',
    '| --- | --- | --- |',
  ];
  for (const [id, item] of Object.entries(template.approvals_template.approvals)) {
    lines.push(`| \`${id}\` | ${item.requested_decision} | ${item.proposed_trigger ?? '-'} |`);
  }
  lines.push('', '## Host Answer Requests', '');
  lines.push(`- Total requests: ${Object.keys(template.host_answers_template).length}`);
  const byInsertion: Record<string, number> = {};
  for (const item of Object.values(template.host_answers_template)) byInsertion[item.insertion] = (byInsertion[item.insertion] ?? 0) + 1;
  for (const [insertion, count] of Object.entries(byInsertion).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`- ${insertion}: ${count}`);
  }
  lines.push('', '## Local Model Environment', '');
  for (const [key, value] of Object.entries(template.local_model_environment_template)) lines.push(`- \`${key}=${value}\``);
  lines.push('', '## Remote Jev Environment', '');
  for (const [key, value] of Object.entries(template.remote_jev_environment_template)) lines.push(`- \`${key}=${value}\``);
  lines.push('', '## Commands After Filling', '');
  for (const command of template.commands_after_filling) lines.push(`- \`${command}\``);
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const approval = readJson<ApprovalRequest>(approvalPath);
  const requests = readRequests(requestPath);
  const approvals: ClosureInputTemplate['approvals_template']['approvals'] = {};
  for (const item of approval.items) {
    approvals[item.id] = {
      decision: '<approved | rejected | needs_more_evidence>',
      approver: '<name/session>',
      notes: `<rationale for ${item.insertion}>`,
      requested_decision: item.requested_decision,
      proposed_trigger: item.proposed_trigger,
      required_before_closure: item.required_before_closure,
    };
  }
  const hostAnswers: ClosureInputTemplate['host_answers_template'] = {};
  for (const request of requests) {
    hostAnswers[request.id] = {
      answer: '<one choice id>',
      confidence: 0.8,
      insertion: request.insertion,
      choices: request.choices.map((choice) => choice.id),
    };
  }
  const template: ClosureInputTemplate = {
    generated_at: new Date().toISOString(),
    approvals_template: { approvals },
    host_answers_template: hostAnswers,
    local_model_environment_template: {
      LAYA_LOCAL_ENABLED: '1',
      LAYA_PYTHON: '<path-to-python-with-laya>',
      HF_HUB_DISABLE_SYMLINKS: '1',
    },
    remote_jev_environment_template: {
      AI_GATEWAY_API_KEY: '<vercel-ai-gateway-key>',
      TYPESAFE_ENDPOINT: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      TYPESAFE_MODEL: 'typesafe-ai/jev',
      TYPESAFE_PROTOCOL: 'openai-chat',
    },
    commands_after_filling: [
      'npm run validate-approval:g3 -- --approvals <approvals.json>',
      'npm run validate-host:g3 -- --answers <host-answers.json>',
      'set LAYA_LOCAL_ENABLED=1',
      'set LAYA_PYTHON=<path-to-python-with-laya>',
      'npm run evidence:g3 -- --host-answers <host-answers.json>',
      'npm run tables:g3',
      'npm run preflight:g3',
    ],
  };
  fs.writeFileSync(jsonOut, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOut, markdown(template), 'utf8');
  console.log(JSON.stringify({ output: mdOut, approval_items: approval.items.length, host_requests: requests.length }, null, 2));
}

main();
