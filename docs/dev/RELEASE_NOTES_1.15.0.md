# OpenChrome MCP 1.15.0

OpenChrome 1.15.0 serves the stateless MCP `2026-07-28` revision next to
existing (initialize-based) MCP clients, on stdio and on HTTP. The official
MCP TypeScript SDK 2.x now owns the protocol boundary; OpenChrome keeps
owning browser sessions, tools, authorization and policy. Browser state is
referenced through server-minted workspace handles instead of being inferred
from the connection.

**Which changes are new to you depends on what you run today:**

| You run | Last public version | New to you in this release |
| --- | --- | --- |
| npm `openchrome-mcp@latest` | 1.12.9 | Everything below, including the 1.13.0 and 1.14.0 changes |
| GitHub release tarball | v1.13.0 | The 1.14.0 and 1.15.0 changes |

1.13.0 was published only as a GitHub release, and 1.14.0 was prepared but
never published. This is the first npm release since 1.12.9. Tracking issue:
[#1673](https://github.com/shaun0927/openchrome/issues/1673).

## Before you upgrade

These changes can affect existing setups. Items marked (1.14.0) are new to
everyone, because 1.14.0 was never released.

- **Node.js 20 or newer is required** (was 18.17). The MCP SDK 2.x does not
  support Node 18; OpenChrome will not install or start there.
  `openchrome doctor` checks the new minimum.
- **stdio is served by the official SDK.** Legacy clients negotiate any
  version from `2024-10-07` through `2025-11-25`. The stdio client is still
  the local client and still uses the `default` browser session.
- **A cancelled request on stdio gets no response.** Earlier versions answered
  with `execution: "unknown"`. The MCP specification recommends silence for
  2025 revisions and requires it for `2026-07-28`. Sessionful legacy HTTP
  still answers with `execution: "unknown"` and `retryAllowed: false`.
- **HTTP requests without an `Mcp-Session-Id` receive no server-originated
  messages** (progress, logging, elicitation, list changes). Previously they
  could leak to another client's notification stream. `resources/subscribe`
  is rejected on such requests because they have no stream.
- **Legacy HTTP pins `MCP-Protocol-Version`.** A request may omit the header
  or send `2024-11-05`; any other value is rejected with `-32600` listing the
  supported versions. Legacy HTTP now answers `ping`.
- **`tools/list` is filtered by the caller's scopes** for legacy and modern
  clients: tools the caller cannot call are no longer listed. Reading an
  unknown resource returns `-32602`.
- **The runtime contract changed.** `capabilities.experimental["io.openchrome/runtime"]`
  now reports `contractVersion: 2`, `protocolMode: "dual-era"` and the
  supported versions per transport (`protocolSupport`). Clients that compared
  against the 1.14.0 values must accept the new ones.
- **Shutdown drains running tool calls** for up to 10 seconds (see
  [Shutdown and upgrades](#shutdown-and-upgrades)).
- (1.14.0) **Navigation without a `tabId` reuses an existing task tab only on
  an exact URL match, and does not reload it**, so text typed into the page is
  kept. Several matching tabs return `AMBIGUOUS_TAB`; pass `tabId` to choose.
  To send a tab to a different URL, pass its `tabId`.
- (1.14.0) **Recovery never opens a visible (headed) Chrome window on its
  own.** Navigation returns `HEADED_FALLBACK_REQUIRES_USER`; ask the user and
  retry with `allowHeadedFallback: true`.
- (1.14.0) **An attachment that silently changes to another browser endpoint
  is refused** with `CHROME_IDENTITY_CHANGED`.
- **New runtime dependencies:** `@modelcontextprotocol/server` 2.x and
  `@modelcontextprotocol/node` 2.x (which bring `zod` 4 and `hono`).

## MCP 2026-07-28 support

Full reference: [docs/mcp-2026-07-28.md](https://github.com/shaun0927/openchrome/blob/v1.15.0/docs/mcp-2026-07-28.md).

### Protocol

- Both eras are served on the same stdio process and the same HTTP endpoint.
  The SDK classifies each request as legacy or modern; `both` mode lets each
  transport negotiate independently.
- `server/discover`, the per-request `_meta` envelope (protocol version,
  client capabilities, client info, log level), `resultType` on results and
  cache hints on list and read results.
- Modern HTTP requests are stateless POSTs. `MCP-Protocol-Version`,
  `Mcp-Method` and `Mcp-Name` are checked against the JSON-RPC body before
  dispatch. Header values outside ASCII use the base64 sentinel form.
  `Mcp-Session-Id` is never issued, echoed or honoured, and modern `GET` and
  `DELETE` are rejected.
- Errors: `-32020` header mismatch, `-32021` missing client capability,
  `-32022` unsupported protocol version.
- `ping`, `logging/setLevel` and `resources/subscribe` are legacy-only.
  Modern clients use `subscriptions/listen` and the per-request log level.
- The supported methods per era are listed in the reference page. A test
  keeps that table in sync with `src/mcp/protocol-matrix.ts`.

| Method | `ttlMs` | Scope |
| --- | ---: | --- |
| `server/discover` | 300000 | public |
| `tools/list` | 30000 | private |
| `resources/templates/list` | 60000 | private |
| `resources/list`, `resources/read` | 0 | private |

### Workspace handles (new tool `oc_workspace`)

Modern requests carry no connection state, so browser state is referenced
explicitly:

1. `oc_workspace` with `action: "open"` returns a handle
   (`ocw_<runtime>_<random>`) bound to the caller's tenant.
2. Pass it as the `workspace` argument on browser tools. Modern `tools/list`
   marks it required on browser tools, on `worker` and on `crawl_status`, and
   offers it on other session-scoped tools. A `tabId` that belongs to one of
   the caller's workspaces also identifies it.
3. `list` shows the caller's workspaces. `close` needs the `write` scope and
   disposes of the browser session. A workspace is never closed or expired
   while a person controls one of its tabs.

Handles are checked before any browser session is created or touched:

| Code | Meaning |
| --- | --- |
| `WORKSPACE_REQUIRED` | A modern browser call has no handle, or names a legacy `sessionId` such as `default` |
| `WORKSPACE_UNKNOWN` | Not issued by this process, or already closed |
| `WORKSPACE_FORBIDDEN` | Issued to another tenant |
| `WORKSPACE_EXPIRED` | Idle longer than `OPENCHROME_WORKSPACE_IDLE_MS` (default 30 minutes) |
| `STALE_RUNTIME` | Issued by a previous OpenChrome process |

A handle names state; it is not a credential. Every call is still checked
against the authenticated tenant and the tool's scope. Legacy clients keep
their existing model (`default` on stdio, one session per `Mcp-Session-Id` on
HTTP) and may also pass a handle. `oc_task_start` of a browser tool needs a
handle on modern requests, like the tool itself.

### Client input during a tool call (MRTR)

Modern MCP does not let a server send requests to the client mid-call.
Elicitation, sampling and roots requests made by tools now return
`resultType: "input_required"` with `inputRequests` and a `requestState`.
The client retries the same call with the answers. Because answers gate side
effects (for example the confirmation before clearing cookies),
`requestState` is treated as attacker-controlled:

- It is HMAC-SHA256 signed with a per-process key and expires after
  `OPENCHROME_MRTR_STATE_TTL_SECONDS` (default 600).
- It is bound to the method, transport, tenant and API key (the token
  subject for JWT), and to the tool and a hash of its exact arguments.
- It can be used once. Replaying a retry asks again.
- Each answer is bound to the exact question. If the tool asks a different
  question on retry (for example 12 cookies instead of 5), the old answer is
  discarded.
- Answers that no input request asked for are ignored.

A tampered, expired or rebound state is rejected with `-32602` before the
tool runs. A server restart starts the flow over. Roots returned this way
apply to that request only and are never cached.

### Notifications

- `subscriptions/listen` delivers `toolsListChanged`, `resourcesListChanged`
  and resource updates. On HTTP, resource events reach only streams opened by
  the tenant that owns the resource.
- Progress and log messages flow only on the stream of the request that
  produced them. Log messages are sent only when the request sets a log level.

### Broker

Stdio hosts that connect through the broker (the default auto-elected owner)
get the same behaviour:

- Modern requests are forwarded with the modern headers.
- Streamed responses are relayed as they arrive.
- A cancellation closes the upstream stream.
- Legacy hosts behind the broker now receive progress notifications and
  elicitation requests; earlier versions dropped them. The broker's
  notification stream reconnects with capped backoff and logs failures.

## Isolation fixes

- Progress and elicitation from HTTP requests without a session were
  broadcast to other clients' notification streams, and a response from
  another client could be accepted. Each server-originated message now goes
  only to the client whose request produced it.
- With a combined stdio and HTTP owner (the default broker owner), messages
  for HTTP clients could be sent to the stdio host. The embedded API
  (`openchrome-mcp/server`, `both` mode) uses the same routing, and `stop()`
  now closes the HTTP listener.
- A sessionless HTTP request could share a cancellation key with the stdio
  client, so the same JSON-RPC id could collide or cancel another client's
  call. Each request now gets its own key.
- `notifications/resources/*` no longer carry `"id": null`; the official SDK
  rejected those messages.

## Shutdown and upgrades

- On SIGTERM, SIGINT, idle timeout or embedded `stop()`, new `tools/call`
  requests are refused with `SERVER_DRAINING` (`execution: "not_started"`,
  `retryAllowed: true`).
- Calls already running get up to `OPENCHROME_DRAIN_TIMEOUT_MS` (default
  10000) to finish. Calls still running at the deadline are cancelled and
  reported with `execution: "unknown"` and `retryAllowed: false`.
- OpenChrome never replays a mutation whose outcome is unknown. Check the page
  before repeating it.
- Background tasks from `oc_task_start` are drained the same way. On Windows,
  closing the console drains for at most 2 seconds before the OS ends the
  process.
- Tabs a person controls and borrowed user tabs stay open.
- Handles and requests that name a previous process (`STALE_RUNTIME`) are
  rejected before any browser action.
- **New doctor check:** `openchrome doctor` reports `running-version` as a
  warning when a running OpenChrome owner is older or newer than the installed
  package. Installing a package does not replace a running server.
- **Reconnecting a host:** the reference page has the steps for Claude Code,
  Codex CLI, OpenCode, the HTTP daemon and broker clients. After reconnecting,
  reload the tool list and open a new workspace. Rediscover tabs and re-verify
  borrowed user tabs.

## Chrome workflow changes (1.14.0)

- **Background automation tabs.** Automation tabs in the default and isolated
  contexts are created in the background through CDP. If that fails,
  OpenChrome does not fall back to a foreground tab, and it does not replace
  a closed isolated context with the default one. First launch, OS dialogs and
  explicit user requests may still show the window.
- **Borrowing existing user tabs.** With `OPENCHROME_USER_TABS=1` on an attach
  server, `tabs_context` with `scope: "browser"` lists the user's tabs.
  `worker` with `action: "borrow_tab"`, a `tabId` and the observed
  `expectedUrl` takes one over. `release_tab` returns it. Borrowed tabs are
  never closed by close, session end or TTL cleanup. This covers the default
  context and the local default tenant; there is no global lock between
  separate server processes. Seeing a tab does not verify the site login.
- **Serialized navigation.** Navigation without a `tabId` is serialized per
  session, worker, profile and lane, so concurrent requests for the same URL
  share one task tab.
- **Focus policy.** `OPENCHROME_FOCUS_POLICY=background-only` refuses even
  explicit `tabs_activate`, reveal and headed launch
  (`FOREGROUND_NOT_ALLOWED`). The default, `explicit-only`, allows display
  when the user asks. Unknown values allow no foreground display.
- **Connection diagnostics.** `oc_get_connection_info` with
  `host: "openchrome"` returns `browserConnection` with the connection state
  and hashed identifiers. `authentication: "unverified"` means login was not
  checked.
- **Runtime generations.** The runtime contract exposes `runtimeId` and the
  running package version. Clients that send `_meta["io.openchrome/runtimeId"]`
  get `STALE_RUNTIME` for requests aimed at a previous process. The field is
  not a credential and does not replace authorization.
- **Headless startup fix.** Managed headless Chrome now launches with the
  automation flag, which fixes isolated headless start failures. Headed launch
  options are unchanged.

## Opt-in local learning (1.14.0)

From PRs #1667 to #1671:

- Local events are stored only when `OPENCHROME_LEARNING=1` is set; learning
  is off by default. Events go to `~/.openchrome/learning/events.jsonl`
  (`OPENCHROME_LEARNING_DIR` and `OPENCHROME_LEARNING_STORE` override the
  location).
- Only two pilot decision types are recorded: `irreversible_policy` and
  `outcome_failure_triage`. General browser tool use is not collected.
- Only allow-listed fields are stored. No raw DOM, screenshots, form values,
  URLs or credentials.
- `openchrome learning <status|export|validate|eval|finetune|registry-list|registry-promote>`
  manages the store:
  - `export` drops unlabelled, non-anonymized, sensitive and invalid-choice
    records, and keeps identical task, state and choices in the same
    train/holdout split.
  - `eval` scores predictions produced elsewhere.
  - The adapter registry states are `candidate`, `shadow`, `assist` and
    `disabled`. No state grants authority.
  - `finetune` only writes a `blocked_scaffold` report.
- There is no online training and no remote upload. Promoting an adapter does
  not run a model inside the browser tools. No accuracy or speed gain is
  claimed.
- The Laya local provider is a development evaluation path for up to 20
  choices and needs a separately installed model. The G3 and Laya evaluation
  scripts are for source checkouts and are not part of the npm package.

## Changes since npm 1.12.9 (1.13.0)

npm users also receive the 1.13.0 changes
([release](https://github.com/shaun0927/openchrome/releases/tag/v1.13.0)):

- `oc_browser_control` shows active and recent operations. It lets you pause,
  drain, verify and explicitly resume a managed tab for manual input.
- Saved state is restored per browser context and does not overwrite newer
  live cookies or local storage.
- Active tabs are preserved at capacity. Target, screenshot and operation
  admission are bounded. Tabs a person holds survive idle and pressure
  cleanup.
- MCP cancellation is tracked per client session, recovery has deadlines, and
  writes with an uncertain outcome are not replayed.
- Explicit headless policy and lazy browser startup are kept. Startup
  blank-tab cleanup only touches the owned target.
- Tab metadata is read in bounded parallel batches. An early return in
  same-line JavaScript statements was fixed.

## New and changed configuration

| Variable | Default | Since | Purpose |
| --- | --- | --- | --- |
| `OPENCHROME_WORKSPACE_IDLE_MS` | 1800000 | 1.15.0 | Idle time before a workspace handle expires |
| `OPENCHROME_MRTR_STATE_TTL_SECONDS` | 600 | 1.15.0 | Lifetime of a signed `requestState` |
| `OPENCHROME_DRAIN_TIMEOUT_MS` | 10000 | 1.15.0 | How long shutdown waits for running calls |
| `OPENCHROME_USER_TABS` | off | 1.14.0 | `1` allows listing and borrowing user tabs on attach servers |
| `OPENCHROME_FOCUS_POLICY` | `explicit-only` | 1.14.0 | `background-only` refuses all foreground display |
| `OPENCHROME_LEARNING` | off | 1.14.0 | `1` enables local learning events |
| `OPENCHROME_LEARNING_DIR`, `_STORE`, `_REGISTRY`, `_TASKS`, `_MODE` | see docs | 1.14.0 | Learning storage and scope |

## Not in this release

- Zero-downtime upgrades and workspace handles that survive a restart. After a
  restart, open a new workspace.
- Browser control spread across several daemons. A browser session belongs to
  one process.
- The MCP Tasks extension and MCP Apps.
- A `404` for an unknown legacy `Mcp-Session-Id`. The legacy behaviour is kept
  so broker re-election keeps working.
- The official conformance suite (0.1.16) has no `2026-07-28` scenarios yet.
  Modern behaviour is tested with the official SDK 2.x client against the real
  server.

## Verification

- Every pull request in the stack was reviewed independently, and each review
  finding was fixed and approved on re-review. The review log and the
  per-branch CI runs are in
  [PREPUBLISH_1.15.0.md](https://github.com/shaun0927/openchrome/blob/v1.15.0/docs/dev/PREPUBLISH_1.15.0.md).
- CI runs the full Jest suite and a new `mcp-conformance` job (Node 22). That
  job runs the six applicable scenarios of `@modelcontextprotocol/conformance`
  0.1.16 against the built server.
- The installed-package acceptance workflow runs the package outside the
  checkout, with real headless Chrome, on Ubuntu and Windows. It covers legacy
  clients and an SDK 2.x client pinned to `2026-07-28`: negotiation, the
  runtime contract, workspace handles and a browser round trip.
- `npm publish --dry-run` passed on the release candidate.

Not certified by these tests: site SSO/MFA flows, long-running memory
stability and every host configuration.

## Pull requests

- 1.14.0: #1667, #1668, #1669, #1670, #1671, #1672
- 1.15.0: #1674 (message isolation), #1675 (MCP 2026-07-28 through SDK 2.x),
  #1676 (workspace handles), #1677 (MRTR request state), #1678 (drain and
  upgrade contract), #1679 (release preparation)
