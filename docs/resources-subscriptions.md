# MCP resource templates and subscriptions

OpenChrome advertises live MCP resources with:

```json
"resources": { "listChanged": true, "subscribe": true }
```

Shared read methods:

- `resources/list` — static resources plus currently concrete live session resources.
- `resources/templates/list` — URI templates listed below.
- `resources/read` — returns JSON content for a concrete URI.

Subscription behavior depends on the negotiated protocol:

- MCP `2026-07-28`: open `subscriptions/listen` with
  `resourceSubscriptions` and/or `resourcesListChanged`.
- Legacy MCP: use `resources/subscribe` / `resources/unsubscribe` for
  per-MCP-session live updates.

## URI templates

| Template | Content |
| --- | --- |
| `oc://session/{sessionId}/tabs` | Current tab tree, matching the `tabs_context` structured shape. |
| `oc://session/{sessionId}/state` | Session lifecycle (`idle`/`active`), existence, worker/target counts, timestamps. |
| `oc://journal/{taskId}` | Latest 100 journal entries for the matching task/session id. |
| `oc://recording/{recordingId}` | Recording metadata, status, and local artifact URL when stopped. |
| `oc://dashboard/state` | Dashboard snapshot filtered to sessions visible to the caller tenant. |

## Notifications

A successful modern listen request or legacy `resources/subscribe` causes
future matching changes to emit:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": { "uri": "oc://session/default/tabs" }
}
```

Session create/delete events also emit `notifications/resources/list_changed` so clients can refresh `resources/list`.

Modern events are filtered by the `subscriptions/listen` request and carry
`io.modelcontextprotocol/subscriptionId` in `_meta`. Legacy updates are
coalesced per subscribed `(Mcp-Session-Id, uri)` with a 100 ms debounce.
In HTTP daemon mode, each modern listen stream is also bound to the
authenticated tenant. Concrete resource events are delivered only to matching
tenant listeners; events whose ownership cannot be resolved are not
broadcast.

## Limits and authz

- The modern SDK caps active listen requests per connection and filters each
  request to the advertised resource capabilities.
- Concrete resources returned by `resources/list` are filtered to the current
  tenant before cache metadata is added.
- The legacy subscription cap defaults to 50 active URIs per MCP session.
- Override with `OPENCHROME_RESOURCE_SUB_LIMIT` (bounded to `1..1000`).
- Exceeding the cap returns JSON-RPC code `-32002` and message `subscription_limit_exceeded`.
- Reads/subscribes for existing session-scoped resources require the caller tenant to own the session. Cross-tenant attempts return code `-32001` (`Forbidden`).
- Modern HTTP stream closure cancels that listen request. Legacy disconnect or
  `DELETE /mcp` cleans up the protocol session's subscription set.

The existing `/dashboard/*` HTTP endpoint remains unchanged; these resources are additive.
