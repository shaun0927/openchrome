/**
 * Snapshot-stale hint (#831).
 *
 * Fires when `interact` is called without a recent `read_page` snapshot AND
 * without an explicit `ref`. The intent is to nudge agents toward the
 * snapshot-first contract: read_page(mode='ax') → ref → interact.
 *
 * Suppressible via OPENCHROME_NO_SNAPSHOT_HINTS=1 (env), which is the
 * tier-core equivalent of the user-facing --no-snapshot-hints flag.
 * The CLI flag plumbing itself lives in #829 (capability groups); keeping
 * the rule suppression in env-space here means it works in both default
 * and pilot builds without touching src/index.ts.
 */

import type { HintRule, HintContext } from '../hint-engine';

function isSuppressed(): boolean {
  const env = process.env.OPENCHROME_NO_SNAPSHOT_HINTS;
  return env === '1' || env === 'true';
}

function hadRecentReadPage(ctx: HintContext): boolean {
  // Recent calls is freshest-first per ActivityTracker contract.
  // We look at the most recent 4 calls — wider than that and the snapshot
  // is too far away to be reliably fresh anyway (REF_TTL_MS = 30s).
  for (const call of ctx.recentCalls.slice(0, 4)) {
    if (call.toolName === 'read_page') {
      // Treat only ax-mode reads as snapshot-producing — dom/css modes don't
      // populate refs (#831 ax-only contract).
      const mode = (call.args?.mode as string | undefined) ?? 'dom';
      if (mode === 'ax') return true;
    }
  }
  return false;
}

export const snapshotStaleRules: HintRule[] = [
  {
    name: 'snapshot-stale',
    // Priority 395: sits AFTER pagination (190-192), composite-suggestions
    // (200-203), sequence-detection (300-304), and learned-rules (350) but
    // BEFORE success-hints (400-403). The rule fires only as a low-noise
    // nudge — never blocks the higher-signal recovery/sequence hints.
    priority: 395,
    maxSeverity: 'warning',
    match(ctx) {
      if (isSuppressed()) return null;
      if (ctx.toolName !== 'interact') return null;
      // Only nudge on success paths — errors already carry inline guidance.
      if (ctx.isError) return null;
      // Skip if the call used the ref fast-path (we'd see [via ref]).
      if (/\[via ref\]/.test(ctx.resultText)) return null;
      // Skip when there are no prior calls — the user can't have called
      // read_page yet on their first action.
      if (ctx.recentCalls.length === 0) return null;
      if (hadRecentReadPage(ctx)) return null;
      return (
        'Hint: interact was called without a recent read_page snapshot. ' +
        "Call read_page(mode='ax') first and pass the returned ref to interact " +
        'for a faster, more reliable click. ' +
        'Suppress with OPENCHROME_NO_SNAPSHOT_HINTS=1.'
      );
    },
  },
];
