---
description: >
  OpenChrome browser automation skill. Use when the user asks to navigate, click,
  read, screenshot, crawl, or automate anything in a real Chrome browser. Covers
  parallel lanes, authenticated scraping, outcome contracts, and skill replay.
---

# OpenChrome

OpenChrome is an MCP server that controls your real, already-logged-in Chrome
through the CDP. It wraps the browser API with a hint engine, circuit breaker,
auto-recovery runtime, and token-efficient page serialization.

<!-- Shared skill body — used by both Claude Code (.claude-plugin) and Codex
     (.codex-plugin) manifests. Both manifests point to skills/ at the repo root,
     so this file is the single source of truth (SSOT) for skill content. -->

## What you can do

- **Navigate** — `navigate url=<url>` opens a URL in a managed tab.
- **Read** — `read_page mode=dom` returns a compact, ~5–15x token-cheaper
  serialization of the page. Use `ref_N` handles in follow-up actions.
- **Interact** — `interact`, `fill_form`, `form_input`, `act` for clicking,
  typing, and high-level actions.
- **Screenshot** — `computer` returns a screenshot of the current viewport.
- **Parallel lanes** — open multiple tabs with `oc_lane_create`; work them
  concurrently with the same Chrome session and existing cookies.
- **Outcome contracts** — `oc_assert` checks page state against a JSON contract
  (url equals, dom_count ≥ N, dom_text contains …) and returns pass / fail /
  inconclusive without guessing.
- **Skills** — `oc_skill_record` / `oc_skill_recall` store and replay procedural
  memory across sessions.
- **Crawling** — async `crawl_start` / `crawl_status` / `crawl_cancel` with
  cursor pagination.

## Setup

```bash
npm install -g openchrome-mcp
openchrome setup               # Claude Code
openchrome setup --client codex   # Codex CLI
```

Restart your MCP client. Chrome auto-launches on the first tool call.

## Key tools

| Tool | Purpose |
|---|---|
| `navigate` | Open a URL |
| `read_page` | Read page content (dom / markdown / screenshot) |
| `interact` | Click / type on an element |
| `oc_assert` | Verify page state against a contract |
| `oc_lane_create` | Open a parallel tab lane |
| `oc_skill_record` | Store a reusable step sequence |
| `oc_skill_recall` | Retrieve steps for a domain |
| `crawl_start` | Start an async crawl job |
| `oc_evidence_bundle` | Snapshot DOM + screenshot + network + console |
| `oc_diff` | Compare two evidence bundles |

Full catalogue: [`docs/agent/capability-map.md`](../../docs/agent/capability-map.md).
