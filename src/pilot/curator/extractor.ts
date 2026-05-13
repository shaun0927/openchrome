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
 *
 * Gated by `isSkillCuratorEnabled()` at call sites that integrate with
 * the contract runtime. The extractor itself is a deterministic transform
 * (no LLM calls — per Phase 4 / PR-20 scope).
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
const SKILL_LOCK_WAIT_MS = 5_000;
const SKILL_LOCK_STALE_MS = 30_000;
const SKILL_LOCK_POLL_MS = 10;

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

/**
 * Reject any `domain` value that could escape the skill-storage tree
 * via `path.join`. The frontmatter schema documents domain as the
 * eTLD+1 host (e.g. `amazon.com`); this guard is the load-bearing
 * check that keeps a malformed or hostile transaction record from
 * writing files outside `~/.openchrome/skills/`.
 *
 * The character set is intentionally narrow: alphanumerics, dot,
 * dash, underscore, and colon (so explicit non-default ports survive).
 * Anything else — path separators, parent-directory tokens, null
 * bytes — is a hard error.
 */
function assertSafeDomain(domain: string): void {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new Error('skill-memory: domain must be a non-empty string');
  }
  if (domain.length > 253) {
    throw new Error('skill-memory: domain is implausibly long');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(domain)) {
    throw new Error(`skill-memory: domain "${domain}" contains forbidden characters`);
  }
  // Reject parent-traversal segments even if individually valid chars.
  if (domain === '.' || domain === '..' || domain.split(/[./\\]/).some((seg) => seg === '..')) {
    throw new Error(`skill-memory: domain "${domain}" includes parent-directory traversal`);
  }
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
  // Each entry must carry a numeric timestamp so `trimRollingLog`
  // can compare against the rolling-window cutoff. A `null` /
  // `{}` / older-schema entry would otherwise pass the array check
  // and then throw at `e.ts` inside the merge path, blocking
  // future successful runs from being recorded.
  for (const e of s.runs.recent) {
    if (!e || typeof e !== 'object') return false;
    const entry = e as { txn_id?: unknown; ok?: unknown; ts?: unknown };
    if (typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) return false;
    if (typeof entry.ok !== 'boolean') return false;
    if (typeof entry.txn_id !== 'string') return false;
  }
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

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

function removeLockDir(lockDir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (code !== 'EPERM' && code !== 'ENOTEMPTY' && code !== 'EBUSY') throw err;
      sleepSync(SKILL_LOCK_POLL_MS);
    }
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
}

function withSkillLock<T>(lockDir: string, fn: () => T): T {
  const started = Date.now();

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      let stale = false;
      try {
        const stat = fs.statSync(lockDir);
        stale = Date.now() - stat.mtimeMs > SKILL_LOCK_STALE_MS;
      } catch (statErr) {
        const statCode = (statErr as NodeJS.ErrnoException).code;
        if (statCode === 'ENOENT') continue;
        if (statCode === 'EPERM' || statCode === 'EBUSY') {
          sleepSync(SKILL_LOCK_POLL_MS);
          continue;
        }
        throw statErr;
      }

      if (stale) {
        removeLockDir(lockDir);
        continue;
      }
      if (Date.now() - started >= SKILL_LOCK_WAIT_MS) {
        throw new Error(`skill-memory: timed out waiting for lock ${lockDir}`);
      }
      sleepSync(SKILL_LOCK_POLL_MS);
    }
  }

  try {
    fs.writeFileSync(path.join(lockDir, 'owner'), `${process.pid}\n`, { mode: 0o644 });
    return fn();
  } finally {
    removeLockDir(lockDir);
  }
}

/**
 * Resolve the sidecar to merge against for an update.
 *
 * - No prior markdown on disk → returns null (fresh-creation path).
 * - Markdown present, sidecar valid → returns the parsed sidecar.
 * - Markdown present, sidecar missing or schema-invalid → reconstructs
 *   a usable sidecar from the frontmatter so transient JSON-read
 *   issues, partial syncs, or older sidecar schemas never reset
 *   `verified_runs` and demote a previously-promoted skill back to
 *   candidate.
 *
 * This is the single source of truth that proves "if `existing`
 * is non-null then the merge path always sees a valid sidecar",
 * removing the need for any subsequent existence guard.
 */
