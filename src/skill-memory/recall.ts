/**
 * Skill recall + frozen-snapshot store (#714 v2).
 *
 * On every navigate, the host asks the recall layer for the index of
 * promoted skills that apply to the destination domain. The first
 * answer per `(session_id, domain)` pair is **frozen** for that
 * session — preserves provider prefix-cache, makes recall payloads
 * deterministic, and matches Hermes-Agent's pattern (#714 v2).
 *
 * Wire format (compact JSON, kept under the 8 KB cap so the LLM eats
 * tokens only when there's something to know):
 *
 *   {
 *     domain: "amazon.com",
 *     promoted_skills: [
 *       { id, intent, verified_runs, last_verified_at, graph_node_anchor,
 *         summary, expand_via }
 *     ]
 *   }
 *
 * Ordering: `verified_runs DESC, last_verified_at DESC, skill_id ASC`
 * (the `skill_id ASC` tiebreak makes the payload byte-stable).
 *
 * Drop policy when the top-5 don't fit: drop from the BOTTOM of the
 * ranked list one at a time until the payload fits the cap.
 * Minimum 1 skill is always included — even if that skill alone
 * exceeds the cap, in which case `oversized: true` is set so the host
 * can emit the `skill_recall_oversized` audit event (#714 v2 PR plan).
 */

import { listSkillsForDomain } from './extractor';
import type { SkillRecord } from './types';

const RECALL_URI_PREFIX = 'openchrome://skills/';

/** Wire entry for a single skill in the recall payload. */
export interface SkillRecallEntry {
  id: string;
  intent: string;
  verified_runs: number;
  last_verified_at: string;
  graph_node_anchor: string;
  /** 1-line excerpt — first non-blank Markdown line of the body, capped. */
  summary: string;
  /** MCP-resource URI for the full SKILL.md. */
  expand_via: string;
}

export interface SkillRecallPayload {
  domain: string;
  promoted_skills: SkillRecallEntry[];
  /** True iff the payload was forcibly truncated below `topK` to fit `maxBytes`. */
  oversized?: boolean;
}

