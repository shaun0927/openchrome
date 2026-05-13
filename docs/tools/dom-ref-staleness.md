# DOM/ref staleness metadata

`read_page(mode: "ax")` returns lightweight snapshot metadata with the refs it mints:

- top-level `snapshot`: `{ snapshotId, capturedAt, url, tabId }`
- per-ref fields: `snapshot_id`, `snapshot_captured_at`, `snapshot_url`, `created_at`, and `stale_after_ms`

Action tools that consume explicit refs still fail closed with `STALE_REF` when a ref is missing or TTL-expired. When available, the error includes a bounded `stale_warning` object so hosts can distinguish a missing/navigated snapshot from an old snapshot and refresh page state before retrying.

This is advisory metadata only. OpenChrome does not automatically re-click, re-resolve, navigate, or recover from stale refs; callers should run `read_page` or `find` again and use the fresh ref.
