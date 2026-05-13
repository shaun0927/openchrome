/**
 * oc_skill_export — generate a self-contained replay script for a previously
 * recorded skill (issue #836).
 *
 * Looks up a skill by `skill_id` (and optional `domain`) in the JSON skill
 * memory store, then writes a standalone Puppeteer / Playwright / mcp-replay
 * file that reproduces the recorded steps. The output path is returned to
 * the caller along with the byte count of the written file.
 *
 * Skills recorded under `oc_skill_record` carry an opaque `steps` array. To
 * make export meaningful, each step is expected to be a `{ tool, args }`
 * object (the shape `oc_skill_record` already accepts). Steps that don't
 * match this shape are passed through to the mcp-replay format and emitted
 * as a comment in the puppeteer / playwright outputs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import {
  defaultSkillMemoryRootDir,
  SkillMemoryStore,
  type SkillRecord,
} from '../core/skill-memory';
import {
  defaultCodegenDir,
  formatMcpReplay,
  formatPlaywright,
  formatPuppeteer,
  PLAYWRIGHT_FILE_FOOTER,
  PLAYWRIGHT_FILE_HEADER,
  PUPPETEER_FILE_FOOTER,
  PUPPETEER_FILE_HEADER,
} from '../core/codegen';

interface OcSkillExportOutput {
  path: string;
  byte_count: number;
  error?: string;
}

const definition: MCPToolDefinition = {
  name: 'oc_skill_export',
  description:
    'Export a recorded skill as a self-contained replay script in the requested ' +
    'format. Writes the file to ~/.openchrome/codegen/<skill_id>.<ext> and ' +
    'returns its absolute path + byte count. Core-tier; no LLM. ' +
    'Format must be one of "puppeteer", "playwright", or "mcp-replay". ' +
    'Looks up the skill via the JSON skill memory store written by oc_skill_record.',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'REQUIRED The skill_id returned by oc_skill_record.',
      },
      format: {
        type: 'string',
        enum: ['puppeteer', 'playwright', 'mcp-replay'],
        description:
          'REQUIRED Output format. "puppeteer" / "playwright" produce a runnable TS file; ' +
          '"mcp-replay" produces a JSONL log of MCP tool-call envelopes.',
      },
      domain: {
        type: 'string',
        description:
          'Optional. Restrict the lookup to a single domain partition. When ' +
          'omitted, all per-domain partitions are scanned until a match is found.',
      },
    },
    required: ['skill_id', 'format'],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const skillId = args.skill_id as string | undefined;
  const format = args.format as string | undefined;
  const domain = args.domain as string | undefined;

  if (typeof skillId !== 'string' || skillId.length === 0) {
    return jsonResult({ path: '', byte_count: 0, error: 'missing required field: skill_id' });
  }
  if (format !== 'puppeteer' && format !== 'playwright' && format !== 'mcp-replay') {
    return jsonResult({
      path: '',
      byte_count: 0,
      error: `invalid format "${String(format)}" — must be one of puppeteer, playwright, mcp-replay`,
    });
  }

  let skill: SkillRecord | null = null;
  try {
    skill = lookupSkill(skillId, domain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ path: '', byte_count: 0, error: `skill lookup failed: ${message}` });
  }
  if (!skill) {
    return jsonResult({
      path: '',
      byte_count: 0,
      error: `skill_id "${skillId}" not found in skill memory store`,
    });
  }

  const outDir = defaultCodegenDir();
  fs.mkdirSync(outDir, { recursive: true });
  const ext = format === 'mcp-replay' ? 'jsonl' : 'ts';
  const outPath = path.join(outDir, `${skillId}.${ext}`);

  let body: string;
  try {
    body = renderBody(format, skill);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ path: '', byte_count: 0, error: `render failed: ${message}` });
  }

  fs.writeFileSync(outPath, body, 'utf8');
  const byteCount = Buffer.byteLength(body, 'utf8');
  return jsonResult({ path: outPath, byte_count: byteCount });
};

/**
 * Locate a skill across one or more domain partitions. When `domain` is
 * supplied, only that partition is consulted. Otherwise the rootDir is
 * scanned for sub-directories and the first match wins.
 */
