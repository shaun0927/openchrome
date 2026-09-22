/**
 * Extract UNLABELED decision cases from the local recovery trajectory.
 *
 * Sources (all optional; missing files are reported and skipped):
 *   .openchrome/recovery/trajectory.jsonl        -> irreversible, outcome
 *   .openchrome/timeline/*.jsonl                  -> outcome (error strings)
 *   .openchrome/recovery-feedback/*.jsonl         -> gate (auth_redirect triggers)
 *
 * What the data does and does not support (2026-09-20 clone):
 *   - irreversible: every trajectory node has {toolName, argsSummary} and, for
 *     tab/navigation tools, an observed url/title -> full input shape.
 *   - outcome: no DOM delta is recorded anywhere. `delta` is a stand-in built
 *     from `observationSummary` (trajectory) or `error` (timeline). Cases record
 *     `meta.delta_source` so a labeler knows the provenance. `target_role` is
 *     "button" only when the tool code clicked something; `before_url` comes from
 *     the parent node's observed url when it exists.
 *   - element: no node carries a target list (no find/click/snapshot calls were
 *     recorded), so zero element cases can be extracted.
 *   - gate: recovery-feedback `auth_redirect` triggers carry a title + result
 *     excerpt (the /login url), which is enough for the gate input shape.
 *
 * CLI:
 *   ts-node scripts/decisions/extract-trajectory.ts [--root .openchrome]
 *     [--out tests/fixtures/decisions/pool-trajectory.unlabeled.jsonl]
 */

import * as fs from 'fs';
import * as path from 'path';
import { sha256Hex } from './split';
import { detectLang, serializeCorpus, validateCase } from '../../tests/fixtures/decisions/schema';
import type {
  CaseKind, DecisionCase, GateCase, IrreversibleCase, OutcomeCase,
} from '../../tests/fixtures/decisions/schema';

interface TrajectoryNode {
  nodeId: string;
  timestamp: number;
  sessionId?: string;
  tabId?: string;
  parentNodeId?: string;
  toolName: string;
  argsSummary?: Record<string, unknown>;
  resultStatus?: string;
  progressStatus?: string;
  failureFingerprint?: string;
  observationSummary?: string;
  reward?: number;
}

interface TimelineEntry {
  id: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
}

interface FeedbackEntry {
  id: string;
  trigger?: { tool?: string; category?: string; resultExcerpt?: string };
  outcome?: { finalStatus?: string; feedback?: string };
}

export interface ExtractionReport {
  counts: Record<CaseKind, Record<'ko' | 'en', number>>;
  sources: Record<string, number>;
  missing: string[];
  dedupedAway: Record<CaseKind, number>;
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

function listJsonl(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
}

function tryParseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const v = JSON.parse(trimmed);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function observedPage(node: TrajectoryNode): { url?: string; title?: string } {
  const obs = tryParseJson(node.observationSummary);
  const url = typeof obs?.url === 'string' ? obs.url : typeof node.argsSummary?.url === 'string' ? node.argsSummary.url : undefined;
  const title = typeof obs?.title === 'string' ? obs.title : undefined;
  return { url, title };
}

function caseId(pool: string, kind: CaseKind, key: string): string {
  return `${pool}-${kind}-${sha256Hex(key).slice(0, 12)}`;
}

/** Strip volatile identifiers so repeated fixture runs collapse to one case. */
function volatileKey(text: string): string {
  return text
    .replace(/[0-9A-F]{32}/g, '{id}')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:{port}')
    .replace(/call-\d+-\d+/g, 'call-{n}')
    .replace(/_\d{13}\b/g, '_{ts}');
}

class Deduper<T extends DecisionCase> {
  readonly cases = new Map<string, T>();
  dropped = 0;

  constructor(private readonly kind: T['kind']) {}

