# Benchmark Competitors — Version Pins

Part of the Competitive Benchmark Suite (Epic #1254, harness foundation #1255).

Every benchmark run records the exact version of each library it compares
against. This file is the human-readable registry; each result JSON also embeds
the same pins in its `competitors` block (see
`tests/benchmark/schemas/result.schema.json`). A version that is not pinned here
must not appear in a published benchmark number.

## Why pinning matters

The libraries in this list move fast. A comparison run in 2026-03 against a
library that shipped a major release in 2026-05 is not a comparison anyone can
defend or reproduce. Every row below carries a version, a commit (where
applicable), and the date it was measured.

## Scope — local open-source only

Hosted/paid services (Vercel Agent Browser, Browserbase, Firecrawl Cloud) are
intentionally **excluded**: their infrastructure differs from a local run, so
they are not reproducible here. See Epic #1254 "Non-goals".

## Competitor registry

> Versions below are the benchmark registry pins used by diagnostic/smoke
> runners. A row still needs live or recorded-real result evidence before it can
> become a headline comparison.

| Library | npm package | Pinned version | Commit | Measured at | Used by axes |
|---|---|---|---|---|---|
| OpenChrome | `openchrome-mcp` (this repo) | `1.12.4` | _per-run git SHA_ | _per run_ | all, #1299 |
| Playwright | `playwright` | `1.60.0` | — | 2026-05-18 smoke runtime | #A #C #D #E |
| Puppeteer | `puppeteer-core` / `rebrowser-puppeteer-core` | `23.10.3` | — | 2026-05-18 smoke runtime | #C #D #E #F |
| playwright-mcp | `@playwright/mcp` | `0.0.75` | `8116437ffcfee1309cebc07dd30cee37720d2d19` | 2026-05-15 | #A #B #F #1299-future-live |
| browser-rs-mcp | external binary `browser-rs` via `BROWSER_RS_BIN` | `0.1.13` | `6efa54fe428f1203967a9c760a27d0647d5474ee` | 2026-07-27 release asset, Apache-2.0, SHA-256: linux-x64 `ae0e4f5d2a4e6a90a0f050c50a55fcb86aab7cdda7d1ea2fec1aa54a321e3f1c`; macos-arm64 `618c75dc4f9c3297ba85d4e1ddaa9aaf67a671bc8abb393e1f64523dc084b310` | #A diagnostic smoke only |
| browser-use | `browser-use` (PyPI) | `0.12.6` | `329c67f069427e928ff81ad52415efdca7692007` | 2026-05-15 | #A #B #D #E |
| Crawlee | `crawlee` | `3.16.0` | `6c9cd2ff7e7d89ce7685e67f3f919f3cce0fa7a4` | 2026-05-15 | #A #C |

The `browser-rs-mcp` diagnostic adapter is stdio-only. Before a live row it
resolves `BROWSER_RS_BIN` to one canonical executable and uses that exact path
for digest, version, and process launch, with SHA-256 verified before the
binary is executed. It also forwards the exact approved Chrome/profile through
browser-rs' `AB_CHROME` / `AB_PROFILE` contract, rejects locked profiles, and
rejects `--port` / `AB_HTTP` because those settings switch the competitor to
HTTP instead of the benchmark's MCP stdio contract.

Pinned browser-rs v0.1.13 reduces `--connect <url>` to a local port before it
attaches. The adapter therefore accepts only an explicit `127.0.0.1` CDP
endpoint (or a numeric local port), probes that exact endpoint, and rejects
remote hosts, alternate protocols, credentials, and paths instead of risking
a smoke run against an unrelated local Chrome.

## Tokenizer

All token counts in the suite use **`cl100k_base`** via
[`js-tiktoken`](https://www.npmjs.com/package/js-tiktoken), wrapped by
`tests/benchmark/utils/tokenizer.ts`.

No vendor publishes the exact production tokenizer for current Claude models, so
an "exact Claude token count" is not obtainable. What the benchmark needs is a
single, deterministic, real tokenizer applied uniformly to every library's
payload — the cross-library delta is the signal, not the absolute count.
`cl100k_base` is a real BPE tokenizer, pure-JS (no native/wasm deps, works on
every CI OS), and stable. Reports must describe "tokens" as
"`cl100k_base` tokens", not "Claude tokens".

## LLM pin (LLM-driven axes only)

Axis #B (Agent Task Success) and future live #1299 episode-token runs may run against a real Claude model. The exact model
id + temperature are pinned per run and embedded in the result JSON's
`environment.llm` block. A mid-benchmark model update invalidates the axis and
forces a re-run.

| Axis | Model id | Temperature | Notes |
|---|---|---|---|
| #B Agent Task Success | TBD | TBD | pinned when #1257 runs against the real Claude adapter |
