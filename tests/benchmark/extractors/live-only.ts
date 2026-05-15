/**
 * Live-only extractor scaffolding for #1256.
 *
 * The token-efficiency matrix scopes-in seven libraries that need a real
 * Chrome (OpenChrome read_page, Playwright content/innerText/a11y,
 * playwright-mcp browser_snapshot, browser-use DOM serialization). Today the
 * runner ships their `Extractor` entries as live-only scaffolds — they
 * advertise `liveOnly: true` and the matrix runner emits a clean skip
 * annotation in `--skip-live` mode instead of fabricating numbers.
 *
 * The shape is in place so a follow-up PR (next session) can replace each
 * `extract()` stub with the real library call without touching the matrix
 * runner. CI stays green via `--skip-live`; an operator with a Chrome on
 * :9222 runs `OPENCHROME_BENCH_LIVE=1 npm run bench:tokens` to exercise the
 * real cells.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from './types';

function liveOnlyStub(library: string, mode: string): Extractor {
  return {
    library,
    mode,
    liveOnly: true,
    extract(ctx: ExtractorContext): ExtractorResult | null {
      if (!ctx.liveAllowed) return null;
      // When the operator sets OPENCHROME_BENCH_LIVE=1, the runner expects a
      // real measurement — but the integration code lands in the next PR.
      // Until then, surface a clear error so it cannot be silently passed off
      // as a real run.
      throw new Error(
        `${library} live extraction is scaffolded but not yet wired — ` +
          `next-session follow-up. Drop the env flag to use --skip-live mode.`,
      );
    },
  };
}

export const liveOnlyExtractors: readonly Extractor[] = [
  liveOnlyStub('openchrome-readpage-dom', 'dom'),
  liveOnlyStub('openchrome-readpage-ax', 'ax'),
  liveOnlyStub('playwright-content', 'raw-html'),
  liveOnlyStub('playwright-innertext', 'innerText'),
  liveOnlyStub('playwright-a11y', 'a11y-snapshot'),
  liveOnlyStub('playwright-mcp-snapshot', 'a11y-snapshot'),
  liveOnlyStub('browser-use-dom', 'dom-serialization'),
];
