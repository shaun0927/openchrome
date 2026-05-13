/** Pilot-only bounded contract-backed recovery runtime (#1061). */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';

const SAFE_RECIPES = ['refresh_dom_state', 'wait_for_page_ready', 'restore_checkpoint'] as const;
const FUTURE_RECIPES = ['reacquire_ref', 'switch_to_programmatic_click'] as const;
type SafeRecipeId = typeof SAFE_RECIPES[number];
type RecoveryRecipeId = SafeRecipeId | typeof FUTURE_RECIPES[number];

const UNSAFE_TOOLS = new Set(['cookies', 'storage', 'http_auth', 'file_upload', 'tabs_close', 'oc_stop', 'oc_pilot_run_with_recovery']);
const MAX_ATTEMPTS = 3;

const definition: MCPToolDefinition = {
  name: 'oc_pilot_run_with_recovery',
  description: 'Pilot-only bounded deterministic recovery wrapper for one tool call under declared safe recipes. Requires --pilot and OPENCHROME_CONTRACT_RUNTIME=1.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Optional tab id passed to recovery recipes.' },
      action: {
        type: 'object',
        description: 'REQUIRED Single original tool call to execute or classify.',
        properties: {
          tool: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true },
        },
        required: ['tool', 'arguments'],
      },
      postcondition: { type: 'object', description: 'Optional Outcome Contract assertion metadata.', additionalProperties: true },
      maxRecoveryAttempts: { type: 'number', description: 'Default 1, maximum 3.' },
      checkpointBefore: { type: 'boolean', description: 'Default true. Records a redacted checkpoint reference in the response.' },
      allowedRecipes: { type: 'array', items: { type: 'string', enum: [...SAFE_RECIPES, ...FUTURE_RECIPES] } },
      dryRun: { type: 'boolean', description: 'Classify and propose recipes without executing the original action.' },
    },
    required: ['action'],
  },
  annotations: TOOL_ANNOTATIONS.oc_pilot_run_with_recovery,
};

interface RecoveryActionResult {
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

function textOf(result: MCPResult): string {
  return result.content?.map((item) => item.text || '').join('\n') || '';
}

function redactString(value: string): string {
  return value
    .replace(/(password|passcode|token|secret|credential|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 1000);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[key] = /password|passcode|token|secret|credential|api[_-]?key|authorization|cookie/i.test(key)
      ? '[REDACTED]'
      : redactValue(child, depth + 1);
  }
  return out;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactValue(args) as Record<string, unknown>;
}

function classifyFailure(tool: string, text: string): { reason: string; recipes: RecoveryRecipeId[] } | null {
  const haystack = `${tool} ${text}`.toLowerCase();
  if (/stale[_ -]?ref|node.*evicted|element.*not found|no elements found/.test(haystack)) {
    return { reason: 'stale_or_missing_element', recipes: ['refresh_dom_state'] };
  }
  if (/timeout|deadline|not ready|loading|detached/.test(haystack)) {
    return { reason: 'page_not_ready', recipes: ['wait_for_page_ready', 'refresh_dom_state'] };
  }
  if (/checkpoint|navigation|context lost/.test(haystack)) {
    return { reason: 'checkpoint_metadata_available', recipes: ['restore_checkpoint'] };
  }
  return null;
}

function parseAttempts(raw: unknown): number | string {
  const attempts = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(attempts) || attempts < 0) return 'maxRecoveryAttempts must be a non-negative integer';
  if (attempts > MAX_ATTEMPTS) return `maxRecoveryAttempts must be <= ${MAX_ATTEMPTS}`;
  return attempts;
}

function allowedRecipeSet(raw: unknown): Set<RecoveryRecipeId> {
  if (!Array.isArray(raw) || raw.length === 0) return new Set(SAFE_RECIPES);
  return new Set(raw as RecoveryRecipeId[]);
}

async function callTool(server: MCPServer, sessionId: string, tool: string, args: Record<string, unknown>): Promise<RecoveryActionResult> {
  const handler = server.getToolHandler(tool);
  if (!handler) return { tool, arguments: redactArgs(args), ok: false, error: `unknown tool: ${tool}` };
  try {
    const result = await handler(sessionId, args);
    return { tool, arguments: redactArgs(args), ok: !result.isError, ...(result.isError ? { error: redactString(textOf(result) || 'tool returned error') } : {}) };
  } catch (error) {
    return { tool, arguments: redactArgs(args), ok: false, error: redactString(error instanceof Error ? error.message : String(error)) };
  }
}

