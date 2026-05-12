# Transport Lifecycle Policy

This document is the authoritative reference for which transport modes OpenChrome supports, what stability guarantees apply to each, and how deprecations are announced and enforced.

---

## Supported transports

OpenChrome exposes three transport modes. The package CLI uses stdio by default, enables HTTP with `--http [port]`, and can select explicit modes with the `OPENCHROME_TRANSPORT` environment variable.

| Transport | Selector | Status | Since | Sunset | Recommended use case |
|-----------|----------|--------|-------|--------|----------------------|
| stdio | default or `OPENCHROME_TRANSPORT=stdio` | **stable** | v1.0.0 | — | Default. Single MCP client over stdin/stdout. Use for Claude Code, Codex CLI, Cursor, Windsurf, and any stdio-native MCP client. |
| Streamable HTTP daemon | `--http [port]` or `OPENCHROME_TRANSPORT=http` | **stable** | v1.0.0 | — | Long-running daemon serving multiple MCP clients over Streamable HTTP. Binds a local port; auth via bearer token or per-tenant API key. |
| Dual (stdio + HTTP) | `OPENCHROME_TRANSPORT=both` | **stable** | v1.0.0 | — | Run stdio and HTTP simultaneously. Intended for dashboard integrations that need both a direct MCP pipe and an HTTP fan-out endpoint. |

> **Note on SSE:** The `/mcp/sse` endpoint is the _notification delivery channel_ inside the HTTP transport — it is not a separate transport mode. When a client connects via `GET /mcp/sse`, it receives server-initiated notifications over a persistent SSE stream while issuing requests via `POST /mcp`. Operators should not conflate `/mcp/sse` with a distinct transport; the lifecycle of that endpoint is tied to the `http` transport above.

> **Streamable HTTP:** `--http` is OpenChrome's current Streamable HTTP transport surface. Use `POST /mcp` for JSON-RPC requests and `GET /mcp` or `GET /mcp/sse` for server-sent event streams.

---

## Stability commitments

A transport listed as **stable** carries the following guarantees across all patch and minor releases within the same major version:

1. **Message-shape compatibility.** The JSON-RPC 2.0 wire format, method names, and parameter shapes for all requests and responses remain unchanged. A client that works against v1.x.0 will continue to work against v1.x.y and v1.(x+1).0 without modification.

2. **Guaranteed events.** The following server-initiated notification types are guaranteed to remain available on all stable transports:
   - `notifications/tools/list_changed` — emitted when the tool list changes at runtime.
   - Lifecycle error notifications emitted via `console.error` to stderr (never to stdout, which carries MCP JSON-RPC).

3. **Minor-version allowance.** Within a major version, minor releases may:
   - Add new optional fields to existing messages (additive change, backward-compatible).
   - Add new notification types (clients that do not handle them ignore them per the MCP spec).
   - Change default port bindings, keepalive intervals, or internal routing — provided the observable wire protocol is unchanged.
   - Update authentication mechanisms in an additive way (new auth scheme available; existing scheme continues to work until a separate deprecation notice).

4. **What is NOT guaranteed.** Internal implementation details — HTTP handler internals, keepalive ping interval, rate-limiter queue depth, SSE connection book-keeping — are not part of the stability contract and may change in any release.

---

## Deprecation policy

**Minimum overlap window: 3 minor versions or 6 months, whichever is longer.**

When a transport (or a specific transport feature) is deprecated:

1. A GitHub issue is opened announcing the deprecation, the sunset version, and the recommended migration target.
2. The transport row in the [Supported transports](#supported-transports) table above is updated to `deprecated`, and the `Sunset` column is filled in.
3. Starting with the release that announces the deprecation, the server emits a boot-time deprecation warning on stderr whenever the deprecated transport is selected (see [Boot-time deprecation warnings](#boot-time-deprecation-warnings)).
4. The transport is removed no earlier than the later of:
   - Three minor version increments after the deprecation announcement (e.g., deprecated in v1.11.0 → earliest removal is v1.14.0), **or**
   - Six calendar months after the deprecation announcement date.

### Concrete example

> Suppose `http` were deprecated in v1.11.0 on 2026-05-12.
>
> - Earliest removal by minor-version rule: v1.14.0 (three increments: v1.11 → v1.12 → v1.13 → v1.14).
> - Earliest removal by calendar rule: 2026-11-12 (six months later).
> - Actual earliest removal: whichever date is later. If v1.14.0 ships on 2026-08-01 (before the 6-month mark), removal is deferred to a release on or after 2026-11-12. If v1.14.0 ships on 2026-12-01 (after the 6-month mark), removal may proceed in v1.14.0.
>
> No transport is currently deprecated. This example is illustrative only.

---

## Boot-time deprecation warnings

When the server starts with a deprecated transport selected, it emits a single line to stderr:

```
[openchrome] DEPRECATION WARNING: transport "<name>" is deprecated as of v<announcement-version>. Sunset: v<sunset-version>. Migrate before that release. See: https://github.com/shaun0927/openchrome/blob/main/docs/transport-lifecycle.md
```

This line:
- Is emitted via `console.error()` (stderr), never `console.log()` (stdout). stdout carries MCP JSON-RPC and must not be polluted.
- Contains the marker string `DEPRECATION WARNING` for easy `grep` in CI log scanners.
- Names the exact sunset version so operators have a concrete calendar target.
- Links to this document for migration instructions.

**Implementation note:** The warning emitter is not yet present in the codebase (as of v1.11.0). It will be added in a follow-up code PR when the first transport is actually deprecated. This section specifies the contract that implementation must satisfy.

**Current state:** No transport is deprecated in v1.11.0. Zero deprecation warnings are emitted at boot for any supported transport.

---

## Migration recipes

### stdio → Streamable HTTP

Switch from the default stdio mode to the Streamable HTTP daemon for multi-client or IDE use cases.

**Before (stdio):**
```bash
# Claude Code auto-configures stdio by default
openchrome serve --auto-launch
```

**After (Streamable HTTP daemon):**
```bash
# Start the HTTP daemon on port 3100 (default)
openchrome serve --auto-launch --http

# Or specify a custom port and bind address
OPENCHROME_HTTP_HOST=0.0.0.0 openchrome serve --auto-launch --http 4000

# With bearer-token authentication (recommended for non-loopback)
OPENCHROME_AUTH_TOKEN="$(openssl rand -hex 32)" openchrome serve --auto-launch --http 4000
```

Configure your MCP client to connect over Streamable HTTP:
```json
{
  "mcpServers": {
    "openchrome": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

For unauthenticated loopback-only development:
```bash
OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP=1 openchrome serve --auto-launch --http
```

### Streamable HTTP endpoint behavior

`--http` starts OpenChrome's current Streamable HTTP transport. Clients issue JSON-RPC requests with `POST /mcp`. Clients that need server-initiated notifications can open `GET /mcp` or `GET /mcp/sse` as an SSE stream. No additional migration flag is required; the `http` transport selector remains stable and has no sunset date.

---

## See also

- [docs/auth.md](auth.md) — API key store, bearer tokens, OAuth
- [docs/roadmap/portability-harness-contract.md](roadmap/portability-harness-contract.md) — core/pilot tier split and portability principles
- Issue [#839](https://github.com/shaun0927/openchrome/issues/839) — Streamable HTTP transport implementation history
