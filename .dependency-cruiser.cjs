/**
 * dependency-cruiser config for the portability-harness contract tier split.
 *
 * Enforces:
 *   - src/core/** may NOT import from src/pilot/** (lint error).
 *
 * See docs/roadmap/portability-harness-contract.md for the full rule set.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-must-not-import-pilot',
      severity: 'error',
      comment:
        'src/core/ must not depend on src/pilot/. Pilot tier is opt-in via --pilot ' +
        'and may relax invariants (background work, workflow policy) that core forbids. ' +
        'This rule subsumes the lifecycle-bus import direction (issue #857): ' +
        'src/core/lifecycle/ is under src/core/ and inherits the same prohibition. ' +
        'See docs/roadmap/portability-harness-contract.md "Import direction (enforced by lint)".',
      from: { path: '^src/core/' },
      to: { path: '^src/pilot/' },
    },
    {
      name: 'core-must-not-import-observability-adapters',
      severity: 'error',
      comment:
        'src/core/ owns shared observability primitives such as request context, but must not ' +
        'depend on top-level observability adapters for logging, redaction, or visual trajectories.',
      from: { path: '^src/core/' },
      to: { path: '^src/observability/' },
    },
    {
      name: 'core-must-not-import-security-policy-adapters',
      severity: 'error',
      comment:
        'src/core/ owns reusable primitives, including secret loading/redaction/substitution, but must not ' +
        'depend on top-level security policy adapters such as domain guards, MCP roots, audit logging, or content sanitization.',
      from: { path: '^src/core/' },
      to: { path: '^src/security/' },
    },
    {
      name: 'core-must-not-import-hints-adapters',
      severity: 'error',
      comment:
        'src/core/ task primitives must not depend on top-level hint generation or recovery-advice adapters.',
      from: { path: '^src/core/' },
      to: { path: '^src/hints/' },
    },
    {
      name: 'core-must-not-import-dashboard-adapters',
      severity: 'error',
      comment:
        'src/core/ must not depend on dashboard transport/view types; pass structural data into core boundaries instead.',
      from: { path: '^src/core/' },
      to: { path: '^src/dashboard/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src/',
  },
};
