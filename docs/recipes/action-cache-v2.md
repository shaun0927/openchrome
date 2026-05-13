# Action cache v2 status

`act` records successful deterministic parsed action sequences with a v2 cache
key that includes page state, action kinds, viewport, locale/user-agent class,
and action-relevant options. This keeps repeat actions fast without replaying a
sequence against materially different page structure.

Every `act` text response includes a stable cache line:

```text
[cache] status=MISS keyVersion=2 reason=no_candidate
```

Statuses:

- `MISS`: no matching v2 cache entry exists; `act` parses and executes normally.
- `HIT`: a matching v2 key (or safe v1 migration fallback) supplied the sequence.
- `STALE`: an entry exists for the same instruction, but the page/option
  fingerprint changed, so the cached sequence is not replayed.
- `BYPASS`: cache keying could not run or another explicit path (template or
  workflow cache) handled the request.

The persisted v2 entry stores bounded hashes of action-relevant page structure;
it does not store screenshots, raw full HTML, cookies, passwords, timestamps, or
backend node ids as key material.

## Manual drift check

1. Serve a fixture with a visible `Save` button and call `act` with
   `instruction: "click Save"`.
2. Repeat against the identical fixture and confirm the response shows
   `status=HIT` once the cache is warm.
3. Change the fixture so the actionable labels differ, then call the same
   instruction again.
4. Confirm the response shows `status=STALE` or a miss/bypass, and that the old
   cached sequence was not blindly replayed.
