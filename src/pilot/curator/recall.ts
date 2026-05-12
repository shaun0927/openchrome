/**
 * Skill recall ranking (#714 v2, Phase 4 — replaces the ranking half of
 * closed PR #762).
 *
 * On every navigate, the host asks the recall layer for the ranked index
 * of skills that apply to the destination domain. The first answer per
 * `(session_id, domain)` pair is **frozen** for that session — preserves
 * provider prefix-cache, makes recall payloads deterministic, and matches
 * the Hermes-Agent pattern (#714 v2).
 *
 * Wire format (compact JSON, kept under the 8 KB cap so the LLM eats
 * tokens only when there's something to know):
 *
 *   {
 *     domain: "amazon.com",
 *     ranked_skills: [
 *       { skillId, name, successCount, lastUsedAt, frozenSnapshotPath }
 *     ]
 *   }
 *
 * Ordering: `successCount DESC, lastUsedAt DESC, skillId ASC`
 * (the `skillId ASC` tiebreak makes the payload byte-stable).
 *
 * Drop policy when the top-N don't fit: drop from the BOTTOM of the
 * ranked list one at a time until the payload fits the cap.
 * Minimum 1 skill is always included — even if that skill alone
 * exceeds the cap, in which case `oversized: true` is set so the host
 * can emit the `skill_recall_oversized` audit event (#714 v2 PR plan).
 *
 * Gated by `isSkillCuratorEnabled()` — callers MUST check before use.
 */

import { isSkillCuratorEnabled } from '../../harness/flags.js';
import { SkillMemoryStore } from '../../core/skill-memory/store.js';
import type { SkillRecord } from '../../core/skill-memory/types.js';

export { isSkillCuratorEnabled };

const RECALL_URI_PREFIX = 'openchrome://skills/';

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_BYTES = 8 * 1024;

/** Wire entry for a single skill in the recall payload. */
export interface SkillRecallResult {
  skillId: string;
  name: string;
  successCount: number;
  lastUsedAt: number;
  frozenSnapshotPath: string | null;
  /** MCP-resource URI for the skill. */
  expand_via: string;
}

export interface SkillRecallPayload {
  domain: string;
  ranked_skills: SkillRecallResult[];
  /** True iff the payload was forcibly truncated below `topK` to fit `maxBytes`. */
  oversized?: boolean;
}

export interface RankSkillsOptions {
  /** Root directory for per-domain skills.json files. */
  rootDir?: string;
  /** Top N skills considered before drop policy. Default 5. */
  topK?: number;
  /** Hard byte cap on the rendered JSON. Default 8 KB. */
  maxBytes?: number;
}

export interface RankSkillsInput {
  domain: string;
  /** Current state hash — reserved for future graph-aware ranking. */
  currentStateHash?: string;
  /** Current URL — reserved for future URL-aware ranking. */
  currentUrl?: string;
  /** Cap the number of results returned. */
  limit?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function rank(records: SkillRecord[]): SkillRecord[] {
  return [...records].sort((a, b) => {
    if (a.successCount !== b.successCount) return b.successCount - a.successCount;
    if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    return a.skillId.localeCompare(b.skillId);
  });
}

function buildEntry(rec: SkillRecord): SkillRecallResult {
  return {
    skillId: rec.skillId,
    name: rec.name,
    successCount: rec.successCount,
    lastUsedAt: rec.lastUsedAt,
    frozenSnapshotPath: rec.frozenSnapshotPath,
    expand_via: `${RECALL_URI_PREFIX}${rec.domain}/${rec.skillId}`,
  };
}

/**
 * Build the recall payload for `domain` from a pre-fetched list of records.
 * Returns null when the curator flag is disabled or when there are no skills.
 *
 * Hosts that already have records in memory should call this directly.
 * End-to-end callers should use `rankSkillsForRecall` which handles store
 * access and flag gating.
 */
export function buildRecallPayload(
  domain: string,
  records: SkillRecord[],
  opts: RankSkillsOptions = {},
): SkillRecallPayload | null {
  if (!isSkillCuratorEnabled()) return null;
  if (records.length === 0) return null;

  const topK = Math.max(1, opts.topK ?? envInt('OPENCHROME_SKILL_RECALL_TOPK', DEFAULT_TOP_K));
  // Honor caller-provided `maxBytes` as a hard cap. Only env / default
  // fall-throughs are clamped (to a small positive minimum); any
  // explicit caller value — including very small ones — is respected
  // so embeddings into fixed-size envelopes can rely on the cap.
  const maxBytes =
    opts.maxBytes !== undefined
      ? Math.max(1, opts.maxBytes)
      : Math.max(1, envInt('OPENCHROME_SKILL_RECALL_BYTES', DEFAULT_MAX_BYTES));

  const ranked = rank(records).slice(0, topK);
  const entries = ranked.map(buildEntry);

  // Drop from the bottom until the payload fits, but always keep ≥1.
  // The serialized `,"oversized":true` adds ~18 bytes; we set the flag
  // BEFORE the truncation loop in any case where dropping happens, so
  // the size check accounts for the flag's overhead and we can never
  // return an over-cap payload merely because the flag was appended
  // after truncation finished. (The intentional escape hatch is the
  // single-entry case: even one skill plus the flag may exceed
  // maxBytes — we ship it anyway with `oversized: true` set.)
  let payload: SkillRecallPayload = { domain, ranked_skills: entries };
  const size = () => Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size() > maxBytes) {
    payload = { ...payload, oversized: true };
    while (size() > maxBytes && payload.ranked_skills.length > 1) {
      payload.ranked_skills = payload.ranked_skills.slice(0, -1);
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
 * Rank skills for recall by reading from the `SkillMemoryStore` and
 * applying recency × success_count scoring.
 *
 * Returns null when:
 * - `isSkillCuratorEnabled()` is false, OR
 * - no skills are stored for the domain.
 *
 * This function is *read-only over the store* — it does not mutate any
 * skill record.
 */
export function rankSkillsForRecall(
  input: RankSkillsInput,
  opts: RankSkillsOptions = {},
): SkillRecallPayload | null {
  if (!isSkillCuratorEnabled()) return null;

  const store = new SkillMemoryStore({
    domain: input.domain,
    ...(opts.rootDir !== undefined ? { rootDir: opts.rootDir } : {}),
  });

  const limit = input.limit !== undefined ? input.limit : undefined;
  const records = store.list(limit !== undefined ? { limit } : {});
  if (records.length === 0) return null;

  return buildRecallPayload(input.domain, records, opts);
}
