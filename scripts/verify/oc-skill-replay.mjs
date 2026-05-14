#!/usr/bin/env node
/**
 * Compatibility entrypoint for issue #856.
 *
 * The original issue contract names `scripts/verify/oc-skill-replay.mjs`.
 * Keep this thin wrapper so operators and PR descriptions can use that exact
 * path while the canonical scenario printer remains `skill-replay.mjs`.
 */

await import('./skill-replay.mjs');
