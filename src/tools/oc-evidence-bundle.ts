/**
 * oc_evidence_bundle — capture a snapshot of current page state (issue #792).
 *
 * Tier 1 MCP tool. Accepts a caller-supplied snapshot (DOM, screenshot bytes,
 * network entries, console entries) and writes the requested parts to a flat
 * directory under `<rootDir>/<bundle_id>/`. Returns the bundle metadata so
 * the caller can locate the produced files.
 *
 * The tool is intentionally standalone: it does NOT depend on the pilot
 * contract runtime (#749). The `oc_assert` tool (#784) already returns an
 * `evidence_handle` placeholder; a follow-up PR will let this tool consume
 * those handles to produce a bundle from previously recorded evidence.
 *
 * See `src/core/contracts/evidence-bundle.ts` for the capture helpers.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import {
  DEFAULT_INCLUDE,
  DEFAULT_NETWORK_WINDOW_MS,
  writeEvidenceBundle,
  type EvidenceBundlePart,
  type EvidenceBundleSnapshot,
  type ConsoleEntry,
  type NetworkEntry,
} from '../core/contracts/evidence-bundle';
import type {
  SchemaDefinition,
  SchemaDiff,
  SchemaFieldType,
} from '../core/contracts/schema-diff';
import {
  OUTPUT_MODE_SCHEMA_PROPERTIES,
  parseOutputMode,
  resolveOutputMode,
} from './_shared/output-mode';

interface OcEvidenceBundleOutput {
  bundle_id: string;
  path: string;
  size_bytes: number;
  parts: string[];
  /** Filled when no snapshot was supplied; bundle is still created (empty). */
  inconclusive_reason?: string;
  /**
   * Present iff the bundle wrote `schema_diff.json`. Mirrors the on-disk
   * diff so the caller does not need a second read to inspect coverage.
   */
  schema_diff?: SchemaDiff;
}

interface SnapshotInput {
  dom?: string | Record<string, unknown> | null;
  /** Base64 PNG. */
  screenshot_png_base64?: string;
  network?: NetworkEntry[];
  console?: ConsoleEntry[];
  now_ms?: number;
  /** Structured data the caller extracted from the page; diffed against `target_schema`. */
  observed?: unknown;
}

const VALID_PARTS: readonly EvidenceBundlePart[] = [
  'dom',
  'screenshot',
  'network',
  'console',
  'phash',
  'schema_diff',
];

const definition: MCPToolDefinition = {
  name: 'oc_evidence_bundle',
  description:
    'Capture a snapshot of the current page state (DOM, screenshot, network ' +
    'slice, console, perceptual hash) and write it to a bundle directory. ' +
    "Returns { bundle_id, path, size_bytes, parts }. Default include = " +
    "['dom', 'screenshot']; pass `include` to capture more parts. " +
    '`network_window_ms` (default 5000) limits the network slice to recent ' +
    'entries. Core-tier; does not depend on the pilot runtime.',
  inputSchema: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        description:
          "Which parts to capture. Default ['dom', 'screenshot']. Allowed " +
          "items: 'dom' | 'screenshot' | 'network' | 'console' | 'phash' | " +
          "'schema_diff'. `schema_diff` requires `target_schema` and " +
          '`evidence.snapshot.observed`; otherwise the part is omitted.',
        items: {
          type: 'string',
          enum: VALID_PARTS as unknown as string[],
        },
      },
      target_schema: {
        type: 'object',
        description:
          'Declared target schema (see src/core/contracts/schema-diff.ts: ' +
          '{ version: 1, fields: [ { name, type, required? } ] }). When ' +
          "supplied together with `evidence.snapshot.observed` and the " +
          "'schema_diff' part is included, the bundle writes " +
          "`schema_diff.json` containing the structured field-match diff.",
      },
      network_window_ms: {
        type: 'number',
        description:
          'Rolling window (ms) used to slice the supplied `evidence.snapshot.network` ' +
          `array. Default ${DEFAULT_NETWORK_WINDOW_MS}.`,
      },
      evidence: {
        type: 'object',
        description:
          'Caller-supplied snapshot. Provide the subset of fields the requested ' +
          'parts need: `dom`, `screenshot_png_base64`, `network`, `console`, `now_ms`. ' +
          'Missing fields cause the corresponding part to be omitted gracefully.',
        properties: {
          snapshot: {
            type: 'object',
            description:
              'Snapshot fields. `dom` (string|object), `screenshot_png_base64` (base64 PNG), ' +
              '`network` (NetworkEntry[]), `console` (ConsoleEntry[]), `now_ms` (epoch ms ' +
              'used for the network window cutoff).',
          },
        },
      },
      ...OUTPUT_MODE_SCHEMA_PROPERTIES,
    },
    required: [],
  },
  annotations: TOOL_ANNOTATIONS.oc_evidence_bundle,
};

