# Shared-profile trust model

Shared-profile broker mode is a **same-trust-zone** feature. It is intended for local workflows where the connected MCP clients are operated by the same user or team and are allowed to share the same Chrome cookies, authenticated sessions, storage, and visible page state.

It is not a hosted browser-cloud isolation boundary.

## Trust boundary

Use shared-profile broker mode only when all connected clients are trusted to access the same browser profile.

Use separate ports/profiles when clients are unrelated, untrusted, externally exposed, or belong to different tenants:

```bash
openchrome setup --client claude --port 9223 --user-data-dir ~/.openchrome/profiles/claude
openchrome setup --client codex --port 9224 --user-data-dir ~/.openchrome/profiles/codex
```

## Identity model

Policy decisions use host-neutral identifiers:

- `clientId`: MCP/HTTP client identity when known.
- `sessionId`: OpenChrome session identity.
- `workerId` / `laneId`: task subdivision identity.
- `targetId`: Chrome target/tab identity.
- target leases: the broker-side ownership record tying targets to the identifiers above.

No policy may privilege Claude, Codex, OpenCode, or an unknown MCP host. The same rules apply to every client.

## Diagnostics and redaction

Broker diagnostics should not expose sensitive cross-tenant details by default. Lease diagnostics may show ownership metadata, but URLs, titles, cookies, storage, screenshots, and page text must be omitted or redacted unless policy explicitly allows cross-tenant diagnostics.

Environment flags:

- `OPENCHROME_SHARED_PROFILE_UNTRUSTED=1`: declare that clients are not in one trust zone; shared-profile broker startup should be rejected and isolated profiles should be used.
- `OPENCHROME_SHARED_PROFILE_CROSS_TENANT_DIAGNOSTICS=1`: allow cross-tenant lease diagnostics for trusted local debugging.

## HTTP daemon default

A shared-profile HTTP broker must bind to loopback by default and use existing HTTP auth controls before exposure beyond localhost. Do not expose a shared profile broker on a public network.

## Required separate-profile cases

Use separate profiles/ports for:

- different users;
- CI jobs from different trust domains;
- untrusted agents;
- public or remote HTTP clients;
- workflows that must not share cookies/history/storage;
- compliance or audit boundaries.
