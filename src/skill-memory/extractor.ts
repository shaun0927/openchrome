/**
 * Verified Skill Extractor (#713 v2).
 *
 * Triggered on `transaction.verdict === 'success'` from the contract
 * runtime. Distills the trajectory into a SKILL.md candidate (or
 * increments `verified_runs` on an existing skill).
 *
 * Identity per #713 v2: `(graph_node_anchor, contract_id)`. Two
 * settlements with both fields equal increment the same skill —
 * intent text is informational only.
 *
 * Promotion rule: `verified_runs >= N` (default 3) within a trailing
 * 30-day window flips status from `candidate` to `promoted`. The
 * window is sliding — failures don't reset the counter, they're
 * simply not counted.
 *
 * Storage layout (per #713 v2 `### Storage layout`):
 *
 *   ~/.openchrome/skills/<domain>/<skill_id>.md   (frontmatter + body)
 *                                  /<skill_id>.json (sidecar)
 *
 * `<skill_id>` is `sha256(graph_node_anchor + '|' + contract_id)` truncated
 * to 12 hex chars — short enough for filesystem readability, long
 * enough to avoid collisions across thousands of skills per domain.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseSkillMd, stringifySkillMd } from './skill-md';
import {
  SKILL_RUN_LOG_MAX,
  SKILL_SCHEMA_VERSION,
  type SkillFrontmatter,
  type SkillRecord,
  type SkillSidecar,
  type SkillStatus,
} from './types';

const PROMOTION_RUN_THRESHOLD = 3;
const ROLLING_WINDOW_DAYS = 30;
const ROLLING_WINDOW_MS = ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface ExtractionInputs {
  /** Settled transaction id used as `contract_ref`. */
  txn_id: string;
  /** The contract-id this transaction settled under. */
  contract_id: string;
  /** Whatever short label the operator wants to remember the skill by. */
  intent: string;
  /** eTLD+1 host this skill applies to. */
  domain: string;
  /** Hex state-hash from #702 — entry node in the skill graph. */
  graph_node_anchor: string;
  /** Optional rolled-up budget hint for the SKILL.md body. */
  budget?: { tokens_typical?: number; wall_ms_typical?: number };
  /**
   * Body of the SKILL.md — the LLM distillation in PR-20b. PR-20 ships
   * a deterministic placeholder body so the system is end-to-end
   * testable without an LLM.
   */
  body?: string;
  /** Operator-supplied skill name. Optional; auto-derived from intent. */
  name?: string;
}

export interface ExtractorOptions {
  rootDir?: string;
  /** Promotion threshold (count of successful re-runs). */
  promotionThreshold?: number;
  /** Test hook: clock. */
  now?: () => number;
}

export interface ExtractionResult {
  record: SkillRecord;
  /** True iff this call created a new file (vs. incrementing). */
  created: boolean;
  /** True iff status transitioned candidate → promoted. */
  promoted: boolean;
}

export function defaultSkillRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'skills');
}