function parseInclude(raw: unknown): EvidenceBundlePart[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: EvidenceBundlePart[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && (VALID_PARTS as readonly string[]).includes(item)) {
      out.push(item as EvidenceBundlePart);
    }
  }
  return out;
}

function buildSnapshot(input: SnapshotInput | undefined): EvidenceBundleSnapshot {
  if (!input) return {};
  const out: EvidenceBundleSnapshot = {};
  if (input.dom !== undefined) out.dom = input.dom;
  if (input.screenshot_png_base64) out.screenshot_png = input.screenshot_png_base64;
  if (Array.isArray(input.network)) out.network = input.network;
  if (Array.isArray(input.console)) out.console = input.console;
  if (typeof input.now_ms === 'number') out.now_ms = input.now_ms;
  if (input.observed !== undefined) out.observed = input.observed;
  return out;
}

/**
 * Narrow validation of the caller-supplied `target_schema` input.
 *
 * Returns the schema when shape-correct, otherwise `undefined`. The diff
 * step is then silently skipped — consistent with the rest of the bundle
 * writer, which treats missing/malformed inputs as "omit gracefully".
 */
const VALID_SCHEMA_FIELD_TYPES = new Set<SchemaFieldType>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
]);

function isSchemaFieldType(value: unknown): value is SchemaFieldType {
  return typeof value === 'string' && VALID_SCHEMA_FIELD_TYPES.has(value as SchemaFieldType);
}

function parseTargetSchema(raw: unknown): SchemaDefinition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as { version?: unknown; fields?: unknown };
  if (candidate.version !== 1) return undefined;
  if (!Array.isArray(candidate.fields)) return undefined;
  for (const f of candidate.fields) {
    if (!f || typeof f !== 'object') return undefined;
    const field = f as { name?: unknown; type?: unknown };
    if (typeof field.name !== 'string') return undefined;
    if (!isSchemaFieldType(field.type)) return undefined;
  }
  return candidate as unknown as SchemaDefinition;
}

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const include = parseInclude(args.include);
  const networkWindowMs =
    typeof args.network_window_ms === 'number' ? args.network_window_ms : undefined;
  const evidenceArg = args.evidence as { snapshot?: SnapshotInput } | undefined;
  const snapshot = buildSnapshot(evidenceArg?.snapshot);
  const targetSchema = parseTargetSchema(args.target_schema);
  const { mode, inlineLimit } = parseOutputMode(args);

  let result;
  try {
    result = writeEvidenceBundle(snapshot, {
      include,
      networkWindowMs,
      ...(targetSchema !== undefined ? { targetSchema } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failure: OcEvidenceBundleOutput = {
      bundle_id: '',
      path: '',
      size_bytes: 0,
      parts: [],
      inconclusive_reason: `failed to write evidence bundle: ${message}`,
    };
    return jsonResult(failure);
  }

  const output: OcEvidenceBundleOutput = {
    bundle_id: result.bundle_id,
    path: result.path,
    size_bytes: result.size_bytes,
    parts: result.parts,
  };
  if (result.schema_diff !== undefined) {
    output.schema_diff = result.schema_diff;
  }
  if (result.parts.length === 0) {
    output.inconclusive_reason =
      'no evidence parts captured — supply `evidence.snapshot` with at least one of ' +
      "dom / screenshot_png_base64 / network / console / observed, and select matching `include` parts.";
  }
  const inlineResult = jsonResult(output);
  return resolveOutputMode(mode, inlineLimit, inlineResult, output, 'oc_evidence_bundle');
};

function jsonResult(payload: OcEvidenceBundleOutput): MCPResult {
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

export function registerOcEvidenceBundleTool(server: MCPServer): void {
  server.registerTool('oc_evidence_bundle', handler, definition);
}

// Re-export defaults so consumers (e.g. tests) can reference them without
// reaching into the helper module.
export { DEFAULT_INCLUDE, DEFAULT_NETWORK_WINDOW_MS };
