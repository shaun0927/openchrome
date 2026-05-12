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
        'See docs/roadmap/portability-harness-contract.md "Import direction (enforced by lint)".',
      from: { path: '^src/core/' },
      to: { path: '^src/pilot/' },
    },
    {
      name: 'lifecycle-must-not-import-pilot',
      severity: 'error',
      comment:
        'src/core/lifecycle/ must not depend on src/pilot/. The lifecycle bus is a ' +
        'core-tier module that pilot consumers subscribe to; the reverse import direction ' +
        'would create a circular dependency and violate the portability-harness contract ' +
        '(issue #857).',
      from: { path: '^src/core/lifecycle/' },
      to: { path: '^src/pilot/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src/',
  },
};
