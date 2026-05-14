/**
 * Skill → MCP tool definition synthesis (issue #889).
 *
 * Deterministic transformation: given a `SkillRecord`, emit the
 * `MCPToolDefinition` that, when registered with the MCP server, gives
 * the host LLM a single-purpose typed entry point for replay.
 *
 * The synthesizer is **pure** — it does no I/O, makes no network calls,
 * and depends only on the recorded skill payload. That keeps it
 * compliant with portability-harness P4 (facts not decisions): the
 * synthesizer transforms recorded facts into a tool schema, it does
 * not "decide" anything.
 *
 * Step / parameter inference
 * --------------------------
 *
 * The skill's `steps` field is opaque to the core skill memory store. The
 * synthesizer interprets it under the following convention (the same
 * convention the fixture skill JSON uses):
 *
 *   {
 *     "parameters": [
 *       { "name": "username", "type": "string", "description": "...", "required": true },
 *       ...
 *     ],
 *     "actions": [
 *       { "kind": "navigate", "url": "https://..." },
 *       { "kind": "fill",     "selector": "...", "valueParam": "username" },
 *       { "kind": "click",    "selector": "..." },
 *       ...
 *     ]
 *   }
 *
 * Missing or malformed `parameters` yields a tool with an empty input
 * schema. Skill steps whose shape we don't recognise are left to the
 * replay engine — the synthesizer does NOT reject them at this layer.
 */

import type { SkillRecord } from '../../core/skill-memory';
import type { MCPToolDefinition } from '../../types/mcp';

import { synthesizedToolName } from './name.js';

export interface SkillParameter {
  readonly name: string;
  readonly type?: 'string' | 'number' | 'boolean';
  readonly description?: string;
  readonly required?: boolean;
}

/**
 * Shape the synthesizer expects under `SkillRecord.steps`. Anything not
 * matching this shape simply produces a tool with no inputs — replay
 * handles the actual step interpretation.
 */
export interface InterpretedSkillSteps {
  readonly parameters?: ReadonlyArray<SkillParameter>;
  readonly actions?: ReadonlyArray<Record<string, unknown>>;
}

export interface SynthesizeResult {
  readonly name: string;
  readonly definition: MCPToolDefinition;
}

/** Maximum description length for the synthesized tool. Trimmed if exceeded. */
const MAX_DESCRIPTION_LEN = 1024;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/** Best-effort coercion of a parameter entry into a typed schema property. */
function paramToSchemaEntry(p: SkillParameter): { schema: Record<string, unknown>; required: boolean } {
  const type = p.type === 'number' || p.type === 'boolean' ? p.type : 'string';
  const schema: Record<string, unknown> = { type };
  if (typeof p.description === 'string' && p.description.length > 0) {
    schema.description = truncate(p.description, 512);
  }
  return { schema, required: p.required === true };
}

/**
 * Pull the conventional `parameters` array out of a skill's `steps` blob.
 * Returns an empty array when the shape isn't recognised — never throws.
 */
export function extractSkillParameters(steps: unknown): SkillParameter[] {
  if (Array.isArray(steps)) {
    const seen = new Set<string>();
    const out: SkillParameter[] = [];
    for (const entry of steps) {
      if (!entry || typeof entry !== 'object') continue;
      const raw = entry as Record<string, unknown>;
      if (raw.kind !== 'fill') continue;
      const name = raw.valueParam;
      if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        type: 'string',
        description: `Value for recorded fill step "${name}".`,
        required: true,
      });
    }
    return out;
  }
  if (!steps || typeof steps !== 'object') return [];
  const raw = (steps as InterpretedSkillSteps).parameters;
  if (!Array.isArray(raw)) return [];
  const out: SkillParameter[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as SkillParameter;
    if (typeof e.name !== 'string' || e.name.length === 0) continue;
    out.push({
      name: e.name,
      type: e.type === 'number' || e.type === 'boolean' ? e.type : 'string',
      description: typeof e.description === 'string' ? e.description : undefined,
      required: e.required === true,
    });
  }
  return out;
}

/**
 * Build an MCP tool definition for the supplied skill record. Returns
 * the synthesized tool name and the schema in a single object so
 * callers don't have to re-derive the name themselves.
 */
export function synthesizeToolDefinition(
  skill: SkillRecord,
  opts?: { descriptionOverride?: string },
): SynthesizeResult {
  if (!skill || typeof skill !== 'object') {
    throw new Error('synthesizeToolDefinition: skill is required');
  }
  if (typeof skill.domain !== 'string' || skill.domain.length === 0) {
    throw new Error('synthesizeToolDefinition: skill.domain is required');
  }
  if (typeof skill.name !== 'string' || skill.name.length === 0) {
    throw new Error('synthesizeToolDefinition: skill.name is required');
  }
  if (typeof skill.contractId !== 'string' || skill.contractId.length === 0) {
    throw new Error('synthesizeToolDefinition: skill.contractId is required');
  }

  const toolName = synthesizedToolName(skill.domain, skill.name);

  const params = extractSkillParameters(skill.steps);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    const { schema, required: isReq } = paramToSchemaEntry(p);
    properties[p.name] = schema;
    if (isReq) required.push(p.name);
  }

  // Caller-supplied human description first, otherwise derive from skill.
  const humanDesc =
    opts?.descriptionOverride && opts.descriptionOverride.length > 0
      ? opts.descriptionOverride
      : `Replay recorded skill "${skill.name}".`;
  const description = truncate(
    `REPLAY: ${humanDesc} Domain: ${skill.domain}. Contract: ${skill.contractId}.`,
    MAX_DESCRIPTION_LEN,
  );

  const definition: MCPToolDefinition = {
    name: toolName,
    description,
    // Synthesized skill-replay tools execute a recorded action sequence that
    // may navigate to arbitrary origins, click, fill, and submit forms. The
    // worst-case envelope therefore matches `oc_skill_replay` itself — open
    // world (network egress via page.goto) and potentially destructive
    // (form submits, irreversible clicks).
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema:
      required.length > 0
        ? { type: 'object', properties, required }
        : { type: 'object', properties },
  };

  return { name: toolName, definition };
}
