# WebVoyager contract-eval report

- git_sha: `befc568a`
- adapter: `mock`
- provider/model: `none` / `none`
- budget: max_tokens=4096, max_tool_iterations=50, max_usd_per_task=$0.5
- timestamp: `2026-05-17T16:23:34.685Z`
- contract_eval_score: **3 passed / 3 required / 61 total (58 pending)** (pass=3, fail=0, pending=58, total=61)
- pending tasks: **58** of 61 (no frozen transcript yet — skipped by mock runner)

## Per-task results

| Task | Rep | Result | Duration (ms) | Tool calls | Tokens | USD | Budget abort | Failed postcondition |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| task-01-example-com-title | 1 | passed | 1 | 2 | n/a | n/a |  |  |
| task-02-mdn-fetch-syntax | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-03-wikipedia-eiffel-height | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-04-rfc-9110-section-9-title | 1 | passed | 1 | 2 | n/a | n/a |  |  |
| task-05-w3c-html-section-definition | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-06-arxiv-2401-13919-abstract | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-07-rust-string-trim-method | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-08-mdn-array-map-return | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-09-wikipedia-speed-of-light | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-10-tc39-ecma262-strict-mode | 1 | passed | 1 | 1 | n/a | n/a |  |  |
| task-11-example-org-title | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-12-wikipedia-everest-height | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-13-mdn-array-length | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-14-rfc-2606-reserved-domains | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-15-whatwg-article-element | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-16-rust-option-enum | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-17-python-len-builtin | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-18-rfc-8259-json-title | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-19-example-com-h1 | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-20-example-org-h1 | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-21-example-net-h1 | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-22-wikipedia-light-speed | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-23-wikipedia-everest | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-24-wikipedia-mariana-trench | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-25-wikipedia-eiffel-tower | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-26-wikipedia-statue-of-liberty | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-27-wikipedia-internet-protocol | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-28-wikipedia-ascii | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-29-wikipedia-pi | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-30-wikipedia-utf8 | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-31-wikipedia-tim-berners-lee | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-32-wikipedia-rfc-editor | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-33-rfc-2606-reserved | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-34-rfc-2119-keywords | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-35-rfc-8259-json | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-36-rfc-9110-http | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-37-rfc-7231-http-methods | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-38-rfc-3986-uri | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-39-rfc-5321-smtp | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-40-rfc-6749-oauth | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-41-mdn-fetch | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-42-mdn-array-map | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-43-mdn-array-filter | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-44-mdn-promise-then | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-45-mdn-async-await | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-46-mdn-css-grid | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-47-mdn-css-flexbox | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-48-mdn-html-img | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-49-tc39-ecma262-syntax | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-50-tc39-proposals | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-51-whatwg-html-spec | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-52-whatwg-fetch-spec | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-53-w3c-css-spec | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-54-rust-string-trim | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-55-rust-option-enum | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-56-rust-result-enum | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-57-rust-vec | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-58-python-len-builtin | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-59-python-list-stdtypes | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-60-python-dict-stdtypes | 1 | pending | 0 | 0 | n/a | n/a |  |  |
| task-61-python-pep-8 | 1 | pending | 0 | 0 | n/a | n/a |  |  |

## Comparison footer

- notte open-operator-evals (WebVoyager30, self-reported): 86.2% self-eval, 79.0% LLM-eval, 47s median wall-time per task.
- OpenChrome scores are contract-eval (URL / DOM / network / screenshot postconditions decided by `src/contracts/evaluate.ts`), which is stricter than LLM-judge eval and intentionally not directly comparable to notte's numbers.
