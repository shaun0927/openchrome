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

> Versions below are **placeholders** — each is pinned to an exact version +
> commit + measurement date by the sub-issue that first benchmarks against it
> (#1256–#1261). Until a row is pinned by a real run, treat it as TBD.

| Library | npm package | Pinned version | Commit | Measured at | Used by axes |
|---|---|---|---|---|---|
| OpenChrome | `openchrome-mcp` (this repo) | _repo HEAD_ | _per-run git SHA_ | _per run_ | all |
| Playwright | `playwright` | TBD | — | TBD | #A #C #D #E |
| Puppeteer | `puppeteer` | TBD | — | TBD | #C #D #E #F |
| playwright-mcp | `@playwright/mcp` | TBD | — | TBD | #A #B #F |
| browser-use | `browser-use` (PyPI) | TBD | — | TBD | #A #B #D #E |
| Crawlee | `crawlee` | TBD | — | TBD | #A #C |

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

Axis #B (Agent Task Success) runs against a real Claude model. The exact model
id + temperature are pinned per run and embedded in the result JSON's
`environment.llm` block. A mid-benchmark model update invalidates the axis and
forces a re-run.

| Axis | Model id | Temperature | Notes |
|---|---|---|---|
| #B Agent Task Success | TBD | TBD | pinned when #1257 runs against the real Claude adapter |
