# Recipe: multi-source news digest

## Goal

Produce a one-screen daily digest of the top stories from a small set
of news sources. The host LLM picks the sources and decides what counts
as "top," but openchrome never calls a model — it only navigates, reads
the rendered pages, and returns structured snapshots.

## Inputs (from the user / host context)

- `sources: string[]` — 2 to 5 source URLs (e.g. `["https://news.ycombinator.com/", "https://techcrunch.com/"]`).
- `max_stories_per_source: number` — typically 5.
- `digest_length_words: number` — typically 200.

## Plan

For each `source` in `sources`:

1. `mcp__openchrome__navigate` with `{ url: source }`. Expect: `{ url, title, status }`.
2. `mcp__openchrome__read_page` with `{ mode: "ax", max_chars: 4000 }`. Expect: an accessibility-tree snapshot containing the visible headline / story-row structure.

   Why `mode: "ax"` and not `mode: "dom"`: headline lists are
   list/heading items in the accessibility tree, and the AX snapshot
   strips ad and chrome boilerplate the host would otherwise have to
   filter out.
3. Host LLM picks the top `max_stories_per_source` headlines from each
   snapshot. Discard items missing a link or whose text is empty.
4. **Optional** — for any headline whose linked detail page the host
   wants to summarise individually: `mcp__openchrome__navigate` to the
   story URL, then `mcp__openchrome__read_page` with
   `{ mode: "markdown", max_chars: 3000 }`.

   Use markdown mode here, not AX: the body of an article is prose,
   not structure, and the markdown formatter preserves paragraph breaks.

## Synthesis (host LLM)

The host receives one snapshot per source and (optionally) one body per
story. It composes the final digest in `digest_length_words` words,
grouping by source and bolding headlines. No server-side LLM call.

## Verification

Run by hand against `https://news.ycombinator.com/` and
`https://lobste.rs/`:

1. `mcp__openchrome__navigate` to each URL.
2. `mcp__openchrome__read_page` with `{ mode: "ax", max_chars: 4000 }`.
3. Confirm the AX snapshot lists at least the top 10 stories on each
   site (story rows surface as link / heading items).
4. Pick one story from HN, navigate to it, `read_page` in markdown
   mode, confirm the article body is present and not the HN comment
   thread.

If step 3 fails, the source markup has changed; update the recipe with
the new selectors or switch to `find` to locate the story list before
calling `read_page`.

## Out of scope

- Server-side summarisation (P3 forbids outbound LLM).
- Login-gated sources — those need `oc_skill_recall` for credentials,
  which is a different recipe.
- Translated digests — host LLM handles that downstream.
