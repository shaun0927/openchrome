/**
 * oc_normalize_action — side-effect-free action schema normalizer (#1062).
 *
 * This tool deliberately does not touch Chrome/CDP or execute any action. It
 * only returns a deterministic normalized candidate plus diagnostics so host
 * agents can repair near-valid action payloads before calling real tools.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';

export interface NormalizeDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface NormalizeActionOutput {
  ok: boolean;
  changed: boolean;
  normalized?: Record<string, unknown>;
  warnings: NormalizeDiagnostic[];
  errors: NormalizeDiagnostic[];
  safety: {
    executableByOpenChrome: boolean;
    requiresUserConfirmation: boolean;
    reason?: string;
  };
}

const STRUCTURAL_STRING_KEYS = new Set(['type', 'button']);
const PAYLOAD_STRING_KEYS = new Set(['text', 'value', 'label', 'description', 'target', 'name', 'placeholder']);
const CONFIRMATION_KEYWORDS = [
  'submit',
  'purchase',
  'buy',
  'checkout',
  'pay',
  'delete',
  'remove',
  'upload',
  'login',
  'sign in',
  'authenticate',
  'transfer',
  'send',
];

const CLICK_ALIASES: Record<string, string> = {
  left_click: 'left',
  right_click: 'right',
};

const KEYPRESS_ALIASES = new Set(['hotkey', 'key', 'press', 'key_press']);

const REQUIRED_BY_TYPE: Record<string, string[]> = {
  click: ['type', 'button', 'x', 'y'],
  double_click: ['type', 'x', 'y'],
  keypress: ['type', 'keys'],
  scroll: ['type', 'scroll_x', 'scroll_y'],
  type: ['type', 'text'],
  wait: ['type'],
};

const ALLOWED_BY_TYPE: Record<string, Set<string>> = {
  click: new Set(['type', 'button', 'x', 'y']),
  double_click: new Set(['type', 'x', 'y']),
  keypress: new Set(['type', 'keys']),
  scroll: new Set(['type', 'scroll_x', 'scroll_y', 'x', 'y']),
  type: new Set(['type', 'text']),
  wait: new Set(['type']),
};

function diagnostic(code: string, message: string, path?: string): NormalizeDiagnostic {
  return path ? { code, message, path } : { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKeyName(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 1) return trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  const common: Record<string, string> = {
    ctrl: 'Ctrl',
    control: 'Ctrl',
    cmd: 'Cmd',
    command: 'Cmd',
    meta: 'Meta',
    shift: 'Shift',
    alt: 'Alt',
    option: 'Alt',
    enter: 'Enter',
    return: 'Enter',
    esc: 'Escape',
    escape: 'Escape',
    tab: 'Tab',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
  };
  return common[lower] ?? trimmed;
}

export function splitKeyChord(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  return value
    .split(/[+-]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeKeyName);
}

function redactPayloadStrings(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && !STRUCTURAL_STRING_KEYS.has(key)) {
      out[key] = '[REDACTED]';
    } else if (Array.isArray(value) && PAYLOAD_STRING_KEYS.has(key)) {
      out[key] = value.map((v) => (typeof v === 'string' ? '[REDACTED]' : v));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function changedFrom(input: Record<string, unknown>, normalized: Record<string, unknown>): boolean {
  return JSON.stringify(input) !== JSON.stringify(normalized);
}

function scanSafety(input: Record<string, unknown>, normalized: Record<string, unknown>): { requires: boolean; reason?: string } {
  const haystack: string[] = [];
  const collect = (obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && !STRUCTURAL_STRING_KEYS.has(key)) {
        haystack.push(value.toLowerCase());
      }
    }
  };
  collect(input);
  collect(normalized);
  const joined = haystack.join(' ');
  const matched = CONFIRMATION_KEYWORDS.find((kw) => joined.includes(kw));
  return matched
    ? { requires: true, reason: `Action text matches confirmation keyword '${matched}'.` }
    : { requires: false };
}

export function normalizeActionPayload(params: {
  action: unknown;
  targetTool?: unknown;
  strict?: unknown;
  redactNormalized?: unknown;
}): NormalizeActionOutput {
  const warnings: NormalizeDiagnostic[] = [];
  const errors: NormalizeDiagnostic[] = [];
  const strict = params.strict !== false;
  const redactNormalized = params.redactNormalized === true;

  if (!isRecord(params.action)) {
    return {
      ok: false,
      changed: false,
      warnings,
      errors: [diagnostic('invalid_action', 'action must be an object', 'action')],
      safety: { executableByOpenChrome: false, requiresUserConfirmation: false },
    };
  }

  const input = { ...params.action };
  const normalized: Record<string, unknown> = { ...input };

  const originalType = typeof normalized.type === 'string' ? normalized.type : undefined;

  if (originalType && CLICK_ALIASES[originalType]) {
    normalized.type = 'click';
    normalized.button = CLICK_ALIASES[originalType];
    warnings.push(diagnostic('renamed_click_action', `${originalType} normalized to click`, 'action.type'));
  }

  if (KEYPRESS_ALIASES.has(String(normalized.type))) {
    normalized.type = 'keypress';
    const source = normalized.keys ?? normalized.key ?? normalized.press ?? normalized.keypress ?? normalized.text;
    const keys = splitKeyChord(source);
    if (keys) {
      normalized.keys = keys;
      for (const alias of ['key', 'press', 'keypress', 'text']) delete normalized[alias];
    }
    warnings.push(diagnostic('renamed_keypress_action', `${originalType ?? 'keypress alias'} normalized to keypress`, 'action.type'));
  }

  if (!normalized.type) {
    if (typeof normalized.button === 'string' && typeof normalized.x === 'number' && typeof normalized.y === 'number') {
      normalized.type = 'click';
      warnings.push(diagnostic('inferred_click_action', 'Inferred click action from button/x/y.', 'action.type'));
    } else if (typeof normalized.text === 'string') {
      normalized.type = 'type';
      warnings.push(diagnostic('inferred_type_action', 'Inferred type action from text.', 'action.type'));
    } else if ('scroll_x' in normalized || 'scroll_y' in normalized) {
      normalized.type = 'scroll';
      warnings.push(diagnostic('inferred_scroll_action', 'Inferred scroll action from scroll_x/scroll_y.', 'action.type'));
    }
  }

  if (Array.isArray(normalized.coordinate)) {
    const [x, y] = normalized.coordinate;
    if (typeof x === 'number' && typeof y === 'number') {
      normalized.x = x;
      normalized.y = y;
      delete normalized.coordinate;
      warnings.push(diagnostic('renamed_coordinate', 'coordinate tuple normalized to x/y.', 'action.coordinate'));
    } else {
      errors.push(diagnostic('invalid_coordinate', 'coordinate must be [number, number].', 'action.coordinate'));
    }
  }

  if (normalized.type === 'click' && !normalized.button) {
    normalized.button = 'left';
    warnings.push(diagnostic('defaulted_click_button', 'Defaulted click button to left.', 'action.button'));
  }

  if (normalized.type === 'scroll') {
    if (normalized.scroll_x === undefined) normalized.scroll_x = 0;
    if (normalized.scroll_y === undefined) normalized.scroll_y = 0;
  }

  if (normalized.type === 'keypress') {
    const keys = splitKeyChord(normalized.keys);
    if (keys) normalized.keys = keys;
  }

  const type = typeof normalized.type === 'string' ? normalized.type : undefined;
  if (!type) {
    errors.push(diagnostic('missing_type', 'Could not infer action type.', 'action.type'));
  } else if (!REQUIRED_BY_TYPE[type]) {
    errors.push(diagnostic('unsupported_type', `Unsupported action type '${type}'.`, 'action.type'));
  } else {
    for (const req of REQUIRED_BY_TYPE[type]) {
      if (normalized[req] === undefined) {
        const d = diagnostic('missing_required_field', `Missing required field '${req}' for ${type}.`, `action.${req}`);
        if (strict) errors.push(d); else warnings.push(d);
      }
    }
    const allowed = ALLOWED_BY_TYPE[type];
    for (const key of Object.keys(normalized)) {
      if (!allowed.has(key)) {
        warnings.push(diagnostic('dropped_unknown_field', `Dropped unsupported field '${key}' for ${type}.`, `action.${key}`));
        delete normalized[key];
      }
    }
  }

  if (strict) {
    // In strict mode, unknown fields were dropped with warnings; invalid/missing
    // required fields are already errors. No additional action required.
  }

  const hasMissingRequired = warnings.some((w) => w.code === 'missing_required_field');
  const safetyScan = scanSafety(input, normalized);
  const executableByOpenChrome = errors.length === 0 && !hasMissingRequired && !safetyScan.requires;
  const normalizedOut = redactNormalized ? redactPayloadStrings(normalized) : normalized;

  return {
    ok: errors.length === 0,
    changed: changedFrom(input, normalized) || redactNormalized,
    normalized: errors.length === 0 ? normalizedOut : undefined,
    warnings,
    errors,
    safety: {
      executableByOpenChrome,
      requiresUserConfirmation: safetyScan.requires,
      ...(safetyScan.reason ? { reason: safetyScan.reason } : {}),
    },
  };
}

const definition: MCPToolDefinition = {
  name: 'oc_normalize_action',
  description:
    'Validate and normalize a near-valid browser/computer action payload without executing it. ' +
    'Use this before calling real action tools when a host model produced aliases such as left_click, hotkey, coordinate, or missing click button. ' +
    'This tool is side-effect-free: it does not touch Chrome, CDP, tabs, DOM, cookies, storage, or files.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'object',
        description: 'REQUIRED Candidate action object to validate and normalize. The action is never executed.',
      },
      targetTool: {
        type: 'string',
        enum: ['computer', 'interact', 'act', 'javascript_tool'],
        description: 'Optional target tool context. Currently advisory only; normalization remains side-effect-free.',
      },
      strict: {
        type: 'boolean',
        description: 'When true (default), missing required fields and unsupported action types make ok=false.',
      },
      redactNormalized: {
        type: 'boolean',
        description: "When true, caller-provided string payload values in normalized output are replaced with '[REDACTED]'.",
      },
    },
    required: ['action'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      changed: { type: 'boolean' },
      normalized: { type: 'object' },
      warnings: { type: 'array' },
      errors: { type: 'array' },
      safety: { type: 'object' },
    },
    required: ['ok', 'changed', 'warnings', 'errors', 'safety'],
  },
};

const handler: ToolHandler = async (_sessionId, args): Promise<MCPResult> => {
  const structured = normalizeActionPayload({
    action: args.action,
    targetTool: args.targetTool,
    strict: args.strict,
    redactNormalized: args.redactNormalized,
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured as unknown as Record<string, unknown>,
    isError: structured.ok ? undefined : true,
  };
};

export function registerOcNormalizeActionTool(server: MCPServer): void {
  server.registerTool(definition.name, handler, definition);
}