  add(key: string, build: (id: string) => T, sourceId: string): void {
    const id = caseId('trajectory', this.kind, key);
    const existing = this.cases.get(id);
    if (existing) {
      this.dropped += 1;
      const meta = existing.meta ?? (existing.meta = {});
      const ids = (meta.source_ids as string[] | undefined) ?? (meta.source_ids = []);
      if (ids.length < 20) ids.push(sourceId);
      meta.occurrences = ((meta.occurrences as number | undefined) ?? 1) + 1;
      return;
    }
    const c = build(id);
    c.meta = { ...(c.meta ?? {}), source_ids: [sourceId], occurrences: 1 };
    this.cases.set(id, c);
  }
}

export function extract(root: string): { cases: DecisionCase[]; report: ExtractionReport } {
  const missing: string[] = [];
  const sources: Record<string, number> = {};

  const trajectoryPath = path.join(root, 'recovery', 'trajectory.jsonl');
  const nodes = readJsonl<TrajectoryNode>(trajectoryPath);
  sources[trajectoryPath] = nodes.length;
  if (nodes.length === 0) missing.push(`no trajectory nodes at ${trajectoryPath}`);
  const byId = new Map(nodes.map((n) => [n.nodeId, n] as const));

  const irreversible = new Deduper<IrreversibleCase>('irreversible');
  const outcome = new Deduper<OutcomeCase>('outcome');
  const gate = new Deduper<GateCase>('gate');

  // ── irreversible: one per distinct (tool, args, page) ──
  for (const node of nodes) {
    const args = node.argsSummary ?? {};
    const page = observedPage(node);
    const page_context: Record<string, unknown> = {};
    if (page.url) page_context.url = page.url;
    if (page.title) page_context.title = page.title;
    const key = volatileKey(JSON.stringify({ tool: node.toolName, args, page_context }));
    irreversible.add(key, (id) => ({
      id,
      kind: 'irreversible',
      lang: detectLang(JSON.stringify({ args, page_context })),
      pool: 'trajectory',
      input: { tool: node.toolName, args, page_context },
      meta: { source: 'trajectory', result_status: node.resultStatus, progress_status: node.progressStatus },
    }), node.nodeId);
  }

  // ── outcome: interaction-shaped nodes and every non-success node ──
  let outcomeSkippedNoObservation = 0;
  for (const node of nodes) {
    const code = typeof node.argsSummary?.code === 'string' ? node.argsSummary.code : '';
    const clicked = /\.click\(|\.submit\(/.test(code);
    const isInteraction = node.toolName === 'navigate' || (node.toolName === 'javascript_tool' && clicked);
    const failed = node.resultStatus !== undefined && node.resultStatus !== 'success';
    if (!isInteraction && !failed) continue;

    const obs = node.observationSummary ?? '';
    const hasObservation = obs.length > 0 && obs !== 'undefined';
    const delta = hasObservation ? obs : '';
    if (!hasObservation) outcomeSkippedNoObservation += 1;

    const parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
    const before_url = parent ? observedPage(parent).url : undefined;
    const after_url = observedPage(node).url;
    const target_role = clicked ? 'button' : undefined;

    const input: OutcomeCase['input'] = { delta };
    if (target_role) input.target_role = target_role;
    if (before_url) input.before_url = before_url;
    if (after_url) input.after_url = after_url;

    const key = volatileKey(JSON.stringify({ tool: node.toolName, input }));
    outcome.add(key, (id) => ({
      id,
      kind: 'outcome',
      lang: detectLang(delta + code),
      pool: 'trajectory',
      input,
      meta: {
        source: 'trajectory',
        source_tool: node.toolName,
        result_status: node.resultStatus,
        progress_status: node.progressStatus,
        delta_source: hasObservation ? 'observationSummary' : 'none (tool returned no observation)',
      },
    }), node.nodeId);
  }

  // ── outcome from timeline errors ──
  for (const file of listJsonl(path.join(root, 'timeline'))) {
    const entries = readJsonl<TimelineEntry>(file);
    sources[file] = entries.length;
    for (const e of entries) {
      if (e.result === 'success' || !e.error) continue;
      const input: OutcomeCase['input'] = { delta: e.error };
      if (typeof e.args?.url === 'string') input.after_url = e.args.url;
      const key = volatileKey(JSON.stringify({ tool: e.toolName, input }));
      outcome.add(key, (id) => ({
        id,
        kind: 'outcome',
        lang: detectLang(e.error ?? ''),
        pool: 'trajectory',
        input,
        meta: { source: 'timeline', source_tool: e.toolName, result_status: e.result, delta_source: 'timeline.error' },
      }), e.id);
    }
  }
  if (Object.keys(sources).filter((s) => s.includes('timeline')).length === 0) missing.push(`no timeline files under ${path.join(root, 'timeline')}`);

  // ── gate from recovery-feedback auth_redirect triggers ──
  const feedbackFiles = listJsonl(path.join(root, 'recovery-feedback'));
  if (feedbackFiles.length === 0) missing.push(`no recovery-feedback files under ${path.join(root, 'recovery-feedback')}`);
  for (const file of feedbackFiles) {
    const entries = readJsonl<FeedbackEntry>(file);
    sources[file] = entries.length;
    for (const e of entries) {
      if (e.trigger?.category !== 'auth_redirect') continue;
      const excerpt = e.trigger.resultExcerpt ?? '';
      const parsed = tryParseJson(excerpt);
      const title = typeof parsed?.title === 'string' ? parsed.title : '';
      const input: GateCase['input'] = { title, text_excerpt: excerpt };
      const key = volatileKey(JSON.stringify({ tool: e.trigger.tool, input }));
      gate.add(key, (id) => ({
        id,
        kind: 'gate',
        lang: detectLang(title + excerpt),
        pool: 'trajectory',
        input,
        meta: {
          source: 'recovery-feedback',
          trigger_tool: e.trigger?.tool,
          trigger_category: e.trigger?.category,
          final_status: e.outcome?.finalStatus,
          html_excerpt: 'missing (feedback log records no HTML)',
        },
      }), e.id);
    }
  }

  missing.push('element: no trajectory node records a target list (no find/click/snapshot views) -> 0 element cases');
  missing.push('outcome.delta: no DOM delta is recorded; delta is observationSummary / timeline.error text (see meta.delta_source)');
  if (outcomeSkippedNoObservation > 0) {
    missing.push(`outcome: ${outcomeSkippedNoObservation} interaction nodes returned no observation (delta="" after dedupe)`);
  }
  missing.push('gate.html_excerpt: absent in every source');

  const all: DecisionCase[] = [...irreversible.cases.values(), ...outcome.cases.values(), ...gate.cases.values()];
  for (const c of all) {
    const v = validateCase(c);
    if (!v.ok) throw new Error(`extractor produced an invalid case ${c.id}: ${v.errors.join('; ')}`);
  }

  const counts: ExtractionReport['counts'] = {
    element: { ko: 0, en: 0 }, outcome: { ko: 0, en: 0 }, irreversible: { ko: 0, en: 0 }, gate: { ko: 0, en: 0 },
  };
  for (const c of all) counts[c.kind][c.lang] += 1;

  return {
    cases: all,
    report: {
      counts,
      sources,
      missing,
      dedupedAway: { element: 0, outcome: outcome.dropped, irreversible: irreversible.dropped, gate: gate.dropped },
    },
  };
}

function main(argv: string[]): number {
  const arg = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const root = arg('--root', path.join(process.cwd(), '.openchrome'));
  const out = arg('--out', path.join(process.cwd(), 'tests', 'fixtures', 'decisions', 'pool-trajectory.unlabeled.jsonl'));

  const { cases, report } = extract(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, serializeCorpus(cases), 'utf8');

  console.error(`wrote ${cases.length} unlabeled cases -> ${out}`);
  for (const [kind, langs] of Object.entries(report.counts)) {
    console.error(`  ${kind.padEnd(12)} ko=${langs.ko} en=${langs.en} (deduped away: ${report.dedupedAway[kind as CaseKind]})`);
  }
  console.error('sources:');
  for (const [file, n] of Object.entries(report.sources)) console.error(`  ${n} lines  ${file}`);
  console.error('missing / caveats:');
  for (const m of report.missing) console.error(`  - ${m}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