export interface SkillRecallOptions {
  rootDir?: string;
  /** Top N skills considered before drop policy. Default 5. */
  topK?: number;
  /** Hard byte cap on the rendered JSON. Default 8 KB. */
  maxBytes?: number;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_BYTES = 8 * 1024;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Recall enabled flag — `auto` and `on` enable, `off` disables. */
export function isRecallEnabled(): boolean {
  const raw = (process.env.OPENCHROME_SKILL_RECALL ?? 'auto').toLowerCase();
  return raw === 'on' || raw === 'auto' || raw === '1' || raw === 'true';
}

function summarize(body: string, maxLen = 200): string {
  const firstNonBlank = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('---'));
  if (!firstNonBlank) return '';
  // Strip leading Markdown decorations (`#`, `-`, `>`, `* `).
  const cleaned = firstNonBlank.replace(/^[#>*-]+\s*/, '');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 1) + '…' : cleaned;
}

function rank(records: SkillRecord[]): SkillRecord[] {
  return [...records].sort((a, b) => {
    const va = a.frontmatter.verified_runs;
    const vb = b.frontmatter.verified_runs;
    if (va !== vb) return vb - va;
    const ta = Date.parse(a.frontmatter.last_verified_at);
    const tb = Date.parse(b.frontmatter.last_verified_at);
    if (ta !== tb) return tb - ta;
    return a.skill_id.localeCompare(b.skill_id);
  });
}

function buildEntry(rec: SkillRecord, body: string): SkillRecallEntry {
  return {
    id: rec.skill_id,
    intent: rec.frontmatter.intent,
    verified_runs: rec.frontmatter.verified_runs,
    last_verified_at: rec.frontmatter.last_verified_at,
    graph_node_anchor: rec.frontmatter.graph_node_anchor,
    summary: summarize(body),
    expand_via: `${RECALL_URI_PREFIX}${rec.frontmatter.domain}/${rec.skill_id}`,
  };
}

/**
 * Build the recall payload for `domain`. Returns null when recall is
 * disabled by env, or when there are no promoted skills.
 *
 * Hosts call this once per `(session_id, domain)` pair via
 * `SkillRecallStore.get` — the store memoizes for prefix-cache.
 */
export function buildRecallPayload(
  domain: string,
  records: SkillRecord[],
  bodies: Map<string, string>,
  opts: SkillRecallOptions = {},
): SkillRecallPayload | null {
  if (!isRecallEnabled()) return null;
  const promoted = records.filter((r) => r.frontmatter.status === 'promoted');
  if (promoted.length === 0) return null;
  const topK = Math.max(1, opts.topK ?? envInt('OPENCHROME_SKILL_RECALL_TOPK', DEFAULT_TOP_K));
  // Honor caller-provided `maxBytes` as a hard cap. Only env / default
  // fall-throughs are clamped (to a small positive minimum); any
  // explicit caller value — including very small ones — is respected
  // so embeddings into fixed-size envelopes can rely on the cap.
  const maxBytes = opts.maxBytes !== undefined
    ? Math.max(1, opts.maxBytes)
    : Math.max(1, envInt('OPENCHROME_SKILL_RECALL_BYTES', DEFAULT_MAX_BYTES));
  const ranked = rank(promoted).slice(0, topK);
  const entries = ranked.map((r) => buildEntry(r, bodies.get(r.skill_id) ?? ''));

  // Drop from the bottom until the payload fits, but always keep ≥1.
  // The serialized `,"oversized":true` adds ~18 bytes; we set the flag
  // BEFORE the truncation loop in any case where dropping happens, so
  // the size check accounts for the flag's overhead and we can never
  // return an over-cap payload merely because the flag was appended
  // after truncation finished. (The intentional escape hatch is the
  // single-entry case: even one skill plus the flag may exceed
  // maxBytes — we ship it anyway with `oversized: true` set.)
  let payload: SkillRecallPayload = { domain, promoted_skills: entries };
  const size = () => Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size() > maxBytes) {
    payload = { ...payload, oversized: true };
    while (size() > maxBytes && payload.promoted_skills.length > 1) {
      payload.promoted_skills = payload.promoted_skills.slice(0, -1);
    }
  }
  return payload;
}

/** Frozen-snapshot store keyed on `(sessionId, domain)`. */
export class SkillRecallStore {
  private readonly snapshots = new Map<string, SkillRecallPayload | null>();

  /**
   * Resolve a frozen snapshot. The first call computes via
   * `compute()`; subsequent calls for the same key return the same
   * reference (or null when recall was disabled / empty).
   */
  resolve(
    sessionId: string,
    domain: string,
    compute: () => SkillRecallPayload | null,
  ): SkillRecallPayload | null {
    const key = `${sessionId}|${domain}`;
    if (this.snapshots.has(key)) return this.snapshots.get(key) ?? null;
    const fresh = compute();
    this.snapshots.set(key, fresh);
    return fresh;
  }

  /** Drop snapshots for a session (e.g., session deleted by the manager). */
  invalidateSession(sessionId: string): void {
    const prefix = `${sessionId}|`;
    for (const k of [...this.snapshots.keys()]) {
      if (k.startsWith(prefix)) this.snapshots.delete(k);
    }
  }

  /** Test hook: drop everything. */
  clear(): void {
    this.snapshots.clear();
  }

  /** For tests / inspection. */
  size(): number {
    return this.snapshots.size;
  }
}

/**
 * Convenience: read every promoted SKILL.md body off disk and build
 * the recall payload in one call. Hosts that already have records +
 * bodies in memory should call `buildRecallPayload` directly.
 */
export function recallFromDisk(
  domain: string,
  opts: SkillRecallOptions = {},
): SkillRecallPayload | null {
  if (!isRecallEnabled()) return null;
  const records = listSkillsForDomain(domain, { rootDir: opts.rootDir });
  if (records.length === 0) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const bodies = new Map<string, string>();
  for (const r of records) {
    try {
      const text = fs.readFileSync(r.filePath, 'utf8');
      const close = text.indexOf('\n---', 4);
      bodies.set(r.skill_id, close > 0 ? text.slice(close + 4).trimStart() : '');
    } catch {
      bodies.set(r.skill_id, '');
    }
  }
  return buildRecallPayload(domain, records, bodies, opts);
}
