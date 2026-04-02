/**
 * Setup Hints — fires once on first successful tool call to suggest running setup.
 */

import type { HintRule } from '../hint-engine';

let hasFired = false;

export const setupHintRules: HintRule[] = [
  {
    name: 'setup-permission-hint',
    priority: 90,
    match(ctx) {
      // Fire only once per session
      if (hasFired) return null;
      // Only on non-error tool calls
      if (ctx.isError) return null;
      hasFired = true;
      return 'Hint: To configure OpenChrome quickly, run: npx openchrome-mcp setup (or add --client codex for Codex CLI)';
    },
  },
];
