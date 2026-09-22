/**
 * Decision-corpus evaluator CLI.
 *
 *   ts-node scripts/eval-decisions.ts --corpus <cases.jsonl>
 *       [--provider noop,regex,file,typesafe,laya-local]   (default: noop,regex)
 *       [--out-dir artifacts/decision/G0]
 *       [--broken remove-correct]
 *       [--answers <answers.json>]              (file provider)
 *       [--kind element|outcome|irreversible|gate] [--split A|B]
 *       [--view-mode raw|g2-element]
 *
 * Writes artifacts/decision/G0/eval-<provider>.json per provider and prints a
 * markdown table per provider to stdout. Diagnostics go to stderr.
 *
 * Exit codes: 0 ok (including providers skipped for a missing key),
 * 1 broken-input guard failed, 2 usage / corpus error.
 */

import * as path from 'path';
import { runEvaluation } from './decisions/evaluate';
import type { CaseKind } from '../tests/fixtures/decisions/schema';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = typeof args.corpus === 'string' ? args.corpus : undefined;
  if (!corpus || args.help) {
    console.error('usage: ts-node scripts/eval-decisions.ts --corpus <cases.jsonl> [--provider noop,regex,file,typesafe,laya-local] [--out-dir artifacts/decision/G0] [--broken remove-correct] [--answers <answers.json>] [--kind <kind>] [--split A|B]');
    return 2;
  }
  const providerNames = (typeof args.provider === 'string' ? args.provider : 'noop,regex').split(',').map((s) => s.trim()).filter(Boolean);
  const result = await runEvaluation({
    corpusPath: corpus,
    providerNames,
    outDir: typeof args['out-dir'] === 'string' ? args['out-dir'] : path.join('artifacts', 'decision', 'G0'),
    broken: typeof args.broken === 'string' ? args.broken : undefined,
    providerOptions: { answersFile: typeof args.answers === 'string' ? args.answers : undefined },
    kind: typeof args.kind === 'string' ? (args.kind as CaseKind) : undefined,
    split: typeof args.split === 'string' ? args.split : undefined,
    viewMode: args['view-mode'] === 'g2-element' ? 'g2-element' : 'raw',
  });
  return result.exitCode;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 2;
  });
}
