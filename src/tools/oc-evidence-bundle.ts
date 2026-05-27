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
}

interface SnapshotInput {
  dom?: string | Record<string, unknown> | null;
  /** Base64 PNG. */
  screenshot_png_base64?: string;
  network?: NetworkEntry[];
  console?: ConsoleEntry[];
  now_ms?: number;
  /** Caller-supplied gate fact (typically the oc_gate_inspect output). */
  gate?: Record<string, unknown>;
}

const VALID_PARTS: readonly EvidenceBundlePart[] = [
  'dom',
  'screenshot',
  'network',
  'console',
  'phash',
  'gate',
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
          "items: 'dom' | 'screenshot' | 'network' | 'console' | 'phash' | 'gate'.",
        items: {
          type: 'string',
          enum: VALID_PARTS as unknown as string[],
        },
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
          'parts need: `dom`, `screenshot_png_base64`, `network`, `console`, `now_ms`, `gate`. ' +
          'Missing fields cause the corresponding part to be omitted gracefully.',
        properties: {
          snapshot: {
            type: 'object',
            description:
              'Snapshot fields. `dom` (string|object), `screenshot_png_base64` (base64 PNG), ' +
              '`network` (NetworkEntry[]), `console` (ConsoleEntry[]), `now_ms` (epoch ms ' +
              'used for the network window cutoff), `gate` (oc_gate_inspect-compatible fact).',
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
  if (input.gate && typeof input.gate === 'object') {
    // Shallow-copy through with `unknown` shape; the bundle writer is
    // schema-neutral and persists the JSON verbatim. The MCP tool surface
    // intentionally avoids re-importing oc_gate_inspect types so the
    // bundle module stays I/O-only.
    out.gate = input.gate as unknown as EvidenceBundleSnapshot['gate'];
  }
  return out;
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
  const { mode, inlineLimit } = parseOutputMode(args);

  let result;
  try {
    result = writeEvidenceBundle(snapshot, { include, networkWindowMs });
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
  if (result.parts.length === 0) {
    output.inconclusive_reason =
      'no evidence parts captured — supply `evidence.snapshot` with at least one of ' +
      "dom / screenshot_png_base64 / network / console, and select matching `include` parts.";
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
