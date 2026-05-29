/**
 * oc_skill_recall — retrieve skills from the JSON skill memory store (issue #785).
 *
 * Core-tier MCP tool. Returns a recency-sorted, optionally filtered listing
 * of skills stored via oc_skill_record by default. Callers can opt in to
 * deterministic task-aware ranking with `task` / `query` or `ranked: true`;
 * no LLM, network call, or automatic skill execution is involved.
 *
 * Filtering: `contract_id` restricts to skills bound to that contract;
 * `limit` caps the result count (default 20).
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { SkillMemoryStore, type SkillRecord } from '../core/skill-memory';
import { createAuditLogStatsResolver, type SkillStatsResolver } from '../core/skill-memory/stats-resolver';

export interface RankedSkillRecord extends SkillRecord {
  score?: number;
  reason?: string;
  stepsPreview?: unknown;
  replaySignal?: -1 | 0 | 1;
}

interface OcSkillRecallOutput {
  skills: RankedSkillRecord[];
  /**
   * True when the domain has at least one `re_verified` or `recallable` skill
   * and the default filter applied (legacy `recorded` records were hidden).
   * False when no promoted skills exist yet — recall falls back to v1.x
   * semantics and surfaces all non-quarantined records so legacy callers and
   * pre-promotion stores keep working unchanged.
   */
  promotion_filter_active?: boolean;
  error?: string;
}

const DEFAULT_LIMIT = 20;

