# Token Efficiency (#1256) — competitive matrix report

Generated: 2026-05-15T06:08:01.226Z
Source: `benchmark/results/token-efficiency.json` (axis: `token-efficiency`, schema 1.0.0).
Tokenizer: `cl100k_base`.

## Methodology
- Each `(library × fixture)` cell records median payload tokens, retention rate, and compression ratio over N samples.
- Retention is scored against the ≥ 12-field ground-truth per fixture per `RUBRIC.md`. A raw HTML dump does NOT score retention by substring match — only structured field-keyed extraction counts.
- Live-only cells (real Chrome / Python) are explicitly annotated when skipped in `--skip-live` mode; they are never plotted as 0 or omitted silently.

## Per-library × per-archetype median tokens
Lower is better. "(skip)" = library not measured in this run.

| Library | docs | ecommerce | news | search-results | spa |
| --- | ---: | ---: | ---: | ---: | ---: |
| `browser-use-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `crawlee-cheerio` | 2691 | 3571 | 4768 | 3314 | 4863 |
| `deterministic-static` | 88 | 78 | 96 | 157 | 96 |
| `openchrome-readpage-ax` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `openchrome-readpage-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-a11y` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-content` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-innertext` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-mcp-snapshot` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |

## Per-library × per-archetype median retention
Higher is better. "(skip)" = library not measured in this run.

| Library | docs | ecommerce | news | search-results | spa |
| --- | ---: | ---: | ---: | ---: | ---: |
| `browser-use-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `crawlee-cheerio` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `deterministic-static` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `openchrome-readpage-ax` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `openchrome-readpage-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-a11y` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-content` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-innertext` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-mcp-snapshot` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |

## Per-library × per-archetype median compression
Higher is better (× vs raw HTML tokens).

| Library | docs | ecommerce | news | search-results | spa |
| --- | ---: | ---: | ---: | ---: | ---: |
| `browser-use-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `crawlee-cheerio` | 2.4× | 2.4× | 2.4× | 2.4× | 2.3× |
| `deterministic-static` | 73.9× | 109.1× | 116.8× | 51.1× | 116.8× |
| `openchrome-readpage-ax` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `openchrome-readpage-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-a11y` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-content` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-innertext` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-mcp-snapshot` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |

## Per-archetype upper-left winner
Lowest tokens at the max retention measured in this run.

| Archetype | Winner library | Retention |
| --- | --- | ---: |
| docs | `deterministic-static` | 100.0% |
| ecommerce | `deterministic-static` | 100.0% |
| news | `deterministic-static` | 100.0% |
| search-results | `deterministic-static` | 100.0% |
| spa | `deterministic-static` | 100.0% |

## Cells skipped in this run
350 cells did not run because they are live-only and `OPENCHROME_BENCH_LIVE=1` was not set.

Skipped libraries:
- `browser-use-dom`
- `openchrome-readpage-ax`
- `openchrome-readpage-dom`
- `playwright-a11y`
- `playwright-content`
- `playwright-innertext`
- `playwright-mcp-snapshot`

To run them, set `OPENCHROME_BENCH_LIVE=1` and re-run `npm run bench:tokens`. Today the live cells are scaffolded but not yet wired to their real Chrome / Python integrations — that is queued for the next session.

## Headline
Across 5 archetypes with measured cells, **`deterministic-static`** sits in the upper-left of the scatter on 5 / 5.

See `chart-tokens-scatter.svg` for the per-archetype scatter view.
