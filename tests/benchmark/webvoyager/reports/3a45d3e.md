# WebVoyager contract-eval report

- git_sha: `3a45d3e`
- adapter: `mock`
- timestamp: `2026-05-12T10:46:03.099Z`
- contract_eval_score: **3 / 3** (pass=3, fail=0, pending=7, total=10)

## Per-task results

| Task | Result | Duration (ms) | Tool calls | Response bytes | Failed postcondition |
| --- | --- | ---: | ---: | ---: | --- |
| task-01-example-com-title | passed | 2 | 2 | 765 |  |
| task-02-mdn-fetch-syntax | pending | 0 | 0 | 0 |  |
| task-03-wikipedia-eiffel-height | pending | 0 | 0 | 0 |  |
| task-04-rfc-9110-section-9-title | passed | 2 | 2 | 768 |  |
| task-05-w3c-html-section-definition | pending | 0 | 0 | 0 |  |
| task-06-arxiv-2401-13919-abstract | pending | 0 | 0 | 0 |  |
| task-07-rust-string-trim-method | pending | 0 | 0 | 0 |  |
| task-08-mdn-array-map-return | pending | 0 | 0 | 0 |  |
| task-09-wikipedia-speed-of-light | pending | 0 | 0 | 0 |  |
| task-10-tc39-ecma262-strict-mode | passed | 2 | 1 | 433 |  |

## Comparison footer

- notte open-operator-evals (WebVoyager30, self-reported): 86.2% self-eval, 79.0% LLM-eval, 47s median wall-time per task.
- OpenChrome scores are contract-eval (URL / DOM / network / screenshot postconditions decided by `src/contracts/evaluate.ts`), which is stricter than LLM-judge eval and intentionally not directly comparable to notte's numbers.
