/**
 * oc_skill_record — record a skill into the JSON skill memory store (issue #785).
 *
 * Core-tier MCP tool. Accepts a skill definition (domain, name, steps,
 * contract_id) and persists it via SkillMemoryStore. Optionally writes a
 * frozen snapshot alongside the record and returns the snapshot path.
 *
 * The tool is idempotent on (domain, name): re-recording with the same name
 * updates mutable fields (steps, contract_id, frozen_snapshot_path) but
 * preserves the existing skill_id and usage counters. This lets host agents
 * flush skill updates safely without risk of duplication.
 *
 * No LLM ranking is performed here — this is a pure write surface. Recall
 * with optional filtering lives in oc_skill_recall (#785).
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { SkillMemoryStore } from '../core/skill-memory';

interface OcSkillRecordOutput {
  skill_id: string;
  stored_at: number;
  snapshot_path?: string;
}

const definition: MCPToolDefinition = {
  name: 'oc_skill_record',
  description:
    'Record a skill (domain, name, steps, contract_id) into the JSON skill ' +
    'memory store. Idempotent on (domain, name) — re-recording preserves the ' +
    'existing skill_id and usage counters while updating steps and contract_id. ' +
    'Pass `frozen_snapshot` to atomically write a gzipped snapshot alongside ' +
    'the record. Returns { skill_id, stored_at, snapshot_path? }. Core-tier; ' +
    'no LLM ranking. Use oc_skill_recall to retrieve skills.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description:
          'Domain this skill belongs to (e.g. "amazon.com"). Used as the ' +
          'storage partition key and must be a non-empty string ≤ 253 chars.',
      },
      name: {
        type: 'string',
        description:
          'Human-readable skill name, unique within the domain ' +
          '(e.g. "add-to-cart"). Acts as the idempotency key together with domain.',
      },
      steps: {
        type: 'array',
        description:
          'Opaque step list supplied by the host agent. The store persists ' +
          'this inline in the JSON file without schema validation. Each element ' +
          'may be any JSON-serialisable value.',
        items: {},
      },
      contract_id: {
        type: 'string',
        description:
          'Identifier of the Outcome Contract that governs this skill ' +
          '(ties into oc_assert #784 and the contracts registry).',
      },
      frozen_snapshot: {
        type: 'object',
        description:
          'Optional opaque snapshot payload to persist alongside the record. ' +
          'Written exactly once (write-once semantics) under ' +
          '<rootDir>/<domain>/snapshots/<skill_id>.json.gz. ' +
          'Omit on re-records when you do not want to update the snapshot.',
      },
    },
    required: ['domain', 'name', 'steps', 'contract_id'],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const domain = args.domain as string | undefined;
  const name = args.name as string | undefined;
  const steps = args.steps as unknown[] | undefined;
  const contractId = args.contract_id as string | undefined;
  const frozenSnapshot = args.frozen_snapshot as Record<string, unknown> | undefined;

  if (typeof domain !== 'string' || domain.length === 0) {
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      error: 'missing required field: domain (must be a non-empty string)',
    } as OcSkillRecordOutput & { error: string });
  }
  if (typeof name !== 'string' || name.length === 0) {
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      error: 'missing required field: name (must be a non-empty string)',
    } as OcSkillRecordOutput & { error: string });
  }
  if (!Array.isArray(steps)) {
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      error: 'missing required field: steps (must be an array)',
    } as OcSkillRecordOutput & { error: string });
  }
  if (typeof contractId !== 'string' || contractId.length === 0) {
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      error: 'missing required field: contract_id (must be a non-empty string)',
    } as OcSkillRecordOutput & { error: string });
  }

  let store: SkillMemoryStore;
  try {
    store = new SkillMemoryStore({ domain });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      error: `failed to initialise skill memory store: ${message}`,
    } as OcSkillRecordOutput & { error: string });
  }

  // Write the frozen snapshot before record() so that if the snapshot write
  // fails (e.g. write-once violation), we surface the error before mutating
  // skills.json. The skill_id is deterministically derived from (domain, name)
  // so we can compute it here without reading the store.
  let snapshotPath: string | undefined;
  if (frozenSnapshot !== undefined) {
    // Compute the skill_id the same way the store will — SHA-256 of
    // "<domain>\x00<name>", first 16 hex chars. We need it as the snapshot
    // basename before we call record().
    const skillId = computeSkillId(domain, name);
    try {
      const result = store.writeFrozenSnapshot(skillId, frozenSnapshot);
      snapshotPath = result.snapshot_path;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // write-once violation is surfaced as an error; the tool does not
      // silently continue because the caller likely expects a fresh snapshot.
      return jsonResult({
        skill_id: '',
        stored_at: 0,
        error: `failed to write frozen snapshot: ${message}`,
      } as OcSkillRecordOutput & { error: string });
    }
  }

  let recordResult: { skill_id: string; stored_at: number };
  try {
    recordResult = await store.record({
      domain,
      name,
      steps,
      contractId,
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: snapshotPath ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      error: `failed to record skill: ${message}`,
    } as OcSkillRecordOutput & { error: string });
  }

  const output: OcSkillRecordOutput = {
    skill_id: recordResult.skill_id,
    stored_at: recordResult.stored_at,
  };
  if (snapshotPath !== undefined) {
    output.snapshot_path = snapshotPath;
  }
  return jsonResult(output);
};

/**
 * Compute the deterministic skill_id for a (domain, name) pair.
 * Must match the private `computeSkillId` in store.ts exactly.
 */
function computeSkillId(domain: string, name: string): string {
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return crypto
    .createHash('sha256')
    .update(`${domain}\x00${name}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function jsonResult(payload: OcSkillRecordOutput | (OcSkillRecordOutput & { error: string })): MCPResult {
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

export function registerOcSkillRecordTool(server: MCPServer): void {
  server.registerTool('oc_skill_record', handler, definition);
}