async function runRecipe(server: MCPServer, sessionId: string, recipe: RecoveryRecipeId, tabId: string | undefined): Promise<RecoveryActionResult[]> {
  if (recipe === 'refresh_dom_state') {
    return [await callTool(server, sessionId, 'read_page', { ...(tabId ? { tabId } : {}), mode: 'dom', limit: 2000 })];
  }
  if (recipe === 'wait_for_page_ready') {
    return [await callTool(server, sessionId, 'wait_for', { ...(tabId ? { tabId } : {}), state: 'load', timeout: 5000 })];
  }
  if (recipe === 'restore_checkpoint') {
    return [{ tool: 'restore_checkpoint', arguments: { metadataOnly: true, ...(tabId ? { tabId } : {}) }, ok: true }];
  }
  return [{ tool: recipe, arguments: {}, ok: false, error: `recipe ${recipe} is declared but not implemented yet` }];
}

export function registerOcPilotRunWithRecoveryTool(server: MCPServer): void {
  const handler: ToolHandler = async (sessionId, args): Promise<MCPResult> => {
    const start = Date.now();
    const action = args.action as { tool?: string; arguments?: Record<string, unknown> } | undefined;
    const tabId = args.tabId as string | undefined;
    if (!action?.tool || typeof action.arguments !== 'object' || action.arguments === null) {
      return { content: [{ type: 'text', text: 'INVALID_INPUT: action.tool and action.arguments are required' }], isError: true };
    }
    if (UNSAFE_TOOLS.has(action.tool)) {
      return { content: [{ type: 'text', text: `UNSAFE_ACTION: ${action.tool} is excluded from pilot recovery runtime` }], isError: true };
    }
    const attempts = parseAttempts(args.maxRecoveryAttempts);
    if (typeof attempts === 'string') {
      return { content: [{ type: 'text', text: `INVALID_INPUT: ${attempts}` }], isError: true };
    }

    const checkpointId = args.checkpointBefore === false ? undefined : `pilot-checkpoint-${Date.now()}`;
    const allowed = allowedRecipeSet(args.allowedRecipes);
    const recovery: Array<{ attempt: number; recipe: RecoveryRecipeId; reason: string; actions: RecoveryActionResult[]; postcondition?: { evaluated: boolean; passed: boolean } }> = [];

    if (args.dryRun === true) {
      const proposal = [...allowed].filter((recipe): recipe is SafeRecipeId => SAFE_RECIPES.includes(recipe as SafeRecipeId));
      const body = {
        status: 'dry_run',
        original: { ok: false, tool: action.tool },
        postcondition: args.postcondition ? { evaluated: false, passed: false } : undefined,
        recovery: proposal.slice(0, attempts).map((recipe, index) => ({ attempt: index + 1, recipe, reason: 'dry_run_proposal', actions: [] })),
        checkpointId,
        durationMs: Date.now() - start,
      };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    }

    const original = await callTool(server, sessionId, action.tool, action.arguments);
    if (original.ok) {
      const body = { status: 'passed', original, postcondition: args.postcondition ? { evaluated: false, passed: false } : undefined, recovery, checkpointId, durationMs: Date.now() - start };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    }

    const classified = classifyFailure(action.tool, original.error || '');
    if (classified && attempts > 0) {
      for (const recipe of classified.recipes) {
        if (recovery.length >= attempts) break;
        if (!allowed.has(recipe)) continue;
        const actions = await runRecipe(server, sessionId, recipe, tabId);
        recovery.push({ attempt: recovery.length + 1, recipe, reason: classified.reason, actions, postcondition: { evaluated: false, passed: false } });
      }
    }

    const status = recovery.some((entry) => entry.actions.some((actionResult) => actionResult.ok)) ? 'recovered' : 'failed';
    const body = { status, original, postcondition: args.postcondition ? { evaluated: false, passed: false } : undefined, recovery, checkpointId, durationMs: Date.now() - start };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: status === 'failed' };
  };

  server.registerTool('oc_pilot_run_with_recovery', handler, definition);
}
