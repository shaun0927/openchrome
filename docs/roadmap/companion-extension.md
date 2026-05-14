---
status: draft
issue: 900
created: 2026-05-12
tier: pilot (proposed)
depends_on: portability-harness-contract.md (P1-P5)
---

# RFC: Optional Companion Chrome Extension for chrome.* APIs

> **Status**: draft — gathering alignment on the 7 open questions below. No code will be written under this RFC until it is marked `accepted` or `accepted-phased`.
> **Tracking issue**: [#900](https://github.com/shaun0927/openchrome/issues/900)

> **Target branch (when implementation phases land)**: `develop` (per `CLAUDE.md`). This RFC itself targets no branch; it lives as an issue + a docs commit if accepted.

---

> **This is an RFC, not an implementation issue.** It exists to gather alignment before code is written. The "Acceptance criteria" section below is for the **RFC document**, not for a code merge. Implementation issues will be split out per phase only after this RFC is accepted.

## Why

OpenChrome cannot reach Chrome's first-party data surfaces — `chrome.history`, `chrome.bookmarks`, `chrome.downloads`, `chrome.tabGroups`, `chrome.contextMenus` — because the Chrome DevTools Protocol does not expose them. `hangwin/mcp-chrome` reaches them by being a browser extension (it lives inside the user's Chrome and calls `chrome.*` APIs directly).

This data is high-signal for agents:

- "What did the user research last week on this topic?" → `chrome.history.search`.
- "Open the user's tagged-as-`work` bookmark folder" → `chrome.bookmarks.getTree`.
- "What did the agent download in the last run?" → `chrome.downloads.search`.

Today an openchrome agent must either ask the user, browse manually, or guess. The capability gap is real.

There are two architectures that close it:

