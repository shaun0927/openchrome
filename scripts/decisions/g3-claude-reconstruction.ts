import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const sessionId = '8f4f7598-99b4-44e8-98d4-b94e0188d1fa';
const projectRoot = path.resolve('..');
const claudeRoot = path.join(process.env.USERPROFILE ?? '', '.claude', 'projects', 'C--Users-USER-Desktop-jh0927');
const sessionPath = process.env.CLAUDE_SESSION_PATH ?? path.join(claudeRoot, `${sessionId}.jsonl`);
const subagentRoot = path.join(claudeRoot, sessionId, 'subagents');
const outDir = path.join('artifacts', 'decision', 'G3');
const jsonOut = path.join(outDir, 'claude-reconstruction.json');
const mdOut = path.join(outDir, 'CLAUDE_RECONSTRUCTION.md');

interface ClaudeEvent {
  readonly type?: string;
  readonly timestamp?: string;
  readonly gitBranch?: string;
  readonly cwd?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  } | string;
  readonly trackingPath?: string;
  readonly attachment?: {
    readonly type?: string;
    readonly context?: {
      readonly gitStatus?: string;
    };
  };
}

interface TaskNotification {
  readonly task_id: string;
  readonly tool_use_id: string;
  readonly output_file: string;
  readonly status: string;
  readonly summary: string;
  readonly timestamp: string | null;
}

interface SubagentMeta {
  readonly id: string;
  readonly agent_type: string;
  readonly description: string;
  readonly tool_use_id: string;
  readonly path: string;
  readonly meta_path: string;
  readonly notification_status: string | null;
}

interface Reconstruction {
  readonly generated_at: string;
  readonly session: {
    readonly id: string;
    readonly path: string;
    readonly cwd: string | null;
    readonly branch: string | null;
    readonly first_user_message: string | null;
    readonly last_user_message: string | null;
    readonly last_assistant_response: string | null;
    readonly last_assistant_error: string | null;
    readonly event_count: number;
  };
  readonly task_notifications: readonly TaskNotification[];
  readonly subagents: readonly SubagentMeta[];
  readonly changed_files_from_claude: readonly string[];
  readonly current_git: {
    readonly head: string;
    readonly branch: string;
    readonly status_short: readonly string[];
  };
  readonly evidence_files: readonly string[];
  readonly conclusion: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonLines(file: string): ClaudeEvent[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ClaudeEvent);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return textOf(value.content);
  if (typeof value.message === 'string') return value.message;
  return '';
}

function eventText(event: ClaudeEvent): string {
  if (typeof event.message === 'string') return event.message;
  if (isRecord(event.message)) return textOf(event.message.content);
  return '';
}

function tag(text: string, name: string): string {
  const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? match[1].trim() : '';
}

function notifications(events: readonly ClaudeEvent[]): TaskNotification[] {
  const out: TaskNotification[] = [];
  for (const event of events) {
    const text = eventText(event);
    if (!text.includes('<task-notification>')) continue;
    out.push({
      task_id: tag(text, 'task-id'),
      tool_use_id: tag(text, 'tool-use-id'),
      output_file: tag(text, 'output-file'),
      status: tag(text, 'status'),
      summary: tag(text, 'summary'),
      timestamp: event.timestamp ?? null,
    });
  }
  return out;
}

