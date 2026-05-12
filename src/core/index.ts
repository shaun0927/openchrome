/**
 * Tier: core
 *
 * Modules under src/core/** must satisfy principles P1–P5 of the
 * portability-harness contract (docs/roadmap/portability-harness-contract.md):
 *   P1. Tool server identity — no work outlives a tool call.
 *   P2. Zero-impact harness extension — off behavior is bit-identical to 1.10.4.
 *   P3. Anywhere-compatible MCP — no third-party LLM API egress, no mandatory
 *       API key, no native deps without fallback.
 *   P4. Facts vs decisions — capture, compute, store, retrieve. Do not decide.
 *   P5. Native dependency discipline — argon2 only.
 *
 * Core modules MUST NOT import from src/pilot/** (enforced by the
 * dependency-cruiser rule "core-must-not-import-pilot").
 *
 * Submodules will be added under src/core/{trace,skill,contracts,perception,
 * skill-memory,cli,mcp}/ as the 1.11 cleanup PRs land.
 */

export {};
