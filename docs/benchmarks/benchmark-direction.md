# Benchmark direction: real-world task completion first

OpenChrome benchmark claims must be organized around the product question a user
actually cares about:

> Can the agent complete a realistic browser task, within the same budget, with
> evidence that the final user-visible outcome is correct?

Micro-benchmarks still matter, but they explain the outcome. They do not replace
it.

## Evidence hierarchy

1. **Primary evidence: real-world episode/task completion**
   - A task starts from a browser state, runs through a realistic workflow, and
     is judged by deterministic postcondition contracts.
   - A row is headline-eligible only when it is a live or recorded-real run,
     uses pinned library/model/environment metadata, has enough repetitions for
     the claim being made, and is not a scaffold/mock row.
   - Required outcome fields: final status, final postcondition result, task
     category, library, execution mode, repetition/sample count, steps/tool
     calls, wall time, token/cost when LLM-driven, no-progress signals, retries,
     and failure category.

2. **Stress evidence: recovery inside real tasks**
   - Recovery is not “the library did not throw”. Recovery means a fault was
     injected during a realistic workflow and the same final task contract still
     passed within budget.
   - Isolated stale-selector, timeout, CDP-drop, modal, and crash cells are
     diagnostic only unless they are embedded in a real task episode.

3. **Diagnostic evidence: micro axes**
   - Token efficiency, latency/throughput, auth setup cost, DX/LOC/schema, and
     isolated fault cells explain why a real-world task succeeded or failed.
   - These axes may have their own reports, but the unified benchmark report must
     label them as supporting diagnostics when no primary task-completion row is
     available.

## Headline eligibility rules

A benchmark row or aggregate may be described as a primary real-world claim only
when all of the following are true:

- The measurement mode is `live` or `recorded-real`; `mock`, `scaffold`, `dry-run`,
  and `skip` rows are non-headline.
- The row evaluates the final task postcondition, not only an intermediate tool
  event or thrown error.
- The same task definitions and contracts are used for every compared library.
- Competitor/library versions and relevant environment metadata are pinned in the
  result envelope.
- Sample counts meet the claim threshold: at least N >= 10 for aggregate
  real-world task claims and N >= 20 for per-task chart claims, unless a stricter
  issue-specific threshold applies.
- LLM-driven rows pin model id, temperature, max-step budget, token budget, and
  max-cost budget before measurement.

If any rule fails, the row can still be useful, but it must be labeled as a
scaffold, smoke, or diagnostic result and must not appear as a competitive win.

## Mapping existing benchmark axes

| Axis | Role in the report | Why |
| --- | --- | --- |
| #B Agent Task Success / #G Real-World Task Completion | Primary | Measures complete browser episodes against final contracts. |
| #D Reliability & Fault-Recovery | Primary only in stress-mode episodes; diagnostic when isolated | User value is recovery to final task success, not exception handling. |
| #E Auth & Real-World Usability | Primary when folded into logged-in episodes; otherwise diagnostic | Auth setup matters most when it enables task completion. |
| #A Token Efficiency | Diagnostic | Explains cost/retention tradeoffs after success is known. |
| #C Speed & Throughput | Diagnostic unless success-weighted over completed tasks | Fast failures are not user success. |
| #F Developer Experience | Diagnostic | LOC/schema/actionability explain adoption and agent ergonomics, not task success. |
| Episode token cost | Diagnostic qualifier | Token cost is meaningful per successful episode and as expected cost including failures. |

## Implementation implications

- Build new harness work around the episode envelope first, then attach token,
  timing, recovery, and failure-taxonomy fields to that envelope.
- Report generators must expose a “headline eligible” decision and reason list.
- Mock and scaffold data should remain CI-safe, but its purpose is harness
  regression, not competitive evidence.
- Follow-up issues should be concrete slices toward live/recorded-real episode
  evidence: competitor native adapters, repeated LLM runs, recovery-in-episode
  injection, and report integration. Issue #1310 tracks the final report-layer
  headline-eligibility integration across #1300-#1305.
