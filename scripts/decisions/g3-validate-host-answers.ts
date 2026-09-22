import * as fs from 'fs';
import * as path from 'path';
import { parseAnswersFile } from './providers/file';

const requestPath = path.join('artifacts', 'decision', 'G3', 'host-answer-batch', 'requests.jsonl');
const reportPath = path.join('artifacts', 'decision', 'G3', 'host-answer-batch', 'validation-report.json');

interface HostRequest {
  readonly id: string;
  readonly choices: readonly { readonly id: string }[];
}

interface Finding {
  readonly id: string;
  readonly problem: string;
}

interface ValidationReport {
  readonly generated_at: string;
  readonly request_jsonl: string;
  readonly answers_path: string | null;
  readonly request_count: number;
  readonly answer_count: number | null;
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

function parseRequest(line: string, lineNumber: number): HostRequest {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || typeof parsed.id !== 'string' || !Array.isArray(parsed.choices)) {
    throw new Error(`${requestPath}:${lineNumber}: request must have id and choices`);
  }
  const choices = parsed.choices.flatMap((choice): Array<{ readonly id: string }> => (
    isRecord(choice) && typeof choice.id === 'string' ? [{ id: choice.id }] : []
  ));
  if (choices.length !== parsed.choices.length) {
    throw new Error(`${requestPath}:${lineNumber}: every choice must have an id`);
  }
  return { id: parsed.id, choices };
}

function readRequests(): HostRequest[] {
  const text = fs.readFileSync(requestPath, 'utf8').trim();
  if (text.length === 0) return [];
  return text.split(/\r?\n/).map((line, index) => parseRequest(line, index + 1));
}

function writeReport(report: ValidationReport): void {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function main(): void {
  const answersPath = argValue('--answers') ?? process.env.HOST_DECISION_ANSWERS;
  const requests = readRequests();
  const findings: Finding[] = [];
  let answerCount: number | null = null;

  if (answersPath) {
    if (!fs.existsSync(answersPath)) {
      findings.push({ id: '<answers>', problem: `answers file not found: ${answersPath}` });
    } else {
      const answers = parseAnswersFile(fs.readFileSync(answersPath, 'utf8'));
      answerCount = answers.size;
      const validIds = new Set(requests.map((request) => request.id));
      for (const request of requests) {
        const answer = answers.get(request.id);
        if (!answer) {
          findings.push({ id: request.id, problem: 'missing answer' });
          continue;
        }
        const choices = new Set(request.choices.map((choice) => choice.id));
        if (!choices.has(answer.answer)) {
          findings.push({ id: request.id, problem: `answer "${answer.answer}" is not one of the request choices` });
        }
      }
      for (const id of answers.keys()) {
        if (!validIds.has(id)) findings.push({ id, problem: 'answer id is not present in the request batch' });
      }
    }
  } else {
    findings.push({ id: '<answers>', problem: 'answers file not supplied' });
  }

  const report: ValidationReport = {
    generated_at: new Date().toISOString(),
    request_jsonl: requestPath,
    answers_path: answersPath ?? null,
    request_count: requests.length,
    answer_count: answerCount,
    ok: findings.length === 0,
    findings,
  };
  writeReport(report);
  console.log(JSON.stringify({
    output: reportPath,
    request_count: report.request_count,
    answer_count: report.answer_count,
    ok: report.ok,
    findings: report.findings.length,
  }, null, 2));
  if (answersPath && !report.ok) process.exitCode = 1;
}

main();
