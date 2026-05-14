# Pagination convention

This document is the human-readable companion to `src/utils/paginate.ts`. It
defines the opaque-cursor convention every paginated tool result in
OpenChrome will follow. The convention mirrors the MCP-spec opaque-cursor
pagination already used by `tools/list`, `resources/list`, etc., so clients
that implement spec-level cursor handling can reuse it unchanged.

## Wire format

**Input** (any paginated tool):

- `cursor?: string` — opaque to the client. Absent ⇒ start of the underlying
  stable set.

**Output** (inside `structuredContent`):

```jsonc
{
  // The page slice. Tools may rename `items` to a domain-specific key
  // (`matches`, `entries`, `requests`, `text`, …) — the wire-format shape
  // for the pagination metadata stays the same.
  "items": [ ... ],

  // Present iff there are more pages. Opaque to the caller.
  "nextCursor": "...",

  // Duplicates `nextCursor != null` for clarity. Always present.
  "hasMore": false,

  // Total items in the underlying set, including pages already consumed.
  // Cheap-to-compute total; omitted only when computing the total is more
  // expensive than the call itself.
  "total": 42
}
```

## Cursor encoding

Cursors are base64url-encoded JSON of the form
`{ v: 1, offset: number, hash?: string }`.

- `v` — version (currently `1`; future versions can carry new fields).
- `offset` — non-negative integer; the next position to read in the stable
  ordering.
- `hash` — optional content hash of the underlying input set. When a tool
  passes a hash, the helper compares it to the cursor's recorded hash on
  decode and signals `staleCursor: true` on divergence.

## Stale cursor handling

A cursor referring to a stale view (the underlying set changed between
calls) MUST be reported as a JSON-RPC error, not a `MCPResult.isError`:

```json
{
  "jsonrpc": "2.0",
  "id": <id>,
  "error": {
    "code": -32003,
    "message": "stale_cursor",
    "data": { "code": "stale_cursor", "retry": "restart_from_no_cursor" }
  }
}
```

Rationale: stale-cursor errors are mechanical — clients should auto-retry
from the start, not surface a tool error to the orchestrating LLM. Using
the JSON-RPC channel makes the error machine-readable and keeps the
LLM-visible response free of recoverable failures.

## Helper API

Use `paginate` / `encodeCursor` / `decodeCursor` from
`src/utils/paginate.ts`. Example:

```ts
import { paginate } from '../utils/paginate';

const allMatches = /* stable, deterministic ordering required */;
const { items, hasMore, nextCursor, total, staleCursor } = paginate(allMatches, {
  pageSize: 50,
  cursor: args.cursor,
  contentHash: hashOf(allMatches), // optional; enable stale-cursor detection
});

if (staleCursor) {
  // Return JSON-RPC -32003 — see "Stale cursor handling" above.
  throw new StaleCursorError();
}

return {
  content: [{ type: 'text', text: JSON.stringify({ matches: items, total, hasMore, nextCursor }) }],
  structuredContent: { matches: items, total, hasMore, nextCursor },
};
```

## Tool adoption status

| Tool / surface | Pageable field | Default page size | Status |
| -------------- | -------------- | ----------------- | ------ |
| `paginate` helper | `items` | caller supplied | ✅ shipped |
| `query_dom` | `elements` / `results` | 50 | ✅ multiple CSS/XPath results accept `cursor` and return `nextCursor` / `hasMore` / `totalCount` |
| `console_capture` `get` | `entries` / `logs` | 200 when cursoring; no-cursor output remains legacy-compatible | ✅ cursor support in PR #1234 |
| `network_capture_lite/full` `getLogs` | `requests` / `entries` | 100 | ✅ cursor support in PR #1235 |
| `read_page` markdown | `text` | 5,000 chars after the legacy first chunk | ✅ markdown cursor support in this PR |
| `crawl` | `pages` | 25 pages | ✅ cursor support in this PR |

Each adoption should stay a small per-tool PR: import `paginate`, preserve
cursor-omitted compatibility for one minor version, and route cursor page
fields into `structuredContent`. Bundling the remaining surfaces would multiply
review surface — separate PRs keep each adoption reviewable against the tool's
specific data-shape and ordering invariants.

### `query_dom`

For `multiple: true`, pass `limit` as the page size and pass a previous
`nextCursor` as `cursor`. CSS responses use `elements`; XPath responses use
`results`. Both include `totalCount`, `hasMore`, and optional `nextCursor` in
text JSON and `structuredContent`. Calls without `cursor` preserve first-page
behavior and the default page size remains 50.

### `console_capture`

For `action: "get"`, pass a previous `nextCursor` as `cursor`. Cursoring returns
paged console entries in `structuredContent.entries`; the text payload uses the
legacy `logs` field and includes `hasMore` / `nextCursor` only for cursor calls.
Calls without `cursor` preserve the v1.11 text response baseline.

### `network_capture_lite/full`

For `action: "getLogs"`, pass a previous `nextCursor` as `cursor`. Cursoring
returns paged requests in `structuredContent.requests`; the text payload keeps
the legacy `entries` field and includes `hasMore` / `nextCursor` only for cursor
calls. `limit: 0` still means "all retained entries" for compatibility.

### `read_page` markdown

For `mode: "markdown"`, long no-cursor responses keep the legacy text body and
truncation marker, while adding `structuredContent.nextCursor` / `hasMore` /
`total` metadata when more markdown remains. Pass that `nextCursor` back as
`cursor` to retrieve the next 5,000-character markdown chunk as JSON text plus
matching `structuredContent`. Cursor hashes cover the full generated markdown so
stale page content is rejected with `stale_cursor` instead of silently resetting.

### `crawl`

Pass a previous `nextCursor` as `cursor` to paginate the returned `pages` array
after the crawl completes. Cursor pages use 25 crawl pages per response and
return JSON text plus matching `structuredContent` with `offset`, `total`,
`hasMore`, and optional `nextCursor`. Calls without `cursor` keep the legacy
JSON text output while also exposing a first structured 25-page slice for
clients that want to continue without changing the no-cursor text contract.

## Why opaque cursors (and not `start_index`)

The MCP spec already uses opaque cursors for `tools/list` / `resources/list`.
Standardizing on the same convention for tool results means clients that
implement spec-level cursor handling can reuse it unchanged, and lets the
server change pagination strategy (e.g. switch from offset to seek-after) in
the future without breaking the wire contract.
