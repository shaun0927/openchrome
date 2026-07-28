# High-signal browser diagnostics

## Goal

Capture broad browser evidence during a workflow, then retrieve a small,
deterministic problem set for host-side diagnosis. The filtered reads preserve
the underlying console and network buffers, so the host can fall back to the
full evidence when a high-signal record needs more context.

## Inputs

- The target `tabId`.
- Whether response bodies are needed (`network_capture_full`) or metadata is
  sufficient (`network_capture_lite`).
- The browser action or workflow to observe.

## Plan

1. Start console capture without a capture-time type filter:

   ```json
   { "tabId": "<tabId>", "action": "start" }
   ```

2. Start one network recorder. Prefer lite mode unless response bodies are
   required:

   ```json
   { "tabId": "<tabId>", "action": "start" }
   ```

3. Run the browser action or workflow under test.

4. Retrieve console problems. Use `errors` when warnings are intentionally out
   of scope:

   ```json
   {
     "tabId": "<tabId>",
     "action": "get",
     "view": "problems",
     "limit": 200
   }
   ```

   The result is newest-first and reports the full retained count, classified
   count, post-dedup matched count, current page count, and cursor metadata.

5. Retrieve network failures from the same retained recording:

   ```json
   {
     "tabId": "<tabId>",
     "action": "getLogs",
     "view": "failures",
     "limit": 100
   }
   ```

   The result includes HTTP 4xx/5xx responses and non-canceled request
   failures. It excludes normal canceled navigation requests, unfinished
   requests, and body-fetch omissions.

6. While `hasMore` is true, repeat the same call with the returned
   `nextCursor`. Keep the same `view`: cursors are intentionally scoped to the
   selected view and ordering contract.

7. When a filtered record needs surrounding context, make an omitted-view or
   `view: "all"` call against the still-retained capture. Filtering does not
   mutate or discard raw records.

8. Stop both captures after evidence collection. For full network capture,
   set `keepBodies` only when the retained files are still needed.

## Synthesis

The host LLM correlates console timestamps, locations, request URLs, statuses,
and failure text. OpenChrome reports closed-set browser facts only; it does not
decide root cause, choose remediation, or run a server-owned recovery loop.

Start with the newest matched records, group records that share a navigation or
action window, and request the full view only for the context needed to test a
hypothesis. Treat a clean filtered result as "no matching retained facts", not
as proof that the page is correct.

## Verification

Against a deterministic local fixture:

1. Emit console `log`, `warning`, `assert`, and uncaught exception records.
2. Generate HTTP 200, 399, 400, 404, and 500 responses, one canceled request,
   and one non-canceled request failure.
3. Confirm `problems` returns warning/assert/error facts and `errors` returns
   assert/error facts, both newest-first.
4. Confirm `failures` returns 400/404/500 and the non-canceled failure, but not
   200/399/canceled/unfinished/body-fetch-only records.
5. Traverse more than one page and verify there are no gaps or duplicates.
6. Reuse a cursor under another view and confirm the tool reports
   `stale_cursor`.
7. Retrieve `view: "all"` and confirm the original broad evidence remains
   available.
