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

| Tool              | Status                             |
| ----------------- | ---------------------------------- |
| `paginate` helper | ✅ shipped (this PR)                |
| `read_page`       | Follow-up issue                    |
| `query_dom`       | ✅ multiple CSS/XPath results accept `cursor` and return `nextCursor` / `hasMore` / `totalCount` |
| `console_capture` | Follow-up issue                    |
| `network`         | Follow-up issue                    |
| `crawl`           | Follow-up issue                    |

Each adoption is a small per-tool PR: import `paginate`, replace existing
chunking logic with a `paginate(...)` call, route the result fields into the
tool's `structuredContent`. Bundling them here would multiply review
surface — separate PRs keep each adoption reviewable against the tool's
specific data-shape and ordering invariants.

### `query_dom`

For `multiple: true`, pass `limit` as the page size and pass a previous
`nextCursor` as `cursor`. CSS responses use `elements`; XPath responses use
`results`. Both include `totalCount`, `hasMore`, and optional `nextCursor` in
text JSON and `structuredContent`. Calls without `cursor` preserve first-page
behavior and the default page size remains 50.

## Why opaque cursors (and not `start_index`)

The MCP spec already uses opaque cursors for `tools/list` / `resources/list`.
Standardizing on the same convention for tool results means clients that
implement spec-level cursor handling can reuse it unchanged, and lets the
server change pagination strategy (e.g. switch from offset to seek-after) in
the future without breaking the wire contract.
