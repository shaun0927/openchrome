# Developer Experience (#1261) — competitive report

Generated: 2026-05-15T09:23:53.402Z
Source: `benchmark/results/dx.json` (axis: `developer-experience`).

## Rule of two charts
Issue #1261 forbids a single composite radar — LOC trivially favors MCP servers, schema metrics are N/A for non-MCP libraries. The DX section therefore splits into:
- **MCP DX** (this chart): libraries that ship an MCP server, scored across all rubrics
- **Framework DX** (next chart): all libraries including raw frameworks, **LOC only** (the only metric every library participates in)

## MCP DX
| Library | form-fill | navigate-and-read | Schema completeness | Error actionability |
| --- | ---: | ---: | ---: | ---: |
| `openchrome` | 10 | 7 | *pending* | *pending* |

See `chart-dx-mcp.svg` for the visual companion.

## Framework DX
LOC per task. Composites computed only over axes where every library participates — here that's LOC alone.

| Library | form-fill | navigate-and-read | median LOC |
| --- | ---: | ---: | ---: |
| `openchrome` | 10 | 7 | 8.5 |
| `playwright` | 12 | 10 | 11 |
| `puppeteer` | 16 | 10 | 13 |

See `chart-dx-framework.svg` for the visual companion.

## Pending rubrics
- Schema completeness: requires MCP `tools/list` introspection per library (issue #1261 mentions `lint:tool-schemas` as the OpenChrome side). Lands in the next-session follow-up.
- Error actionability: requires running induced failures through each library and scoring the returned errors against the rubric in `dx-rubrics.ts`. Same follow-up.

## Headline
Framework DX LOC winner (lower is better): **`openchrome`** at median 8.5 LOC.