1. **Pivot to extension-only** (mcp-chrome's choice). Rejected: it breaks openchrome's parallel-tab model (one extension instance per Chrome, openchrome runs N isolated tabs), and breaks `--server-mode` (no extension can install in a freshly-spawned profile each run). Not on the table.

2. **Optional companion extension + local IPC bridge**, gated behind `--pilot --companion-extension`, with zero impact when not installed. This RFC.

## The proposal

Ship a separate npm package and Chrome extension:

- **`openchrome-companion-extension`** — a small WebExtension (MV3) with a service worker that connects to the registered Native Messaging host and handles reconnects after MV3 worker suspension. Distributed via:
  - the Chrome Web Store under the openchrome account,
  - and an unpacked-load path documented for power users.
- **`@openchrome/companion-bridge`** (lives in this monorepo under `packages/companion-bridge/`) — a small Node module that registers the Native Messaging host on first run, exposes a local JSON IPC endpoint to `openchrome-mcp` (Unix domain socket on macOS/Linux, named pipe on Windows), and proxies Native Messaging frames to the extension for `chrome.history`, `chrome.bookmarks`, `chrome.downloads` APIs.

In `openchrome-mcp`, three new tools are registered **only when** the `--companion-extension` CLI flag is set and the `--pilot` flag is set:

- `companion_history_search`
- `companion_bookmarks_query`
- `companion_downloads_search`

Each is a thin pass-through to the companion bridge over local JSON IPC. The extension side is responsible for permission prompts and rate limiting; the bridge owns the Chrome Native Messaging host process.

## Architecture sketch

```
Agent
  │ MCP tool call: companion_history_search {query:"OpenChrome"}
  ▼
openchrome-mcp (pilot tier)
  │ JSON over local IPC (Unix socket or Windows named pipe)
  ▼
companion-bridge (Node module, registered as a Native Messaging host)
  │ stdio frames (4-byte length-prefixed JSON, per Chrome spec)
  ▼
Chrome browser
  │ chrome.runtime.connectNative
  ▼
openchrome-companion-extension (MV3 service worker)
  │ chrome.history.search({text:"OpenChrome", maxResults:50})
  ▼
chrome.history → ranked HistoryItem[] → back up the stack
```

**Key invariants**:

1. Without `--pilot --companion-extension`, `tools/list` is byte-identical to without this feature. **P2 hard requirement.**
2. The companion is **not** required to be installed for openchrome itself to work. The CLI flag enables the tools; tools are registered with `available:false` and return a structured `{error:'companion_not_installed', remediation:'...'}` if the bridge cannot reach the extension.
3. **No outbound LLM calls** from any companion component. The extension reads chrome.* APIs and replies with facts. **P3 + P4.**
4. Native Messaging is used only across the Chrome extension ↔ native host boundary. The `openchrome-mcp` ↔ `companion-bridge` boundary uses local JSON IPC such as a Unix domain socket or Windows named pipe; no HTTP server on the extension side, no localhost ports owned by the extension.
5. Native Messaging host registration is opt-in: `openchrome companion install` writes the manifest under the platform's per-user directory after explicit user consent.
6. The companion extension's manifest declares the minimum permission set needed for the three APIs: `history`, `bookmarks`, `downloads`, `nativeMessaging`. **Not** `tabs`, **not** `webRequest`, **not** `debugger` — those overlap openchrome's CDP surface and are intentionally out of scope.
7. The bridge must tolerate an idle MV3 service worker. It cannot assume the host can wake the extension on demand; when the IPC endpoint receives a tool call and no extension port is active, it returns a structured `companion_extension_disconnected` error with remediation that asks the user to open/reload Chrome or the extension, then retries after the extension reconnects.

## Why this fits the contract

The two existing PR-queue families that resemble this idea — the LLM merge requester (rejected → #776) and any "we add Anthropic SDK" proposal — both fail because they require **server-side decisions** or **outbound network egress**. This proposal fails neither:

- The companion reads facts (HistoryItem, BookmarkTreeNode, DownloadItem) and returns them.
- The bridge transports JSON.
- The server adds three pilot tools, gated by an explicit dual flag.

The closest precedent is the current pilot/handoff token: a feature that ships in the pilot tier, behind explicit consent, with byte-parity off-behavior.

## What this RFC asks for

A decision on the following before any implementation issue is opened:

1. **Distribution model for the extension**. Web Store account ownership, signing, and unpacked-load instructions. Who maintains the extension publishing pipeline?
2. **Permission ratchet**. The proposed permission set is `history`, `bookmarks`, `downloads`, `nativeMessaging`. Is that the floor we are willing to ship? Adding any later requires republishing.
3. **Bridge package boundary**. The current monorepo holds only `openchrome-mcp`. Adding `packages/companion-bridge/` (and possibly `packages/companion-extension/`) requires a monorepo decision (npm workspaces? lerna?). What is acceptable?
4. **Threat model**. The extension has read access to the user's full history. If openchrome is compromised, does the threat model assume the user's history is also compromised? What auditing surface (extension UI, log file) is required?
5. **Cross-platform Native Messaging and IPC quirks**. mcp-chrome's open issues document recurring failures with nvm/asdf/volta/fnm-managed Node binaries (the manifest's `path` to the Node script changes with version). The local IPC hop also needs per-platform socket/pipe path handling. What is the fallback story?
6. **Tools opt-in granularity**. Single `--companion-extension` flag, or per-tool flags (`--companion-history`, `--companion-bookmarks`)?
7. **MV3 service-worker lifetime**. The MV3 worker terminates after inactivity, and the native host cannot wake a dormant service worker by itself. Is the documented behavior acceptable: tools fail closed with `companion_extension_disconnected` until Chrome wakes the extension and it reconnects, with retry handled by the next tool call?

## Phased plan (post-RFC)

Only opened as separate issues if this RFC is accepted.

- **Phase 1**: `companion-bridge` skeleton, local IPC endpoint, Native Messaging handshake, manifest installer (`openchrome companion install/uninstall`). No extension yet — test against a hand-rolled echo extension.
- **Phase 2**: `openchrome-companion-extension` MV3 stub with `chrome.history.search` only. Single round-trip end-to-end.
- **Phase 3**: `chrome.bookmarks` + `chrome.downloads`. Tool surface and schemas finalized.
- **Phase 4**: Web Store submission, signing, auto-update channel.
- **Phase 5**: Documentation, `openchrome doctor` integration (`companion-status` check), one-page Trust & Safety doc.

Each phase has its own acceptance criteria and `real verification` plan, written when the issue is opened.

## Acceptance criteria for this RFC

(Not for code merge — for the RFC document itself.)

- [ ] The seven questions above each have a documented decision (link to comment thread or `docs/roadmap/companion-extension-rfc.md`).
- [ ] At least one maintainer comment confirms alignment with `docs/roadmap/portability-harness-contract.md` P1–P5.
- [ ] A `BACKED-OUT-IF` clause documents what observation would cause us to cancel Phase 1 (e.g., "if the Native Messaging manifest path or local IPC endpoint proves unreliable on more than two of {macOS, Windows, Linux, nvm, volta} in a 1-week dogfood, we cancel and reopen the design").
- [ ] If accepted, the RFC is committed under `docs/roadmap/companion-extension.md` with status `accepted` or `accepted-phased`; if rejected, the RFC is committed with status `rejected` and a reason. Either way it leaves an artifact.

## Real verification (when implementation lands)

Verification for each implementation phase belongs to that phase's issue. The pattern, sketched here for reference:

- **Phase 1 verification**: `openchrome companion install` writes the manifest at the documented platform path; `openchrome companion uninstall` removes it. Idempotent. Tested on macOS / Ubuntu / Windows in CI.
- **Phase 2 verification**: `mcp__openchrome__companion_history_search` with query="OpenChrome" returns a non-empty array on a profile that has visited the repo. With the companion uninstalled, the same call returns `{error:'companion_not_installed'}` with the documented remediation. With Chrome open but the MV3 worker dormant/disconnected, the same call returns `{error:'companion_extension_disconnected'}` until the extension reconnects.
- **Phase 3 verification**: `mcp__openchrome__companion_bookmarks_query` returns the bookmark tree shape from the Chrome API verbatim; `mcp__openchrome__companion_downloads_search` returns downloads filtered by `query.startedAfter`.
- **Phase 5 verification**: `openchrome doctor` reports `companion-status` as `ok` / `not-installed` / `version-mismatch`.

## Out of scope (forever)

- Extension-side LLM calls of any kind (P3/P4).
- The companion replacing CDP for any tool currently in core (P2 — would change off-state behavior).
- A "headless companion" — MV3 cannot run without a Chrome instance, and we are not adding Firefox/Edge variants.
- Cross-device sync of the companion's state (Chrome's own sync already covers history/bookmarks).

