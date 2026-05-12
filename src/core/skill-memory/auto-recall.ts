/**
 * Auto-recall helper for navigate / tabs_create (#824).
 *
 * Reads skills for a given origin from the local JSON skill store (same path
 * as oc_skill_recall) and returns a bounded payload suitable for embedding in
 * tool responses. No network I/O, no LLM calls — pure local-filesystem read.
 *
 * Payload ceilings (hard):
 *   - At most MAX_SKILLS skills per response (default 3).
 *   - Per-skill body limited to MAX_BODY_BYTES (default 2048 bytes).
 *   - Total payload body limited to MAX_TOTAL_BYTES (default 8192 bytes).
 *
 * When a ceiling is hit the relevant `truncated` flag is set to true.
 */

import { SkillMemoryStore } from './store';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoRecallSummary {
  name: string;
  domain: string;
  body: string;
  truncated: boolean;
}

export interface AutoRecallPayload {
  skills: AutoRecallSummary[];
  truncated: boolean;
  total_bytes: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_BODY_BYTES = 2048;
const DEFAULT_MAX_TOTAL_BYTES = 8192;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface AutoRecallOptions {
  origin: string;
  /** Maximum number of skills to include (default 3). */
  limit?: number;
  /** Maximum bytes per skill body (default 2048). */
  maxBodyBytes?: number;
  /** Maximum total bytes across all skill bodies (default 8192). */
  maxTotalBytes?: number;
  /** Override the store root directory (for tests). */
  rootDir?: string;
}

/**
 * Read up to `limit` skills for `origin` from the local skill store and
 * return a size-bounded payload. Always resolves — errors (missing store,
 * malformed JSON, domain encoding failure) are swallowed and result in an
 * empty payload so callers can safely fire-and-forget.
 */
export async function autoRecallForOrigin(opts: AutoRecallOptions): Promise<AutoRecallPayload> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const { origin } = opts;

  const empty: AutoRecallPayload = { skills: [], truncated: false, total_bytes: 0 };

  if (typeof origin !== 'string' || origin.length === 0) return empty;

  let store: SkillMemoryStore;
  try {
    store = new SkillMemoryStore({ domain: origin, ...(opts.rootDir && { rootDir: opts.rootDir }) });
  } catch {
    return empty;
  }

  let records;
  try {
    // list() returns records sorted by last_used_at desc — same order as
    // oc_skill_recall. We request one extra record beyond `limit` so we can
    // detect whether the list was clipped.
    records = store.list({ limit: limit + 1 });
  } catch {
    return empty;
  }

  // Determine whether the full list was longer than our cap.
  const listTruncated = records.length > limit;
  const capped = records.slice(0, limit);

  const skills: AutoRecallSummary[] = [];
  let totalBytes = 0;
  let payloadTruncated = listTruncated;

  for (const record of capped) {
    // Serialize the skill body: name + steps as JSON text.
    const rawBody = JSON.stringify({ name: record.name, steps: record.steps });

    let body: string;
    let skillTruncated = false;

    if (Buffer.byteLength(rawBody, 'utf8') > maxBodyBytes) {
      // Truncate to maxBodyBytes (byte-safe slice).
      body = Buffer.from(rawBody, 'utf8').slice(0, maxBodyBytes).toString('utf8');
      skillTruncated = true;
      payloadTruncated = true;
    } else {
      body = rawBody;
    }

    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (totalBytes + bodyBytes > maxTotalBytes) {
      // Adding this skill would exceed the total ceiling — stop here.
      payloadTruncated = true;
      break;
    }

    totalBytes += bodyBytes;
    skills.push({ name: record.name, domain: record.domain, body, truncated: skillTruncated });
  }

  return { skills, truncated: payloadTruncated, total_bytes: totalBytes };
}