export function computeSkillId(graphNodeAnchor: string, contractId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${graphNodeAnchor}|${contractId}`)
    .digest('hex')
    .slice(0, 12);
}

function deriveName(intent: string, fallback: string): string {
  const cleaned = intent
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (cleaned.length === 0) return fallback;
  return cleaned;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoUtc(ms: number): string {
  const d = new Date(ms);
  const ts = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
  return ts;
}

function trimRollingLog(
  recent: SkillSidecar['runs']['recent'],
  windowStartMs: number,
): SkillSidecar['runs']['recent'] {
  return recent.filter((e) => e.ts >= windowStartMs).slice(-SKILL_RUN_LOG_MAX);
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Structural guard for `SkillSidecar` — `readJson` only proves the
 * file is parseable JSON, not that it matches the expected shape.
 * Without this, a sidecar containing `{}` or an older schema missing
 * `runs.recent` would silently pass the existence check and then
 * crash inside the merge path at `sidecar.runs.recent`.
 */
function isValidSidecar(v: unknown): v is SkillSidecar {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<SkillSidecar>;
  if (s.schema_version !== SKILL_SCHEMA_VERSION) return false;
  if (typeof s.skill_id !== 'string') return false;
  if (typeof s.graph_node_anchor !== 'string') return false;
  if (typeof s.contract_id !== 'string') return false;
  if (!s.runs || typeof s.runs !== 'object') return false;
  if (!Array.isArray(s.runs.recent)) return false;
  if (typeof s.runs.count !== 'number') return false;
  if (typeof s.runs.window_start !== 'string') return false;
  return true;
}

/**
 * Atomic file write using a per-call unique temp path so concurrent
 * writers for the same target never race on a shared `.tmp` file.
 * Without uniqueness, two parallel `recordSuccessfulRun` calls on the
 * same `(graph_node_anchor, contract_id)` could clobber each other's
 * temp file and one of the renames would either fail or destroy the
 * other writer's data.
 */
function writeAtomic(target: string, body: string): void {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o644 });
    fs.renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup on failure — never let a stray .tmp leak.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* file already gone or never created */
    }
    throw err;
  }
}

/**
 * Process one successful settlement. Idempotent: subsequent calls with
 * the same `(graph_node_anchor, contract_id)` increment counters in
 * place rather than producing a new file.
 */
export function recordSuccessfulRun(
  inputs: ExtractionInputs,
  opts: ExtractorOptions = {},
): ExtractionResult {
  const rootDir = opts.rootDir ?? defaultSkillRootDir();
  const now = opts.now ?? Date.now;
  const promotionThreshold = opts.promotionThreshold ?? PROMOTION_RUN_THRESHOLD;
  const skillId = computeSkillId(inputs.graph_node_anchor, inputs.contract_id);
  const domainDir = path.join(rootDir, inputs.domain);
  fs.mkdirSync(domainDir, { recursive: true });
  const filePath = path.join(domainDir, `${skillId}.md`);
  const sidecarPath = path.join(domainDir, `${skillId}.json`);
  const t = now();
  const tsIso = isoUtc(t);
  const windowStartMs = t - ROLLING_WINDOW_MS;

  const existing = fs.existsSync(filePath) ? parseSkillMd(fs.readFileSync(filePath, 'utf8')) : null;
  const rawSidecar = readJson<unknown>(sidecarPath);
  // Validate sidecar shape — `readJson` only proves the file is JSON.
  // A structurally malformed but parseable sidecar (`{}`, an older
  // schema missing `runs.recent`, etc.) would otherwise pass the
  // existence check and crash inside the merge path. Treating it as
  // "missing" routes the call into the rebuild branch below.
  let existingSidecar: SkillSidecar | undefined = isValidSidecar(rawSidecar) ? rawSidecar : undefined;
  // Markdown exists but sidecar is missing or unreadable. Falling
  // through to the "create new" path would silently reset
  // verified_runs to 1 and discard the promotion state recorded in
  // the markdown, so reconstruct a minimal sidecar from the
  // frontmatter instead. This preserves the count across transient
  // sidecar IO issues; the rolling window collapses to a single
  // synthetic entry timestamped at the previous `last_verified_at`.
  if (existing && !existingSidecar) {
    const priorTs = Date.parse(existing.frontmatter.last_verified_at);
    const priorMs = Number.isFinite(priorTs) ? priorTs : t;
    const priorRuns = Math.max(0, existing.frontmatter.verified_runs);
    // Seed one synthetic recent entry per prior verified run so the
    // success-count recomputation in the merge path lands on the same
    // verified_runs total, which preserves promoted status across a
    // missing sidecar. Capped at SKILL_RUN_LOG_MAX-1 to leave room for
    // the new entry the merge path appends. The exact timestamps are
    // unknown — we anchor at last_verified_at so the rolling-window
    // eventually drops them naturally.
    const seedCount = Math.min(priorRuns, SKILL_RUN_LOG_MAX - 1);
    const recent: SkillSidecar['runs']['recent'] = [];
    for (let i = 0; i < seedCount; i++) {
      recent.push({
        txn_id: existing.frontmatter.contract_ref,
        ok: true,
        ts: priorMs,
      });
    }
    existingSidecar = {
      schema_version: SKILL_SCHEMA_VERSION,
      skill_id: skillId,
      graph_node_anchor: existing.frontmatter.graph_node_anchor,
      contract_id: inputs.contract_id,
      runs: {
        count: priorRuns,
        window_start: isoUtc(windowStartMs),
        recent,
      },
    };
  }

  let frontmatter: SkillFrontmatter;
  let sidecar: SkillSidecar;
  let promoted = false;
  let created = false;

  if (existing && existingSidecar) {
    const recent = trimRollingLog(
      [...existingSidecar.runs.recent, { txn_id: inputs.txn_id, ok: true, ts: t }],
      windowStartMs,
    );
    const successes = recent.filter((e) => e.ok).length;
    const newStatus: SkillStatus =
      existing.frontmatter.status === 'archived'
        ? 'archived'
        : successes >= promotionThreshold
          ? 'promoted'
          : 'candidate';
    if (existing.frontmatter.status !== 'promoted' && newStatus === 'promoted') {
      promoted = true;
    }
    frontmatter = {
      ...existing.frontmatter,
      verified_runs: successes,
      last_verified_at: tsIso,
      contract_ref: inputs.txn_id,
      status: newStatus,
    };
    sidecar = {
      schema_version: SKILL_SCHEMA_VERSION,
      skill_id: skillId,
      graph_node_anchor: inputs.graph_node_anchor,
      contract_id: inputs.contract_id,
      runs: {
        count: successes,
        window_start: isoUtc(windowStartMs),
        recent,
      },
    };
  } else {
    created = true;
    const fallbackName = `skill-${skillId}`;
    frontmatter = {
      schema_version: SKILL_SCHEMA_VERSION,
      name: inputs.name ? inputs.name : deriveName(inputs.intent, fallbackName),
      domain: inputs.domain,
      intent: inputs.intent.slice(0, 512),
      status: 'candidate',
      verified_runs: 1,
      last_verified_at: tsIso,
      contract_ref: inputs.txn_id,
      graph_node_anchor: inputs.graph_node_anchor,
      author: 'agent',
      ...(inputs.budget ? { budget: inputs.budget } : {}),
    };
    sidecar = {
      schema_version: SKILL_SCHEMA_VERSION,
      skill_id: skillId,
      graph_node_anchor: inputs.graph_node_anchor,
      contract_id: inputs.contract_id,
      runs: {
        count: 1,
        window_start: isoUtc(windowStartMs),
        recent: [{ txn_id: inputs.txn_id, ok: true, ts: t }],
      },
    };
  }

  const body =
    inputs.body ??
    `## Steps (LLM distillation lands in PR-20b)

This SKILL.md was extracted from a contract-verified successful
trajectory.  Until the LLM distiller is wired, the body is the literal
intent string.

> ${inputs.intent}
`;

  writeAtomic(filePath, stringifySkillMd({ frontmatter, body }));
  writeAtomic(sidecarPath, JSON.stringify(sidecar, null, 2));

  return {
    created,
    promoted,
    record: {
      skill_id: skillId,
      filePath,
      sidecarPath,
      frontmatter,
      sidecar,
    },
  };
}

/** Read every SKILL.md under a domain (recall + curator consume this). */
export function listSkillsForDomain(domain: string, opts: ExtractorOptions = {}): SkillRecord[] {
  const rootDir = opts.rootDir ?? defaultSkillRootDir();
  const domainDir = path.join(rootDir, domain);
  if (!fs.existsSync(domainDir)) return [];
  const out: SkillRecord[] = [];
  for (const file of fs.readdirSync(domainDir)) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(domainDir, file);
    const skill_id = file.replace(/\.md$/, '');
    const sidecarPath = path.join(domainDir, `${skill_id}.json`);
    let parsed;
    try {
      parsed = parseSkillMd(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const sidecar = readJson<unknown>(sidecarPath);
    if (!isValidSidecar(sidecar)) continue;
    out.push({
      skill_id,
      filePath,
      sidecarPath,
      frontmatter: parsed.frontmatter,
      sidecar,
    });
  }
  return out;
}
