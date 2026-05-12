# Recipe: docs changelog diff

## Goal

Given two URLs that point at the same conceptual docs page at different
points in time (a "before" and an "after"), explain what changed in
plain prose. Typical use: release-notes drafting, regression triage,
or auditing a vendor's silently-edited terms page.

## Inputs

- `before_url: string` — the older snapshot (e.g. an archive.org capture, or a `?ref=v1.10` branch URL).
- `after_url: string` — the newer snapshot.
- `focus?: string` — optional hint for the host LLM (e.g. "auth flow", "pricing tiers"). Server ignores this.

## Plan

1. `mcp__openchrome__navigate` `{ url: before_url }`. Expect navigation status.
2. `mcp__openchrome__read_page` `{ mode: "markdown", max_chars: 8000 }`. Returns the rendered markdown.
3. `mcp__openchrome__navigate` `{ url: after_url }`.
4. `mcp__openchrome__read_page` `{ mode: "markdown", max_chars: 8000 }`.

   Both reads in markdown mode so paragraph breaks line up — diffing
   AX trees against each other is unreliable when one snapshot loaded
   a navigation update and the other did not.

5. **Optional** — when prose alone is ambiguous (e.g. you suspect a
   table cell changed but the markdown rendered both versions the
   same), repeat steps 2 and 4 with `mode: "dom"` and a CSS selector
   scoped to the suspect region.

## Synthesis (host LLM)

The host receives two markdown blobs. It computes the textual diff
locally (any host can do this without a tool call) and writes a prose
summary. If `focus` was provided, the summary leads with that section;
otherwise the summary groups changes by markdown heading.

No server-side LLM call. No serial network reads beyond the two
`navigate` + `read_page` pairs above.

## Verification

Use a stable changelog page that you know historical content for:

1. `mcp__openchrome__navigate` to `https://nodejs.org/en/blog/release/v20.0.0`.
2. `mcp__openchrome__read_page` `{ mode: "markdown", max_chars: 8000 }`. Confirm the response includes the v20.0.0 release notes prose.
3. Repeat for `https://nodejs.org/en/blog/release/v21.0.0`.
4. Confirm the two markdown blobs differ (sanity check that the
   navigate actually moved off the first URL).

If step 2 returns boilerplate / login wall / empty content, the site
is gating the rendered text; fall back to `extract_data` with a CSS
selector for the `<article>` body and re-run.

## Out of scope

- Image diffs (use `oc_evidence_bundle` for screenshot pairs).
- Server-rendered SPAs that need authenticated session — combine with
  `oc_skill_recall` first.
