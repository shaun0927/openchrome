# Complex Real-World Task Completion (#1305)

Generated: 2026-05-15T23:53:20.745Z
Source: `benchmark/results/realworld-task-completion.json` (axis: `realworld-task-completion`).

## Claim scope

- Measurement mode: `deterministic-fixture`
- Claim scope: **scaffold-only; not a live competitive measurement**
- This report is the scaffold/local-fixture baseline for the real-world task-completion axis. It is **not** a live competitive win claim.
- #1261 remains the DX/supporting axis; this section is the primary task-completion axis.

## Metrics by library

| Library | Mode | Runs | Success | First-attempt success | Recovery success | Mean tool calls | Mean wall time ms | p95 wall time ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `openchrome` | `deterministic-fixture` | 5 | 100.0% | 80.0% | 100.0% | 9.6 | 1640 | 2175 |

## Task corpus

| Task | Tier | Max steps | Recovery? | Complexity tags |
| --- | --- | ---: | --- | --- |
| `rw-001-checkout-update-address` Update a checkout shipping address and verify recalculated summary | local-fixture | 14 | no | form-fill, stateful-ui, verification |
| `rw-002-search-filter-compare` Search, filter, compare two products, and extract the cheaper eligible item | local-fixture | 16 | no | search, filtering, extraction, decision |
| `rw-003-tab-research-synthesis` Use multiple tabs to synthesize two reference pages into one answer | stable-public-reference | 18 | no | tabs, reading, synthesis |
| `rw-004-selector-drift-recovery` Recover from selector drift while submitting a feedback form | recovery | 20 | yes | fault-recovery, form-fill, grounding |
| `rw-005-long-horizon-itinerary` Build and verify a multi-step itinerary from constrained options | long-horizon | 28 | no | long-horizon, filtering, decision, stateful-ui |

## Next measurement work

- Add live OpenChrome / playwright-mcp / Puppeteer MCP / browsermcp adapter rows only after real execution.
- Pin competitor and LLM versions before publishing live comparisons.
- Keep local deterministic fixture rows separate from live-web rows.
