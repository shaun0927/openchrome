/**
 * Tier: core
 *
 * Modules under src/core/** must stay compatible with the unflagged CLI/MCP
 * runtime: no third-party LLM egress, no mandatory external API key, no pilot
 * imports, and no work that outlives a tool call unless the runtime owns it.
 *
 * Core modules MUST NOT import from src/pilot/** (enforced by the
 * dependency-cruiser rule "core-must-not-import-pilot").
 *
 * New core primitives belong under focused src/core/<domain> folders.
 */

export {};
