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
| browser-use | `browser-use` (PyPI) | `0.12.6` | `329c67f069427e928ff81ad52415efdca7692007` | 2026-05-15 | #A #B #D #E |
| Crawlee | `crawlee` | `3.16.0` | `6c9cd2ff7e7d89ce7685e67f3f919f3cce0fa7a4` | 2026-05-15 | #A #C |
| Online-Mind2Web | HuggingFace dataset `osunlp/Online-Mind2Web` (CC-BY 4.0) | dataset commit `7ab0fc3b5e0420f6a74c4e0f0faebc1f3eddb0c1` | `7ab0fc3b5e0420f6a74c4e0f0faebc1f3eddb0c1` | TBD-by-runner-PR | #B (future — Part 2 of #1427) |

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
