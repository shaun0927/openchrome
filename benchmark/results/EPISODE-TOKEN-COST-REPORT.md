# Episode-level Token Cost Benchmark (#1299)

This benchmark complements #1256. #1256 measures a single page-observation payload; this benchmark measures token cost across a full task episode until success, failure, max steps, or timeout.

## Summary

- Adapter: mock
- Passed: 2/3 (66.7%)
- p50 successful total tokens: 289.5
- p95 successful total tokens: 419.6
- Expected tokens including failures: 330.7
- Tool-result token share: 26.6%

## Episodes

| Task | Status | Success | Total tokens | Prompt | Tool req | Tool result | Contract | Tool calls | No-progress | Duration ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| example-h1 | passed | true | 145 | 62 | 13 | 24 | 46 | 1 | 0 | 0 |
| local-form-submit | passed | true | 434 | 61 | 75 | 103 | 195 | 5 | 0 | 0 |
| local-recovery-stall | max_steps | false | 413 | 68 | 44 | 137 | 164 | 4 | 1 | 0 |

## Methodology

- Tokenizer: `cl100k_base` via the shared benchmark tokenizer.
- Deterministic default adapter: `mock`, so CI and local runs do not require credentials or live web access.
- Primary metric: total tokens per successful task. Failure-inclusive expected tokens is reported separately so failed cheap runs do not look good.
- Live/full real-world adapters should reuse this schema and add model-reported output tokens when available.