function lookupSkill(skillId: string, domain: string | undefined): SkillRecord | null {
  if (domain) {
    const store = new SkillMemoryStore({ domain });
    return store.get(skillId);
  }
  const rootDir = defaultSkillMemoryRootDir();
  if (!fs.existsSync(rootDir)) return null;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // The domain dir basename is `encodeDomain(domain)`. We re-decode by
    // peeking at the skills.json file — each SkillRecord carries `domain`
    // verbatim, so we don't need to invert the encoding ourselves.
    const skillsFile = path.join(rootDir, entry.name, 'skills.json');
    if (!fs.existsSync(skillsFile)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(skillsFile, 'utf8');
    } catch {
      continue;
    }
    let parsed: { skills?: Record<string, SkillRecord> };
    try {
      parsed = JSON.parse(raw) as { skills?: Record<string, SkillRecord> };
    } catch {
      continue;
    }
    const hit = parsed?.skills?.[skillId];
    if (hit) return hit;
  }
  return null;
}

interface StepObject {
  tool: string;
  args: Record<string, unknown>;
}

function asStepObject(step: unknown): StepObject | null {
  if (!step || typeof step !== 'object') return null;
  const s = step as Record<string, unknown>;
  if (typeof s.tool !== 'string') return null;
  const args = s.args;
  if (args && typeof args !== 'object') return null;
  return {
    tool: s.tool,
    args: (args ?? {}) as Record<string, unknown>,
  };
}

function renderBody(
  format: 'puppeteer' | 'playwright' | 'mcp-replay',
  skill: SkillRecord,
): string {
  const steps = Array.isArray(skill.steps) ? skill.steps : [];

  if (format === 'mcp-replay') {
    return steps
      .map((step) => {
        const obj = asStepObject(step);
        if (!obj) {
          // Preserve the raw value for callers that stored non-{tool,args} steps.
          return JSON.stringify({ ts: Date.now(), tool: '<unknown>', args: step });
        }
        return formatMcpReplay(obj.tool, obj.args);
      })
      .join('\n') + (steps.length > 0 ? '\n' : '');
  }

  const lines: string[] = [];
  const header = format === 'puppeteer' ? PUPPETEER_FILE_HEADER : PLAYWRIGHT_FILE_HEADER;
  const footer = format === 'puppeteer' ? PUPPETEER_FILE_FOOTER : PLAYWRIGHT_FILE_FOOTER;
  const fmt = format === 'puppeteer' ? formatPuppeteer : formatPlaywright;

  lines.push(`// Skill: ${skill.name} (skill_id=${skill.skillId}, domain=${skill.domain})`);
  lines.push(`// Recorded contract: ${skill.contractId}`);
  lines.push(header);
  for (const step of steps) {
    const obj = asStepObject(step);
    if (!obj) {
      lines.push(`  // Unrecognised step shape: ${JSON.stringify(step).slice(0, 120)}`);
      continue;
    }
    const snippet = fmt(obj.tool, obj.args);
    if (snippet) {
      lines.push(snippet);
    } else {
      lines.push(`  // Tool "${obj.tool}" has no ${format} mapping — see mcp-replay export.`);
    }
  }
  lines.push(footer);
  return lines.join('\n');
}

function jsonResult(payload: OcSkillExportOutput): MCPResult {
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

export function registerOcSkillExportTool(server: MCPServer): void {
  server.registerTool('oc_skill_export', handler, definition);
}

// Re-export for tests so they can drive the renderer without a server.
export { renderBody as _renderBodyForTests, lookupSkill as _lookupSkillForTests };
// Touch os to keep import-elimination off if anyone removes path users later.
void os.homedir;
