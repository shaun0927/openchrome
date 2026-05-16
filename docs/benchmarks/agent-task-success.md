# Agent Task Success benchmark direction

Issue #1257 should not be treated as "any WebVoyager lookup task = agent task
success". WebVoyager-style public-web tasks are useful, but they mostly measure
stable navigation and information retrieval. Headline Agent Task Success also
needs controlled, stateful, realistic workflows where an agent must manipulate
UI state, avoid no-progress loops, and finish under a budget.

## Benchmark layers

1. **Stable public-web lookup (WebVoyager-style)** — public pages, no login, no
   side effects, contract-evaluated final state. This remains useful for
   cross-library navigation/information retrieval comparisons.
2. **Controlled realistic workflows** — local/mock browser tasks with resettable
   state and deterministic contracts. These are the CI-safe foundation for
   headline Agent Task Success because they can cover form fill, transactional
   mock flows, recovery/no-progress, dynamic UI, and eventually long-horizon
   flows without site drift.
3. **Live opt-in runs** — real Claude + real browser/library adapters, pinned
   model/version/budget, never required for CI and never mixed with controlled
   mock numbers.

## Current controlled workflow harness

`tests/benchmark/episode-harness` now emits Agent Task Success foundation metrics:

- task taxonomy category (`info_retrieval`, `form_fill`, `transactional_mock`,
  `recovery`, `dynamic_ui`, `long_horizon`),
- real repeated samples via `--repetitions`,
- success and Outcome Contract status,
- steps/tool calls/no-progress episodes,
- first agent-selected tool and expected-first-tool accuracy,
- deterministic `cl100k_base` token estimates for agent prompt context,
  assistant tool-call output, tool arguments, tool results, and total task
  tokens,
- per-task aggregate rows with p50/p95 duration and tool-call counts.

Run the CI-safe controlled foundation benchmark:

```bash
npm run bench:agent-success:mock -- --repetitions 3 --out /tmp/openchrome-agent-success
```

The output is intentionally labeled `mode: controlled-mock`. It is not a live
Claude competitor comparison and must not be reported as such.

## Follow-up issue split

- #1300 — controlled realistic workflow suite expansion.
- #1301 — real LLM repetitions and full-task metrics gate.
- #1302 — native/passive competitor adapter matrix.

## Claiming rules

- Do not publish a cross-library headline while any competitor is scaffolded.
- Do not claim N>=10 unless the result file contains at least 10 samples for the
  task/library/mode cell.
- Do not use WebVoyager lookup alone as the full Agent Task Success headline;
  report it as the public-web lookup layer.
- Keep native and passive-tool modes in separate result envelopes. Browser-use
  passive-tool mode is a secondary diagnostic only because it removes its native
  planning/retry loop.
