# `oc_evidence_get`

Retrieve the redacted artifact referenced by an `oc_assert` `evidence_handle`.

```jsonc
{
  "evidence_handle": "ev_01234567-89ab-cdef-0123-456789abcdef",
  "sessionId": "logical-session-a"
}
```

The tool is read-only and launch-free. It succeeds only inside the same
OpenChrome process instance, session, and tenant that created the handle. This
prevents independent stdio or daemon processes under one OS account from
reading or deleting each other's artifacts even when they both use the default
logical session and tenant IDs. Successful responses include the assertion,
verdict/evaluator evidence, provenance, creation time, expiry time, and trace
availability status.

`sessionId` is optional for direct calls and defaults to the current MCP/browser
session. The `evidence_get` object returned by `oc_assert` includes the resolved
owner session and should be executed unchanged, especially when `oc_assert`
used an explicit logical session.

Artifacts expire after 30 minutes and are also deleted when their matching
session/tenant owner is removed through HTTP `DELETE /mcp`, `sessions/delete`,
or a SessionManager deletion event. Real browser sessions emit that event
during TTL cleanup and shutdown. Expired handles fail immediately, and a
read does not unlink the artifact; a periodic unref sweep removes expired files
and crash-left temporary writes from disk. Persistence is bounded
to 1 MiB per artifact, 16 MiB or 256 artifacts per session/tenant owner, and
64 MiB or 1,024 artifacts per OpenChrome process. Quota rejection leaves the
assertion verdict intact but returns no handle. Retrieval failures use stable
codes:

- `EVIDENCE_HANDLE_REQUIRED`
- `EVIDENCE_HANDLE_MALFORMED`
- `EVIDENCE_NOT_FOUND`
- `EVIDENCE_EXPIRED`
- `EVIDENCE_FORBIDDEN`
- `EVIDENCE_CORRUPT`

OpenChrome redacts credential-shaped values and configured secret literals
before persistence and again before retrieval. Opaque 32-character hexadecimal
`target_id` and `worker_id` provenance values remain available unless they
match an explicitly configured secret. The tool never returns the artifact's
local filesystem path.
