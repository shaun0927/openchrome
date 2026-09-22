/**
 * Deterministic A/B split for the decision corpus.
 *
 * Rule:
 *   - `trajectory` pool -> split A only (in-distribution pool; never held out).
 *   - `fixture` / `public` pools -> 50/50 A/B by parity of sha256(seed + ":" + id).
 *
 * The seed is committed here so that the same ids always land in the same
 * split, on every machine, regardless of file order.
 *
 * CLI:
 *   ts-node scripts/decisions/split.ts <corpus.jsonl> [--out <split.json>] [--in-place]
 *
 *   Writes split.json ({seed, counts, sha256}) next to the corpus (or to --out)
 *   and, with --in-place, rewrites the corpus with `split` filled in.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseCorpus, serializeCorpus } from '../../tests/fixtures/decisions/schema';
import type { CasePool, CaseSplit, DecisionCase } from '../../tests/fixtures/decisions/schema';

/** Committed seed. Changing it re-shuffles fixture/public cases; do not bump casually. */
export const SPLIT_SEED = 'openchrome-decision-corpus-g0-2026-09-20';

export interface SplitReport {
  seed: string;
  counts: Record<CaseSplit, number> & { total: number };
  sha256: Record<CaseSplit, string>;
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Split assignment for one id. Pure. */
export function assignSplit(id: string, pool: CasePool, seed: string = SPLIT_SEED): CaseSplit {
  if (pool === 'trajectory') return 'A';
  const digest = sha256Hex(`${seed}:${id}`);
  const lastNibble = parseInt(digest[digest.length - 1], 16);
  return lastNibble % 2 === 0 ? 'A' : 'B';
}

/** Returns new case objects with `split` set; input is not mutated. */
export function applySplit<T extends DecisionCase>(cases: readonly T[], seed: string = SPLIT_SEED): T[] {
  return cases.map((c) => ({ ...c, split: assignSplit(c.id, c.pool, seed) }));
}

/** Compute the split report from cases that already carry `split`. Order-independent. */
export function computeSplitReport(cases: readonly DecisionCase[], seed: string = SPLIT_SEED): SplitReport {
  const ids: Record<CaseSplit, string[]> = { A: [], B: [] };
  for (const c of cases) {
    const split = c.split ?? assignSplit(c.id, c.pool, seed);
    ids[split].push(c.id);
  }
  const sorted = { A: [...ids.A].sort(), B: [...ids.B].sort() };
  return {
    seed,
    counts: { A: sorted.A.length, B: sorted.B.length, total: sorted.A.length + sorted.B.length },
    sha256: { A: sha256Hex(sorted.A.join('\n')), B: sha256Hex(sorted.B.join('\n')) },
  };
}

function main(argv: string[]): number {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const corpusPath = positional[0];
  if (!corpusPath) {
    console.error('usage: ts-node scripts/decisions/split.ts <corpus.jsonl> [--out <split.json>] [--in-place]');
    return 2;
  }
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 && argv[outIdx + 1] ? argv[outIdx + 1] : path.join(path.dirname(corpusPath), 'split.json');
  const inPlace = argv.includes('--in-place');

  const { cases, errors } = parseCorpus(fs.readFileSync(corpusPath, 'utf8'));
  if (errors.length > 0) {
    for (const e of errors) console.error(`${corpusPath}:${e.line}: ${e.errors.join('; ')}`);
    return 1;
  }
  const split = applySplit(cases);
  const report = computeSplitReport(split);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (inPlace) fs.writeFileSync(corpusPath, serializeCorpus(split), 'utf8');
  console.error(`split: A=${report.counts.A} B=${report.counts.B} total=${report.counts.total} -> ${outPath}${inPlace ? ' (corpus rewritten)' : ''}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