function loadPriorSidecar(
  sidecarPath: string,
  existing: ReturnType<typeof parseSkillMd> | null,
  skillId: string,
  contractId: string,
  windowStartMs: number,
  nowMs: number,
): SkillSidecar | null {
  if (existing === null) return null;
  const raw = readJson<unknown>(sidecarPath);
  if (isValidSidecar(raw)) return raw;

  const priorTs = Date.parse(existing.frontmatter.last_verified_at);
  const priorMs = Number.isFinite(priorTs) ? priorTs : nowMs;
  const priorRuns = Math.max(0, existing.frontmatter.verified_runs);
  // Seed one synthetic recent entry per prior verified run so the
  // success-count recomputation in the merge path lands on the same
  // verified_runs total, which preserves promoted status across a
  // missing or malformed sidecar. Capped at SKILL_RUN_LOG_MAX-1 to
  // leave room for the new entry the merge path appends. The exact
  // timestamps are unknown — anchor at `last_verified_at` so the
  // rolling-window eventually drops them naturally.
  const seedCount = Math.min(priorRuns, SKILL_RUN_LOG_MAX - 1);
  const recent: SkillSidecar['runs']['recent'] = [];
  for (let i = 0; i < seedCount; i++) {
    recent.push({
      txn_id: existing.frontmatter.contract_ref,
      ok: true,
      ts: priorMs,
    });
  }
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    skill_id: skillId,
    graph_node_anchor: existing.frontmatter.graph_node_anchor,
    contract_id: contractId,
    runs: {
      count: priorRuns,
      window_start: isoUtc(windowStartMs),
      recent,
    },
  };
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
  // The rolling-window log is capped at SKILL_RUN_LOG_MAX entries,
  // so a threshold above that cap could never be reached: skills
  // would silently saturate at 50 verified_runs and never promote.
  // Refuse the misconfiguration loudly rather than letting it look
  // like the promotion gate just never fires.
  if (promotionThreshold < 1 || promotionThreshold > SKILL_RUN_LOG_MAX) {
    throw new Error(
      `skill-memory: promotionThreshold ${promotionThreshold} must be in [1, ${SKILL_RUN_LOG_MAX}]`,
    );
  }
  assertSafeDomain(inputs.domain);
  const skillId = computeSkillId(inputs.graph_node_anchor, inputs.contract_id);
  const domainDir = path.join(rootDir, inputs.domain);
  fs.mkdirSync(domainDir, { recursive: true });
  const lockPath = path.join(domainDir, `${skillId}.lock`);
  return withSkillLock(lockPath, () => {
  const filePath = path.join(domainDir, `${skillId}.md`);
  const sidecarPath = path.join(domainDir, `${skillId}.json`);
  const t = now();
  const tsIso = isoUtc(t);
  const windowStartMs = t - ROLLING_WINDOW_MS;

  const existing = fs.existsSync(filePath) ? parseSkillMd(fs.readFileSync(filePath, 'utf8')) : null;

  // Pick the prior sidecar to merge against. Read + shape-validate
  // first; if validation fails BUT the markdown is present, rebuild
  // from the frontmatter so a transient JSON read issue or older
  // schema never resets verified_runs / promotion state. Returns null
  // only when there is no prior skill at all (the fresh-creation
  // path).
  const priorSidecar = loadPriorSidecar(
    sidecarPath,
    existing,
    skillId,
    inputs.contract_id,
    windowStartMs,
    t,
  );

  let frontmatter: SkillFrontmatter;
  let sidecar: SkillSidecar;
  let promoted = false;
  const created = existing === null;

  if (existing !== null) {
    // Update path. `priorSidecar` is guaranteed non-null here because
    // `loadPriorSidecar` always returns a usable sidecar when the
    // markdown is present (rebuilding from frontmatter when needed),
    // so no further nullability check is required against the
    // markdown+sidecar product — the rebuild path closes that gap.
    const prior = priorSidecar as SkillSidecar;
    const recent = trimRollingLog(
      [...prior.runs.recent, { txn_id: inputs.txn_id, ok: true, ts: t }],
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
    // Creation path — fresh skill, no prior on disk.
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
    existing?.body ??
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
  });
}

/** Read every SKILL.md under a domain (recall + curator consume this). */
export function listSkillsForDomain(domain: string, opts: ExtractorOptions = {}): SkillRecord[] {
  assertSafeDomain(domain);
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
