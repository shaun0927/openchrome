/**
 * Output-mode helpers for large-output tools (#887).
 *
 * P2 invariant: when output_mode='inline' (the default), the tool response
 * is byte-identical to v1.11.0. The helper is only invoked for 'handle' or
 * 'auto' modes; callers in inline mode skip this entirely.
 */

import { MCPResult } from '../../types/mcp';
import { writeOutputHandle } from '../../core/output/handle-store';
import { getDefaultTtlHours } from '../../core/output/handle-store';
import { getTaskJournal } from '../../journal/task-journal';

export type OutputMode = 'inline' | 'handle' | 'auto';

/** Shared input schema fragment — paste into each tool's inputSchema.properties. */
export const OUTPUT_MODE_SCHEMA_PROPERTIES = {
  output_mode: {
    type: 'string',
    enum: ['inline', 'handle', 'auto'],
    description:
      '"inline" (default): return the full payload in-band — byte-identical to v1.11.0. ' +
      '"handle": write payload to the handle store and return a small descriptor; ' +
      'redeem with oc_output_fetch. ' +
      '"auto": inline if payload ≤ output_inline_limit_bytes, otherwise handle.',
  },
  output_inline_limit_bytes: {
    type: 'number',
    description:
      'Only honored when output_mode="auto". If the serialized payload exceeds this ' +
      'byte count the response spills to a handle. Default: 32768.',
  },
} as const;

const DEFAULT_INLINE_LIMIT = 32768;

/**
 * Resolve the effective output mode and return either the original inline result
 * or a handle descriptor result.
 *
 * @param mode        The caller-supplied output_mode value (validated).
 * @param inlineLimit The caller-supplied output_inline_limit_bytes value.
 * @param inlineResult The MCPResult the tool would have returned in v1.11.0.
 * @param payload     The data to store when a handle is created.
 * @param sourceTool  Name of the calling tool (for journal event).
 */
export async function resolveOutputMode(
  mode: OutputMode,
  inlineLimit: number,
  inlineResult: MCPResult,
  payload: unknown,
  sourceTool: string,
): Promise<MCPResult> {
  if (mode === 'inline') {
    // P2: byte-identical to v1.11.0
    return inlineResult;
  }

  const serialized = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(serialized, 'utf8');

  if (mode === 'auto' && byteLength <= inlineLimit) {
    return inlineResult;
  }

  // Write to handle store and return descriptor
  const descriptor = await writeOutputHandle(payload, sourceTool, {
    ttlHours: getDefaultTtlHours(),
  });

  // Record handle creation in the journal
  try {
    getTaskJournal().recordOutputHandle({
      event: 'output_handle_created',
      handle: descriptor.output_handle,
      source_tool: sourceTool,
      size_bytes: descriptor.size_bytes,
      mime_type: descriptor.mime_type,
    });
  } catch {
    // Best-effort — don't fail the tool call if journal write fails
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(descriptor),
      },
    ],
  };
}

/**
 * Parse output_mode from raw args, defaulting to 'inline'.
 */
export function parseOutputMode(args: Record<string, unknown>): {
  mode: OutputMode;
  inlineLimit: number;
} {
  const raw = args.output_mode as string | undefined;
  const mode: OutputMode =
    raw === 'handle' || raw === 'auto' ? raw : 'inline';
  const inlineLimit =
    typeof args.output_inline_limit_bytes === 'number' && args.output_inline_limit_bytes > 0
      ? Math.floor(args.output_inline_limit_bytes)
      : DEFAULT_INLINE_LIMIT;
  return { mode, inlineLimit };
}