const definition: MCPToolDefinition = {
  name: 'oc_skill_recall',
  description:
    'Retrieve skills from the JSON skill memory store for a given domain. ' +
    'Returns a recency-sorted list (last_used_at desc). Optionally filter by ' +
    '`contract_id` and cap results with `limit` (default 20). No LLM ranking — ' +
    'deterministic store order is returned as-is unless task/query or ranked ' +
    'is supplied. Use oc_skill_record to write skills.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description:
          'Domain to retrieve skills for (e.g. "amazon.com"). Must be a ' +
          'non-empty string ≤ 253 chars and match the domain used at record time.',
      },
      contract_id: {
        type: 'string',
        description:
          'Optional. Restrict results to skills whose contract_id matches ' +
          'this value exactly. Omit to return skills across all contracts.',
      },
      task: {
        type: 'string',
        description:
          'Optional task text. When present, recall is ranked by deterministic task relevance.',
      },
      query: {
        type: 'string',
        description: 'Optional alias for task. Ignored when task is also provided.',
      },
      ranked: {
        type: 'boolean',
        description: 'Opt in to deterministic ranked recall. Also enabled when task is provided.',
      },
      limit: {
        type: 'number',
        description:
          `Maximum number of skills to return. Default ${DEFAULT_LIMIT}. ` +
          'Pass 0 to return an empty list. Values below 0 are treated as 0.',
      },
      include_unpromoted: {
        type: 'boolean',
        description:
          'When true, also surface promotionState=recorded skills. Default ' +
          'false: once a domain has any re_verified/recallable skill, recall ' +
          'hides recorded ones to keep the LLM-free fast path safe. Domains ' +
          'with no promoted skill auto-fallback to v1.x (all non-quarantined ' +
          'surface). (#1431)',
      },
      include_quarantined: {
        type: 'boolean',
        description:
          'When true, also surface promotionState=quarantined skills. Default ' +
          'false; diagnostic only — they failed re-verification and should not ' +
          'be replayed. Independent of the recorded/promoted filter, so on an ' +
          'unpromoted domain (v1.x auto-fallback) it yields recorded + ' +
          'quarantined. (#1431)',
      },
      use_run_stats: {
        type: 'boolean',
        description:
          'Opt in to factor audit-log run statistics (recent-window failure ' +
          'rate) into ranked recall, demoting skills that fail often. Implies ' +
          'ranked recall. Default false — when off, recall does no audit-log ' +
          'I/O and behaves exactly as before. When on, recall performs a one-' +
          'time synchronous scan of the audit log per call, which can be slower ' +
          'on very large logs. (#1457)',
      },
    },
    required: ['domain'],
  },
  annotations: TOOL_ANNOTATIONS.oc_skill_recall,
};

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const domain = args.domain as string | undefined;
  const contractId = args.contract_id as string | undefined;
  const rawLimit = args.limit;
  const task = typeof args.task === 'string'
    ? args.task
    : typeof args.query === 'string'
      ? args.query
      : '';
  const useRunStats = args.use_run_stats === true;
  const rankedRecall = args.ranked === true || task.trim().length > 0 || useRunStats;

  if (typeof domain !== 'string' || domain.length === 0) {
    const output: OcSkillRecallOutput = {
      skills: [],
      error: 'missing required field: domain (must be a non-empty string)',
    };
    return jsonResult(output);
  }

  const limit =
    typeof rawLimit === 'number'
      ? Math.max(0, Math.floor(rawLimit))
      : DEFAULT_LIMIT;

  let store: SkillMemoryStore;
  try {
    store = new SkillMemoryStore({ domain });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output: OcSkillRecallOutput = {
      skills: [],
      error: `failed to initialise skill memory store: ${message}`,
    };
    return jsonResult(output);
  }

  let skills: SkillRecord[];
  try {
    // Fetch un-capped so the replay_signal re-rank applies across the full
    // candidate set; cap afterwards. The store's own list cap would
    // otherwise truncate before the demote-on-fail buckets are computed.
    skills = store.list({
      contract_id: contractId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output: OcSkillRecallOutput = {
      skills: [],
      error: `failed to list skills: ${message}`,
    };
    return jsonResult(output);
  }

  // Promotion-state filter (#1431 Part 2). Quarantined records are hidden
  // unless `include_quarantined` is set. The `recorded` vs promoted filter
  // auto-falls-back to v1.x semantics when no promoted skill exists in the
  // domain — without this, every v1.x deployment that upgrades silently
  // loses all recall results because legacy records normalise to `recorded`
  // on read. Once at least one skill is promoted to `re_verified` or
  // `recallable`, the filter activates and hides `recorded` ones unless
  // `include_unpromoted` is set.
  const includeUnpromoted = args.include_unpromoted === true;
  const includeQuarantined = args.include_quarantined === true;
  const hasPromoted = skills.some((s) => {
    const state = s.promotionState ?? 'recorded';
    return state === 're_verified' || state === 'recallable';
  });
  const promotionFilterActive = hasPromoted && !includeUnpromoted;
  skills = skills.filter((s) => {
    const state = s.promotionState ?? 'recorded';
    if (state === 'quarantined') return includeQuarantined;
    if (state === 'recorded') return !promotionFilterActive;
    // re_verified or recallable: always surface.
    return true;
  });

  // #1457 PR-7: opt-in audit-log run statistics. The resolver is built only when
  // requested, so the default recall path does zero audit-log I/O (P7 — core
  // stays fast and deterministic).
  const statsResolver: SkillStatsResolver | undefined = useRunStats
    ? createAuditLogStatsResolver()
    : undefined;
  const ordered = rankedRecall
    ? rankSkillsForTask(skills, { task, contractId, statsResolver })
    : applyRecallRanking(skills);

  const capped = limit === 0 ? [] : ordered.slice(0, limit);
  return jsonResult({ skills: capped, promotion_filter_active: promotionFilterActive });
};

export function applyRecallRanking(skills: SkillRecord[]): SkillRecord[] {
  // Replay-aware ranking (#856 invariant #4): bucket each skill into
  // replay_signal ∈ {+1, 0, -1} and sort
  //   (signal desc, lastUsedAt desc, skillId asc)
  // so passed-replay skills surface first, never-replayed in the middle,
  // and failed-replay skills sink to the bottom. Recency breaks within-
  // bucket ties; skillId provides a deterministic final tiebreak.
  return skills.slice().sort((a, b) => {
    const sa = computeReplaySignal(a);
    const sb = computeReplaySignal(b);
    if (sa !== sb) return sb - sa; // signal desc
    if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
  });
}

export function rankSkillsForTask(
  skills: SkillRecord[],
  opts: { task?: string; contractId?: string; statsResolver?: SkillStatsResolver } = {},
): RankedSkillRecord[] {
  const queryTokens = [...tokenize(opts.task || '')];
  return skills
    .map((skill) => scoreSkillForTask(skill, queryTokens, opts.contractId, opts.statsResolver))
    .sort((a, b) => {
      if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
    });
}

/**
 * Replay signal for #856 ranking. See SkillRecord.lastReplayPassedAt /
 * lastReplayFailedAt — the most recent replay wins. Skills with no replay
 * record produce 0 (neutral).
 */
export function computeReplaySignal(s: SkillRecord): -1 | 0 | 1 {
  const passedAt = s.lastReplayPassedAt ?? 0;
  const failedAt = s.lastReplayFailedAt ?? 0;
  if (passedAt === 0 && failedAt === 0) return 0;
  if (passedAt > failedAt) return 1;
  if (failedAt > passedAt) return -1;
  return 0;
}

export function scoreSkillForTask(
  skill: SkillRecord,
  queryTokens: string[],
  contractId?: string,
  statsResolver?: SkillStatsResolver,
): RankedSkillRecord {
  const searchable = buildRecallText(skill);
  const skillTokens = tokenize(searchable);
  const overlapCount = queryTokens.filter((token) => skillTokens.has(token)).length;
  const overlap = queryTokens.length === 0 ? 0 : overlapCount / queryTokens.length;
  const replaySignal = computeReplaySignal(skill);
  const successBoost = Math.min(Math.max(skill.successCount, 0), 10) * 0.025;
  const replayBoost = replaySignal * 0.2;
  const contractBoost = contractId && skill.contractId === contractId ? 0.15 : 0;
  // #1457 PR-7: opt-in audit-log failure-rate penalty. Only applied when a stats
  // resolver is supplied (use_run_stats); a skill that fails often in the recent
  // window is demoted proportionally. Deterministic, no LLM.
  let statsPenalty = 0;
  const statsReason: string[] = [];
  if (statsResolver) {
    const stats = statsResolver(skill);
    const runs = stats.successesInWindow + stats.failuresInWindow;
    if (runs > 0) {
      const failRate = stats.failuresInWindow / runs;
      statsPenalty = -0.3 * failRate;
      // Only surface the note when there is an actual penalty. A skill with
      // runs but zero failures (failRate 0) is not demoted, so emitting
      // `run_fail_rate=0.00` would be misleading noise rather than a signal.
      if (failRate > 0) {
        statsReason.push(`run_fail_rate=${failRate.toFixed(2)} (${stats.failuresInWindow}/${runs} in window)`);
      }
    }
  }
  const score = Math.max(0, Math.min(1, overlap + successBoost + replayBoost + contractBoost + statsPenalty));
  const reasons = [
    `${overlapCount}/${queryTokens.length || 0} task-token matches`,
    `success_count=${skill.successCount}`,
    `replay_signal=${replaySignal}`,
  ];
  if (contractBoost > 0) reasons.push(`contract_id=${contractId}`);
  reasons.push(...statsReason);
  return {
    ...skill,
    score: Number(score.toFixed(4)),
    reason: reasons.join('; '),
    stepsPreview: previewSteps(skill.steps),
    replaySignal,
  };
}

export function buildRecallText(skill: SkillRecord): string {
  return [
    skill.name,
    skill.contractId,
    JSON.stringify(redactPreviewValue(skill.steps) ?? ''),
  ].join(' ');
}

function tokenize(text: string): Set<string> {
  const stop = new Set([
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'into',
    'from',
    'then',
    'task',
    'verify',
    'success',
  ]);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_ -]+/g, ' ')
    .split(/[\s_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stop.has(token));
  return new Set(tokens);
}

function previewSteps(steps: unknown): unknown {
  if (!Array.isArray(steps)) return undefined;
  return steps.slice(0, 3).map((step) => redactPreviewValue(step));
}

function redactPreviewValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/password|token|secret|cookie|authorization/i.test(value)) return '[REDACTED]';
    return value.length > 160 ? `${value.slice(0, 159)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => redactPreviewValue(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
      out[key] = /password|token|secret|cookie|authorization/i.test(key)
        ? '[REDACTED]'
        : redactPreviewValue(child);
    }
    return out;
  }
  return value;
}

function jsonResult(payload: OcSkillRecallOutput): MCPResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
    ...payload,
  };
}

export function registerOcSkillRecallTool(server: MCPServer): void {
  server.registerTool('oc_skill_recall', handler, definition);
}
