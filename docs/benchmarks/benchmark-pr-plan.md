# Benchmark PR plan

This plan validates the remaining benchmark work as benchmark-harness work only.
Competitor integrations must stay under `tests/benchmark/`, `benchmark/`,
`scripts/bench/`, or benchmark docs. They must invoke real external tools or
emit explicit skip rows; they must not reimplement competitors inside
OpenChrome product/core code.

## PR dependency order

| PR | Scope | Issues | Why this order |
| --- | --- | --- | --- |
| PR1 | Benchmark contract hardening and headline safety gates | #1255, #1310 | Defines shared row status, claim eligibility, stale-artifact visibility, and no-diagnostic-headline gates used by every later PR. |
| PR2 | Competitor smoke matrix and version pin enforcement | #1255, #1302 | Establishes which external competitors can run and records exact versions before any comparison rows are meaningful. |
| PR3 | Finish non-LLM benchmark measurement gaps | #1256, #1258, #1260, #1261 | Advances API-key-free axes first so the contract can be exercised without paid LLM runs. |
| PR4 | Controlled real-world task corpus and postcondition contracts | #1300, #1304 | Stabilizes task definitions and final postconditions before expensive live LLM or reliability stress runs. |
| PR5 | Real LLM runner, repetitions, budget, and token-cost accounting | #1257, #1299, #1301 | Adds the opt-in paid/live execution path after tasks and contract semantics are stable. |
| PR6 | Native competitor execution for playwright-mcp and browser-use | #1302, #1257 | Wires real external competitor loops using the same LLM/repetition contract; passive rows remain secondary. |
| PR7 | Fault injection inside real-world task episodes | #1259, #1303, #1304 | Converts reliability into real-world task-completion stress evidence judged by final postconditions. |
| PR8 | Full live/recorded benchmark orchestration and release gate | #1254, #1310 | Integrates completed axes and blocks headline reports unless all gates pass. |

## Cross-cutting rules

- Mock, scaffold, dry-run, dependency-missing, and unwired rows are diagnostic.
- Skip rows are visible but excluded from headline aggregates; they are never
  scored as zero.
- Headline rows require live or recorded-real evidence, `claimEligibility`,
  pinned competitor versions, pinned LLM/model/budget metadata where relevant,
  sufficient sample counts, and final postcondition evidence.
- Existing committed result artifacts may be stale after a release; readiness
  reports must surface stale OpenChrome version pins instead of silently treating
  old results as current measurements.
