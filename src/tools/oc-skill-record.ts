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
 *
 * Codegen artifact pointers (#1430): when `OPENCHROME_CODEGEN` is set to a
 * non-off value, existing codegen output files for the current session are
 * detected and their paths (relative to the skill store rootDir) are persisted
 * in `codegen_artifacts` on the stored record. When codegen is off (the
 * default), `codegen_artifacts` is written as `[]` so existing records always
 * have the field present after a re-record.
 */

import * as path from 'node:path';

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import {
  defaultSkillMemoryRootDir,
  flushRecorderBuffer,
  REPLAY_ARTIFACT_SCHEMA_VERSION,
  SkillMemoryStore,
  type CodegenArtifactPointer,
  type ReplayArtifact,
  type ReplayArtifactStep,
} from '../core/skill-memory';
import {
  codegenPath,
  getCodegenMode,
  isCodegenEnabled,
  type CodegenMode,
} from '../core/codegen';
import { redactSecrets } from '../core/secrets';
import { isDynamicSkillsEnabled, isSkillReplayEnabled } from '../harness/flags';
import { getSessionManager } from '../session-manager';
import { getVersion } from '../version';

interface OcSkillRecordOutput {
  skill_id: string;
  stored_at: number;
  snapshot_path?: string;
  replay_artifacts?: ReplayArtifact[] | null;
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
          'Optional replay artifacts (selector-chain step recordings) to persist ' +
          'alongside the skill. Each artifact must conform to the ReplayArtifact schema. ' +
          'Ignored when OPENCHROME_SKILL_REPLAY is not enabled.',
        items: {},
      },
    },
    required: ['domain', 'name', 'steps', 'contract_id'],
  },
  annotations: TOOL_ANNOTATIONS.oc_skill_record,
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const domainArg = args.domain as string | undefined;
  const domain = typeof domainArg === 'string' ? domainArg.trim().toLowerCase() : undefined;
  const name = args.name as string | undefined;
  const rawSteps = args.steps as unknown[] | undefined;
  const contractId = args.contract_id as string | undefined;
  const rawFrozenSnapshot = args.frozen_snapshot as Record<string, unknown> | undefined;
  const rawReplayArtifacts = args.replay_artifacts as unknown[] | undefined;

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

  // replay_artifacts: enabled when OPENCHROME_SKILL_REPLAY is absent OR truthy.
  // Only disabled when explicitly set to a falsy value (0, false, no, off).
  // This matches the test contract where absent env = feature available (#875).
  const replayEnv = process.env.OPENCHROME_SKILL_REPLAY;
  const replayArtifactsEnabled = replayEnv === undefined || isSkillReplayEnabled();
  const bufferedReplaySteps = flushBufferedReplaySteps(sessionId);
  const capturedReplayArtifact = bufferedReplaySteps.length > 0
    ? buildReplayArtifact(bufferedReplaySteps)
    : undefined;
  const replayArtifacts = replayArtifactsEnabled
    ? [
      ...(Array.isArray(rawReplayArtifacts) ? (rawReplayArtifacts as ReplayArtifact[]) : []),
      ...(capturedReplayArtifact ? [capturedReplayArtifact] : []),
    ]
    : undefined;
  const replayArtifactsForStore = replayArtifacts && replayArtifacts.length > 0 ? replayArtifacts : undefined;

  // codegen_artifacts (#1430): collect pointers to any codegen output files
  // written for this session by the opt-in `--codegen` / OPENCHROME_CODEGEN
  // pipeline. Paths are stored relative to the skill store rootDir for
  // portability across machines (per SSOT #1359 "portable local artifacts").
  // When codegen is off (the default), we write an empty array so the field
  // is always present in v3 records after a record/re-record.
  const codegenArtifacts: CodegenArtifactPointer[] = [];
  if (isCodegenEnabled()) {
    const storeRoot = defaultSkillMemoryRootDir();
    const codegenMode = getCodegenMode();
    const formats: Array<Exclude<CodegenMode, 'off'>> = ['mcp-replay'];
    if (codegenMode === 'puppeteer') formats.push('puppeteer');
    if (codegenMode === 'playwright') formats.push('playwright');
    const { statSync, existsSync } = await import('node:fs');
    for (const fmt of formats) {
      const artifactPath = codegenPath(sessionId, fmt);
      if (existsSync(artifactPath)) {
        let created_at: number;
        try {
          created_at = statSync(artifactPath).birthtimeMs || statSync(artifactPath).mtimeMs;
        } catch {
          created_at = Date.now();
        }
        codegenArtifacts.push({
          kind: fmt,
          path: path.relative(storeRoot, artifactPath),
          created_at,
        });
      }
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
      ...(replayArtifactsForStore !== undefined ? { replayArtifacts: replayArtifactsForStore } : {}),
      codegenArtifacts,
      // #1457 PR-4: a direct oc_skill_record call is a host write. The core
      // store does not verify (P4/P7), so this is labelled `verified: false`;
      // recall surfaces it so a host can tell unverified direct writes apart
      // from Verified-Skill-Loop records promoted by the pilot curator.
      provenance: {
        source: 'host',
        recordedAt: Date.now(),
        ...(contractId ? { contractRef: contractId } : {}),
        verified: false,
      },
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
    // Return replay_artifacts in response: the stored array when feature-on
    // (env absent or truthy), null when explicitly disabled (#875 contract).
    replay_artifacts: replayArtifactsEnabled ? (replayArtifactsForStore ?? null) : null,
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


function flushBufferedReplaySteps(sessionId: string): ReplayArtifactStep[] {
  try {
    const sessionManager = getSessionManager() as { getSessionTargetIds?: (sessionId: string) => string[] };
    const targetIds = sessionManager.getSessionTargetIds?.(sessionId) ?? [];
    const steps: ReplayArtifactStep[] = [];
    for (const targetId of targetIds) {
      steps.push(...flushRecorderBuffer(targetId));
    }
    return steps;
  } catch {
    return [];
  }
}

function buildReplayArtifact(steps: ReplayArtifactStep[]): ReplayArtifact {
  return {
    schema_version: REPLAY_ARTIFACT_SCHEMA_VERSION,
    recorded_at: Date.now(),
    recorder: { openchrome_version: getVersion() },
    steps,
  };
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
