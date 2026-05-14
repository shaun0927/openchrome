# MCP resource templates and subscriptions

OpenChrome advertises live MCP resources with:

```json
"resources": { "listChanged": true, "subscribe": true }
```

Supported methods:

- `resources/list` — static resources plus currently concrete live session resources.
- `resources/templates/list` — URI templates listed below.
- `resources/read` — returns JSON content for a concrete URI.
- `resources/subscribe` / `resources/unsubscribe` — per-MCP-session subscriptions for live update notifications.

## URI templates

| Template | Content |
| --- | --- |
| `oc://session/{sessionId}/tabs` | Current tab tree, matching the `tabs_context` structured shape. |
| `oc://session/{sessionId}/state` | Session lifecycle (`idle`/`active`), existence, worker/target counts, timestamps. |
| `oc://journal/{taskId}` | Latest 100 journal entries for the matching task/session id. |
| `oc://recording/{recordingId}` | Recording metadata, status, and local artifact URL when stopped. |
| `oc://dashboard/state` | Dashboard snapshot filtered to sessions visible to the caller tenant. |

## Notifications

A successful `resources/subscribe` causes future matching changes to emit:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": { "uri": "oc://session/default/tabs" }
}
```

Session create/delete events also emit `notifications/resources/list_changed` so clients can refresh `resources/list`.

Updates are coalesced per subscribed `(Mcp-Session-Id, uri)` with a 100 ms debounce. HTTP/SSE sends notifications only to the matching `Mcp-Session-Id`; stdio uses the single logical `stdio` session.

## Limits and authz

- Subscription cap defaults to 50 active URIs per MCP session.
- Override with `OPENCHROME_RESOURCE_SUB_LIMIT` (bounded to `1..1000`).
- Exceeding the cap returns JSON-RPC code `-32002` and message `subscription_limit_exceeded`.
- Reads/subscribes for existing session-scoped resources require the caller tenant to own the session. Cross-tenant attempts return code `-32001` (`Forbidden`).
- Disconnect / `DELETE /mcp` cleans up that MCP session's subscription set.

The existing `/dashboard/*` HTTP endpoint remains unchanged; these resources are additive.