## Why this is worth doing despite the cost

The cost is real: a second deliverable (extension), a new permission story, a Native Messaging support load. mcp-chrome's open issues show roughly 30% of user-facing bugs trace back to Native Messaging setup. The benefit:

- A class of agentic workflows openchrome currently cannot do at all becomes possible (history-aware navigation, bookmark-driven launchers, download-aware follow-ups).
- The skill graph (M1+M4) gains a richer signal channel: "the user has been to this URL before / has it bookmarked" is one of the strongest priors for action.
- Pilot tier was created for exactly this kind of opt-in, off-by-default richness. This is its second clear test (handoff token was the first).

If after RFC discussion the cost outweighs the benefit, we close as `rejected` and document why — that is a valid outcome of an RFC.

## Effort

- RFC discussion + write-up: 1–2 weeks calendar time.
- If accepted, Phases 1–5: estimated L–XL (multi-month). To be re-estimated when each phase is opened.

## References

- mcp-chrome `app/native-server/src/native-messaging-host.ts`, `app/chrome-extension/` (MIT).
- mcp-chrome `docs/TROUBLESHOOTING.md` — failure modes we should not repeat.
- `docs/roadmap/portability-harness-contract.md` P1–P5.
- Companion to #776 (LLM merge requester moved to separate package): same principle (heavy/optional things live outside the core server), different mechanism.
