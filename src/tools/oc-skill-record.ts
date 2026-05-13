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
import {
  SkillMemoryStore,
  flushRecorderBuffer,
  peekRecorderBuffer,
  validateReplayArtifact,
  type ReplayArtifact,
  REPLAY_ARTIFACT_SCHEMA_VERSION,
  type ReplayArtifactStep,
} from '../core/skill-memory';
import { isCoreFeatureEnabled } from '../harness/flags';
import { redactSecrets } from '../core/secrets';
import { isDynamicSkillsEnabled } from '../harness/flags';

interface OcSkillRecordOutput {
  skill_id: string;
  stored_at: number;
  snapshot_path?: string;
  /**
   * Per-step replay artifacts persisted with this record. Indexed parallel to
   * `steps`. `null` entries indicate no artifact was attached for that step
   * (legacy v1 records or steps recorded without `capture_artifact`). Always
   * surfaced (even as all-null) when the v2 schema is in use, so callers see a
   * deterministic shape. When the feature gate is off this is `null`.
   */
  replay_artifacts: Array<ReplayArtifact | null> | null;
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
      replay_artifacts: {
        type: 'array',
        description:
          'Optional per-step replay artifacts (#875), parallel-indexed with steps. ' +
          'Null entries are allowed; omitted values backfill from target_id recorder buffer.',
        items: {},
      },
      target_id: {
        type: 'string',
        description:
          'Optional CDP target id used to drain the in-process recorder buffer ' +
          '(#875). When provided and `replay_artifacts` is omitted, every step ' +
          'captured via `capture_artifact: true` since the last record() is ' +
          'flushed into this skill.',
      },
    },
    required: ['domain', 'name', 'steps', 'contract_id'],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const domainArg = args.domain as string | undefined;
  const domain = typeof domainArg === 'string' ? domainArg.trim().toLowerCase() : undefined;
  const name = args.name as string | undefined;
  const rawSteps = args.steps as unknown[] | undefined;
  const contractId = args.contract_id as string | undefined;
  const rawFrozenSnapshot = args.frozen_snapshot as Record<string, unknown> | undefined;
  const explicitArtifacts = args.replay_artifacts as Array<ReplayArtifact | null> | undefined;
  const targetId = typeof args.target_id === 'string' ? (args.target_id as string) : undefined;
  // Whether the replay feature gate is on. P2 schema parity: the field is
  // always present in tools/list, but persisted artifacts are null when off.
  const replayEnabled = isCoreFeatureEnabled('OPENCHROME_SKILL_REPLAY', true);

  // Secrets redaction (#834): step payloads and frozen snapshots are
  // persisted to disk where they may be promoted across sessions by the
  // skill curator. Strip literal secret values BEFORE write so a recorded
  // step contains `${SECRET:NAME}` placeholders only.
  const steps = rawSteps !== undefined ? redactSecrets(rawSteps) : undefined;
  const frozenSnapshot =
    rawFrozenSnapshot !== undefined ? redactSecrets(rawFrozenSnapshot) : undefined;

  if (typeof domain !== 'string' || domain.length === 0) {
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      replay_artifacts: null,
      error: 'missing required field: domain (must be a non-empty string)',
    } as OcSkillRecordOutput & { error: string });
  }
  if (typeof name !== 'string' || name.length === 0) {
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      replay_artifacts: null,
      error: 'missing required field: name (must be a non-empty string)',
    } as OcSkillRecordOutput & { error: string });
  }
  if (!Array.isArray(steps)) {
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      replay_artifacts: null,
      error: 'missing required field: steps (must be an array)',
    } as OcSkillRecordOutput & { error: string });
  }
  if (typeof contractId !== 'string' || contractId.length === 0) {
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      replay_artifacts: null,
      error: 'missing required field: contract_id (must be a non-empty string)',
    } as OcSkillRecordOutput & { error: string });
  }

  // Build per-step replay artifacts. Three sources, in priority order:
  //   1) explicit `replay_artifacts` arg from the caller,
  //   2) recorder-buffer flush keyed by `target_id`,
  //   3) array of nulls sized to `steps.length`.
  // When the feature gate is off, we still accept input but force the
  // persisted array to nulls so downstream tools see DISABLED behaviour.
  let replayArtifacts: Array<ReplayArtifact | null> = new Array(steps.length).fill(null);
  if (replayEnabled) {
    if (Array.isArray(explicitArtifacts)) {
      // Pad / truncate to match steps.length, then validate each non-null
      // entry. Validation failure aborts the record so the caller learns
      // immediately rather than discovering corruption at replay time.
      const padded: Array<ReplayArtifact | null> = new Array(steps.length).fill(null);
      for (let i = 0; i < Math.min(explicitArtifacts.length, steps.length); i++) {
        padded[i] = explicitArtifacts[i] ?? null;
      }
      for (let i = 0; i < padded.length; i++) {
        const a = padded[i];
        if (a === null) continue;
        const v = validateReplayArtifact(a);
        if (!v.ok) {
          return jsonResult({
            skill_id: '',
            stored_at: 0,
            replay_artifacts: null,
            error: `replay_artifacts[${i}] invalid: ${v.error ?? 'unknown'}`,
          } as OcSkillRecordOutput & { error: string });
        }
      }
      replayArtifacts = padded;
    } else if (targetId) {
      const flushed = peekRecorderBuffer(targetId);
      // Wrap each captured ReplayArtifactStep in a single-step ReplayArtifact
      // so the on-disk shape is uniform. Pad to `steps.length`.
      const wrapped = flushed.map((step: ReplayArtifactStep) =>
        wrapStepAsArtifact(step),
      );
      const padded: Array<ReplayArtifact | null> = new Array(steps.length).fill(null);
      for (let i = 0; i < Math.min(wrapped.length, steps.length); i++) {
        padded[i] = wrapped[i];
      }
      replayArtifacts = padded;
    }
  }

  let store: SkillMemoryStore;
  try {
    store = new SkillMemoryStore({ domain });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      replay_artifacts: null,
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
        replay_artifacts: null,
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
      replayArtifacts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({
      skill_id: '',
      stored_at: 0,
      replay_artifacts: null,
      error: `failed to record skill: ${message}`,
    } as OcSkillRecordOutput & { error: string });
  }

  if (replayEnabled && targetId) {
    flushRecorderBuffer(targetId);
  }

  const output: OcSkillRecordOutput = {
    skill_id: recordResult.skill_id,
    stored_at: recordResult.stored_at,
    replay_artifacts: replayEnabled ? replayArtifacts : null,
  };
  if (snapshotPath !== undefined) {
    output.snapshot_path = snapshotPath;
  }

  // Emit `skill_recorded` on the dynamic-skills event bus when the
  // pilot family is active. The synthesizer picks this up to register
  // a fresh synthesized tool so subsequent calls in the same session
  // can use it. Best-effort — the record() result is already settled
  // and must not be impacted by a hook failure.
  if (isDynamicSkillsEnabled()) {
    try {
      const events = await import('../pilot/dynamic-skills/events.js');
      events.dynamicSkillEvents.emit('skill_recorded', {
        domain,
        skillId: recordResult.skill_id,
      });
    } catch (err) {
      console.error(
        `[oc_skill_record] dynamic-skills event emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return jsonResult(output);
};

/**
 * Lift a per-step ReplayArtifactStep into a single-step ReplayArtifact so the
 * on-disk shape stays uniform regardless of capture path.
 */
function wrapStepAsArtifact(step: ReplayArtifactStep): ReplayArtifact {
  return {
    schema_version: REPLAY_ARTIFACT_SCHEMA_VERSION,
    recorded_at: Date.now(),
    recorder: { openchrome_version: 'core' },
    steps: [step],
  };
}

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
