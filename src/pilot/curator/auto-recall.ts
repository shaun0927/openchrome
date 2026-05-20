/**
 * Auto-recall over the curator's SKILL.md tree.
 *
 * Complementary to `src/core/skill-memory/auto-recall.ts`, which
 * reads from the JSON `SkillMemoryStore`. This module instead reads
 * the curator's filesystem skill records that `recordSuccessfulRun`
 * writes under `~/.openchrome/skills/<domain>/<skill_id>.md`.
 *
 * Activation chain:
 *   - `--pilot` (pilot tier)
 *   - `OPENCHROME_SKILL_CURATOR` (default-on inside pilot) — the
 *     family that owns these files.
 *   - `OPENCHROME_AUTO_RECALL` (opt-in, off by default).
 *
 * When called, returns at most `limit` promoted curator skills for
 * the requested domain (eTLD+1 host), ranked
 * `verified_runs DESC, last_verified_at DESC, skill_id ASC` so the
 * payload is byte-stable. Candidate / archived skills are excluded —
 * the host agent only sees skills that have crossed the promotion
 * threshold.
 *
 * Hard ceilings:
 *   - At most `limit` skills (default 5; clamped to [1, 25]).
 *   - Each `intent` field truncated to 256 chars to keep payloads
 *     compact; the full text lives in the SKILL.md frontmatter for
 *     a host agent that wants to deep-dive.
 */

import { isAutoRecallEnabled, isPilotEnabled, isSkillCuratorEnabled } from '../../harness/flags.js';
import { listSkillsForDomain } from './extractor.js';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const INTENT_MAX_CHARS = 256;

export interface RecalledCuratorSkill {
  readonly skill_id: string;
  readonly name: string;
  readonly intent: string;
  readonly verified_runs: number;
  readonly last_verified_at: string;
  readonly state_hash_version?: string;
}

export interface RecalledCuratorSkillsPayload {
  readonly domain: string;
  readonly skills: ReadonlyArray<RecalledCuratorSkill>;
}

export interface RecallCuratorSkillsInput {
  /** eTLD+1 host whose promoted skills should be recalled. */
  readonly domain: string;
  /** Bound on returned skills (default 5, clamped to [1, 25]). */
  readonly limit?: number;
  /** Override the skill root directory (production callers omit). */
  readonly rootDir?: string;
}

/**
 * Returns `null` when:
 *   - The pilot tier is closed (`isPilotEnabled() === false`), OR
 *   - The skill-curator family is disabled, OR
 *   - The auto-recall opt-in is off, OR
 *   - The domain is empty / malformed, OR
 *   - No promoted skills exist for the domain.
 *
 * Callers MUST treat a `null` return as "skip" — never substitute a
 * default payload, otherwise audit consumers would see phantom
 * recall events that never actually happened.
 */
export function recallCuratorSkills(
  input: RecallCuratorSkillsInput,
): RecalledCuratorSkillsPayload | null {
  if (!isPilotEnabled()) return null;
  if (!isSkillCuratorEnabled()) return null;
  if (!isAutoRecallEnabled()) return null;

  const domain = (input.domain ?? '').trim().toLowerCase();
  if (domain.length === 0) return null;

  const limit = clampLimit(input.limit);

  let records;
  try {
    records = listSkillsForDomain(domain, input.rootDir ? { rootDir: input.rootDir } : {});
  } catch {
    return null;
  }

  const promoted = records.filter((r) => r.frontmatter.status === 'promoted');
  if (promoted.length === 0) return null;

  // Stable sort: verified_runs DESC, last_verified_at DESC, skill_id ASC.
  promoted.sort((a, b) => {
    if (b.frontmatter.verified_runs !== a.frontmatter.verified_runs) {
      return b.frontmatter.verified_runs - a.frontmatter.verified_runs;
    }
    const at = Date.parse(a.frontmatter.last_verified_at);
    const bt = Date.parse(b.frontmatter.last_verified_at);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
    return a.skill_id.localeCompare(b.skill_id);
  });

  const skills: RecalledCuratorSkill[] = promoted.slice(0, limit).map((r) => {
    const fm = r.frontmatter as unknown as Record<string, unknown>;
    const stateHashVersion = typeof fm.state_hash_version === 'string'
      ? (fm.state_hash_version as string)
      : undefined;
    return {
      skill_id: r.skill_id,
      name: r.frontmatter.name,
      intent: r.frontmatter.intent.slice(0, INTENT_MAX_CHARS),
      verified_runs: r.frontmatter.verified_runs,
      last_verified_at: r.frontmatter.last_verified_at,
      ...(stateHashVersion !== undefined ? { state_hash_version: stateHashVersion } : {}),
    };
  });

  return { domain, skills };
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

/**
 * Derive an eTLD+1 host from a URL. Returns `null` for unparseable
 * input. The curator stores skills under hostname keys with no
 * public-suffix-list dependency, so this returns the literal
 * `hostname` rather than parsing the eTLD+1 — matches how
 * `recordSuccessfulRun` indexes skills.
 */
export function hostnameForRecall(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
