/**
 * Disabled-Tools MCP Resource (#847)
 *
 * URI: openchrome://tools/disabled
 *
 * Sidecar resource that lists tools filtered out by the category selection
 * resolved at process start. Calls to a disabled name still return a normal
 * MCP "unknown tool" error (because the name was never registered), but
 * agents can read this resource to discover what's missing and learn the
 * exact restart flag that would re-enable the tool.
 *
 * The resource content is a snapshot taken at registration time; it does
 * not update at runtime (selection is fixed for the process lifetime).
 */

import type { ToolCategory } from '../tools/_shared/category';
import type { MCPResourceDefinition } from './usage-guide';

export const DISABLED_TOOLS_RESOURCE_URI = 'openchrome://tools/disabled';

export const disabledToolsResource: MCPResourceDefinition = {
  uri: DISABLED_TOOLS_RESOURCE_URI,
  name: 'tools-disabled',
  description:
    'Tools excluded at startup by --slim / --enable-categories / --disable-categories. Includes the restart hint to re-enable each one.',
  mimeType: 'application/json',
};

export interface DisabledToolEntry {
  name: string;
  category: ToolCategory;
  hint: string;
}

let snapshot: { tools: DisabledToolEntry[]; capturedAt: string } = {
  tools: [],
  capturedAt: new Date(0).toISOString(),
};

/**
 * Replace the cached snapshot. Called once by the registration filter in
 * `src/tools/index.ts` after it knows which tools were skipped. Idempotent
 * — calling it again with a fresh list is the supported way to reset for
 * tests.
 */
export function setDisabledToolsSnapshot(entries: DisabledToolEntry[]): void {
  // Defensive copy + canonical sort by name so the JSON serialization is
  // stable regardless of registration order.
  const copy = entries.map((e) => ({ ...e }));
  copy.sort((a, b) => a.name.localeCompare(b.name));
  snapshot = {
    tools: copy,
    capturedAt: new Date().toISOString(),
  };
}

export function getDisabledToolsSnapshot(): {
  tools: DisabledToolEntry[];
  capturedAt: string;
} {
  return snapshot;
}

/**
 * Build the JSON payload returned by `resources/read` for this URI.
 * Pretty-printed for human readability — the resource is meant to be
 * eyeballed by an agent operator, not parsed by hot code.
 */
export function getDisabledToolsContent(): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Build the per-tool restart hint. Centralized so the wording stays
 * consistent across the snapshot and any future error messages that may
 * want to surface the same recovery action.
 */
export function buildDisabledHint(category: ToolCategory): string {
  return `Restart openchrome with --enable-categories=${category}`;
}