function subagents(tasks: readonly TaskNotification[]): SubagentMeta[] {
  if (!fs.existsSync(subagentRoot)) return [];
  return fs.readdirSync(subagentRoot)
    .filter((file) => file.endsWith('.meta.json'))
    .sort()
    .map((file) => {
      const metaPath = path.join(subagentRoot, file);
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      const id = file.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      const toolUseId = typeof raw.toolUseId === 'string' ? raw.toolUseId : '';
      const last = [...tasks].reverse().find((task) => task.task_id === id || task.tool_use_id === toolUseId);
      return {
        id,
        agent_type: typeof raw.agentType === 'string' ? raw.agentType : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        tool_use_id: toolUseId,
        path: path.join(subagentRoot, `agent-${id}.jsonl`),
        meta_path: metaPath,
        notification_status: last?.status ?? null,
      };
    });
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function markdown(report: Reconstruction): string {
  const lines = [
    '# Claude session reconstruction',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '## Session',
    '',
    `- Session id: \`${report.session.id}\``,
    `- Raw path: \`${report.session.path}\``,
    `- CWD: \`${report.session.cwd ?? '-'}\``,
    `- Branch in Claude events: \`${report.session.branch ?? '-'}\``,
    `- Event count: ${report.session.event_count}`,
    '',
    '## Last Messages',
    '',
    `- First user: ${report.session.first_user_message ?? '-'}`,
    `- Last user: ${report.session.last_user_message ?? '-'}`,
    `- Last assistant response: ${report.session.last_assistant_response ?? '-'}`,
    `- Last assistant error: ${report.session.last_assistant_error ?? '-'}`,
    '',
    '## Task Notifications',
    '',
    '| task | status | summary | output |',
    '| --- | --- | --- | --- |',
  ];
  for (const task of report.task_notifications) {
    lines.push(`| \`${task.task_id}\` | ${task.status} | ${task.summary.replace(/\|/g, '\\|')} | \`${task.output_file}\` |`);
  }
  lines.push('', '## Subagents', '', '| id | agent | description | latest notification |');
  lines.push('| --- | --- | --- | --- |');
  for (const agent of report.subagents) {
    lines.push(`| \`${agent.id}\` | ${agent.agent_type} | ${agent.description.replace(/\|/g, '\\|')} | ${agent.notification_status ?? '-'} |`);
  }
  lines.push('', '## Changed Files From Claude Events', '');
  for (const file of report.changed_files_from_claude) lines.push(`- \`${file}\``);
  lines.push('', '## Current Git State', '');
  lines.push(`- HEAD: \`${report.current_git.head}\``);
  lines.push(`- Branch: \`${report.current_git.branch}\``);
  for (const line of report.current_git.status_short) lines.push(`- \`${line}\``);
  lines.push('', '## Evidence Files', '');
  for (const file of report.evidence_files) lines.push(`- \`${file}\``);
  lines.push('', '## Conclusion', '');
  for (const item of report.conclusion) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const events = readJsonLines(sessionPath);
  const userEvents = events.filter((event) => event.type === 'user' && eventText(event));
  const assistantEvents = events.filter((event) => event.type === 'assistant');
  const assistantTexts = assistantEvents.map(eventText).filter(Boolean);
  const assistantErrors = assistantEvents.map((event) => typeof event.message === 'string' ? event.message : '').filter(Boolean);
  const tasks = notifications(events);
  const changedFiles = [...new Set(events.map((event) => event.trackingPath).filter((item): item is string => typeof item === 'string'))].sort();
  const branch = events.map((event) => event.gitBranch).find((item): item is string => typeof item === 'string') ?? null;
  const cwd = events.map((event) => event.cwd).find((item): item is string => typeof item === 'string') ?? projectRoot;
  const report: Reconstruction = {
    generated_at: new Date().toISOString(),
    session: {
      id: sessionId,
      path: sessionPath,
      cwd,
      branch,
      first_user_message: userEvents.length > 0 ? eventText(userEvents[0]) : null,
      last_user_message: userEvents.length > 0 ? eventText(userEvents[userEvents.length - 1]) : null,
      last_assistant_response: assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : null,
      last_assistant_error: assistantErrors.length > 0 ? assistantErrors[assistantErrors.length - 1] : null,
      event_count: events.length,
    },
    task_notifications: tasks,
    subagents: subagents(tasks),
    changed_files_from_claude: changedFiles,
    current_git: {
      head: git(['rev-parse', 'HEAD']),
      branch: git(['branch', '--show-current']),
      status_short: git(['status', '--short']).split(/\r?\n/).filter(Boolean),
    },
    evidence_files: [
      'openchrome-decider-goal.md',
      'openchrome-decider-ledger.json',
      'artifacts/decision/G3/ANALYSIS_REPORT.md',
      'artifacts/decision/G3/HANDOFF.md',
      'artifacts/decision/G3/LEDGER_AUDIT.md',
    ],
    conclusion: [
      'Claude stopped because the final G0-B and G0-A follow-up task notifications failed with rate_limit errors.',
      'Codex has since completed G0-G2 and built the G3 local evidence surface.',
      'G3 remains open because threshold freeze, host answers, approval records, and real Jev results are still missing.',
    ],
  };
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdOut, markdown(report), 'utf8');
  console.log(JSON.stringify({ output: mdOut, task_notifications: tasks.length, subagents: report.subagents.length }, null, 2));
}

main();
