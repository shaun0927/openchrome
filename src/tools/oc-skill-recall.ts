/**
 * oc_skill_recall — retrieve skills from the JSON skill memory store (issue #785).
 *
 * Core-tier MCP tool. Returns a recency-sorted, optionally filtered listing
 * of skills stored via oc_skill_record. No LLM ranking is applied — the
 * deterministic order (last_used_at desc, skill_id asc on ties) is produced
 * directly by the store. The pilot recall layer is responsible for any
 * relevance reranking above this surface.
 *
 * Filtering: `contract_id` restricts to skills bound to that contract;
 * `limit` caps the result count (default 20).
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { SkillMemoryStore, type SkillRecord } from '../core/skill-memory';

interface OcSkillRecallOutput {
  skills: SkillRecord[];
  error?: string;
}

const DEFAULT_LIMIT = 20;

const definition: MCPToolDefinition = {
  name: 'oc_skill_recall',
  description:
    'Retrieve skills from the JSON skill memory store for a given domain. ' +
    'Returns a recency-sorted list (last_used_at desc). Optionally filter by ' +
    '`contract_id` and cap results with `limit` (default 20). No LLM ranking — ' +
    'deterministic store order is returned as-is. Use oc_skill_record to write skills.',
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
      limit: {
        type: 'number',
        description:
          `Maximum number of skills to return. Default ${DEFAULT_LIMIT}. ` +
          'Pass 0 to return an empty list. Values below 0 are treated as 0.',
      },
    },
    required: ['domain'],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const domain = args.domain as string | undefined;
  const contractId = args.contract_id as string | undefined;
  const rawLimit = args.limit;

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

  // Replay-aware ranking (#856 invariant #4): bucket each skill into
  // replay_signal ∈ {+1, 0, -1} and sort
  //   (signal desc, lastUsedAt desc, skillId asc)
  // so passed-replay skills surface first, never-replayed in the middle,
  // and failed-replay skills sink to the bottom. Recency breaks within-
  // bucket ties; skillId provides a deterministic final tiebreak.
  const ranked = skills.slice().sort((a, b) => {
    const sa = computeReplaySignal(a);
    const sb = computeReplaySignal(b);
    if (sa !== sb) return sb - sa; // signal desc
    if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
  });

  const capped = limit === 0 ? [] : ranked.slice(0, limit);
  return jsonResult({ skills: capped });
};

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
