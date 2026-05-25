# Complex Real-World Task Completion (#1305)

Generated: 2026-05-17T16:29:11.242Z
Source: `benchmark/results/realworld-task-completion.json` (axis: `realworld-task-completion`).

## Claim scope

- Measurement mode: `deterministic-fixture`
- Claim scope: **stress scaffold-only; faults injected inside local deterministic tasks, not a live competitive measurement**
- Stress mode: **yes** — recovered means the final task postcondition passed after an injected fault.
- This report is the scaffold/local-fixture baseline for the real-world task-completion axis. It is **not** a live competitive win claim.
- Claim eligibility tier: **diagnostic-only**; eligible: **no**.
  - Blocker: measurement mode scaffold is not headline-eligible; use live or recorded-real
  - Blocker: sample count 6 is below aggregate threshold N >= 10
  - Blocker: LLM model/settings/budgets are not pinned
- Headline gate: **blocked**. Use `node benchmark/generate-realworld-task-completion-section.mjs --require-headline` in release workflows to enforce this.
- #1261 remains the DX/supporting axis; this section is the primary task-completion axis.

## Fault stress rows

| Library | Task | Fault | Injected step | Recovered by final postcondition | Recovery steps | Recovery ms | Chrome RSS | Zombies | Evidence |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| `openchrome` | `rw-001-checkout-update-address` | delayed-dom | 3 | yes | 2 | 220 | 96000000 | 0 | delayed-dom injected at step 3 |
| `openchrome` | `rw-002-search-filter-compare` | network-stall | 4 | yes | 2 | 250 | 96512000 | 0 | network-stall injected at step 4 |
| `openchrome` | `rw-003-return-authorization` | target-closed | 5 | yes | 2 | 280 | 97024000 | 0 | target-closed injected at step 5 |
| `openchrome` | `rw-004-selector-drift-recovery` | selector-drift | 2 | yes | 2 | 310 | 97536000 | 0 | selector-drift injected at step 2 |
| `openchrome` | `rw-005-long-horizon-itinerary` | cdp-disconnect | 8 | yes | 2 | 340 | 98048000 | 0 | cdp-disconnect injected at step 8 |
| `openchrome` | `rw-006-dynamic-ui-inventory` | delayed-dom | 2 | yes | 2 | 370 | 98560000 | 0 | delayed-dom injected at step 2 |

## Metrics by library

| Library | Mode | Runs | Success | First-attempt success | Recovery success | Mean tool calls | Mean wall time ms | p95 wall time ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `openchrome` | `deterministic-fixture` | 6 | 100.0% | 0.0% | 100.0% | 12.5 | 2125 | 2600 |

## Task corpus

| Task | Category | Tier | Max steps | Recovery? | Reset contract | Postcondition evidence required |
| --- | --- | --- | ---: | --- | --- | --- |
| `rw-001-checkout-update-address` Update a checkout shipping address and verify recalculated summary | form_fill | local-fixture | 14 | no | Reloading the local checkout fixture restores the original address and order summary. | saved city/postal text, summary destination text, recalculated shipping/tax values |
| `rw-002-search-filter-compare` Search, filter, compare two products, and extract the cheaper eligible item | info_retrieval | local-fixture | 16 | no | Reloading the fixture clears query text, filters, comparison tray, and selected answer. | active filters, two compared item names/prices, selected cheaper eligible item |
| `rw-003-return-authorization` Complete a mock return authorization transaction | transactional_mock | local-fixture | 18 | no | Reloading the fixture clears selected items, reason, confirmation state, and generated authorization number. | confirmation banner, authorization number, returned item name |
| `rw-004-selector-drift-recovery` Recover from selector drift while submitting a feedback form | recovery | recovery | 20 | yes | Reloading the fixture restores the pre-drift selector state and clears submitted feedback. | selector failure/fallback note, feedback receipt text, submitted email/value |
| `rw-005-long-horizon-itinerary` Build and verify a multi-step itinerary from constrained options | long_horizon | long-horizon | 28 | no | Reloading the fixture clears filters, selected legs, cart state, and itinerary summary. | applied constraints, selected option id, summary total and transit time |
| `rw-006-dynamic-ui-inventory` Handle delayed dynamic inventory controls and verify saved selection | dynamic_ui | local-fixture | 18 | no | Reloading the fixture returns controls to the loading state and clears the saved variant summary. | hydration complete marker, selected variant label, saved selection summary |

## Final postcondition evidence

| Library | Task | Success | Final postcondition evaluated | Evidence |
| --- | --- | --- | --- | --- |
| `openchrome` | `rw-001-checkout-update-address` | yes | yes | rw-001-checkout-update-address: saved city/postal text + summary destination text + recalculated shipping/tax values observed after fixture-reset |
| `openchrome` | `rw-002-search-filter-compare` | yes | yes | rw-002-search-filter-compare: active filters + two compared item names/prices + selected cheaper eligible item observed after fixture-reset |
| `openchrome` | `rw-003-return-authorization` | yes | yes | rw-003-return-authorization: confirmation banner + authorization number + returned item name observed after fixture-reset |
| `openchrome` | `rw-004-selector-drift-recovery` | yes | yes | rw-004-selector-drift-recovery: selector failure/fallback note + feedback receipt text + submitted email/value observed after fixture-reset |
| `openchrome` | `rw-005-long-horizon-itinerary` | yes | yes | rw-005-long-horizon-itinerary: applied constraints + selected option id + summary total and transit time observed after fixture-reset |
| `openchrome` | `rw-006-dynamic-ui-inventory` | yes | yes | rw-006-dynamic-ui-inventory: hydration complete marker + selected variant label + saved selection summary observed after fixture-reset |

## Next measurement work

- Add live OpenChrome / playwright-mcp / Puppeteer MCP / browsermcp adapter rows only after real execution.
- Pin competitor and LLM versions before publishing live comparisons.
- Keep local deterministic fixture rows separate from live-web rows.
