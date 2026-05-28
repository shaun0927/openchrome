# Benchmark Watch List

This is a tracked list of public web-agent benchmarks that OpenChrome does
**not** yet measure against, separated from the live evidence policy in
[`benchmark-direction.md`](./benchmark-direction.md) and the headline
eligibility rules enforced by `tests/benchmark/headline-gate.mjs`.

A benchmark moves from this file into the live suite only when **all** of the
following hold:

1. The task corpus is publicly downloadable under a license OpenChrome can
   redistribute or reference (CC-BY 4.0, MIT, Apache-2.0, BSD).
2. The judging methodology (LLM-as-a-Judge prompt, deterministic checker, or
   equivalent) is reproducible from public material.
3. We can run at least one equal-LLM, equal-budget cell against a competitor
   adapter that already lives under `tests/benchmark/adapters/`.

Until all three hold, we do **not** cite published numbers in OpenChrome
reports — this is the same evidence discipline enforced for live headlines by
[#1310 / #1424](https://github.com/shaun0927/openchrome/pull/1424).

## Currently watched

### Odysseys (Microsoft Research, Webwright 2026-05) — tracked by [#1429](https://github.com/shaun0927/openchrome/issues/1429)

- **Status:** corpus not released. Webwright's
  [GitHub repo](https://github.com/microsoft/Webwright), the
  [project homepage](https://microsoft.github.io/Webwright/), and the
  [Microsoft Research article](https://www.microsoft.com/en-us/research/articles/webwright-a-terminal-is-all-you-need-for-web-agents/)
  describe results on Odysseys but provide no dataset URL, no Hugging Face
  release, and no judge script as of 2026-05-28.
- **What's claimed publicly:** 200 long-horizon tasks, average instruction
  length 272.3 words, 100-step budget. Webwright + GPT-5.4 reaches 60.1%
  (+15.6 points over the prior Opus 4.6 SOTA at 44.5%; +26.6 points over base
  GPT-5.4 coordinate prediction at 33.5%).
- **OpenChrome action:** none until the corpus is released. We do not cite
  Webwright's Odysseys numbers in any benchmark headline produced by this
  repo. When the dataset becomes available, we add an adapter in the same
  shape as the
  [Online-Mind2Web adapter](https://github.com/shaun0927/openchrome/issues/1427)
  and re-classify [#1429](https://github.com/shaun0927/openchrome/issues/1429)
  from `task` to `enhancement, verification`.

## Removal policy

Once a benchmark passes the three gates above and lands in
`tests/benchmark/`, delete its entry from this file. This file is for
*not-yet-actionable* corpora only; it is not a roadmap.
