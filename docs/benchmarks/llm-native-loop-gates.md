# Benchmark LLM and native competitor loop gates

This document closes the ambiguity for #1257, #1299, #1300, #1301, and #1302:
mock/local rows are useful for CI, but live agent-success and cost claims require
provider-backed or recorded-real loops with native competitor execution evidence.

## Required row schema

Each live or recorded-real row must include:

- `provider`: `anthropic` or `openai` for LLM-mediated rows, or `native` for a
  competitor-native row.
- `model` and immutable model/version metadata.
- `adapter`: OpenChrome, Playwright, Puppeteer, playwright-mcp, browser-use,
  Crawlee, or another explicitly versioned competitor.
- `budget`: wall-clock, max tool calls, max tokens, and retry policy.
- `task`: taxonomy id, fixture version, objective, and success predicate.
- `repetitions`: at least 3 attempts per `(provider, model, adapter, task)` cell
  before comparing success rate.
- `cost`: input tokens, output tokens, cache tokens when available, and USD
  conversion source/date. Rows without cost metadata are not eligible for #1299.
- `trace_artifacts`: raw tool transcript or native logs with secrets redacted.
- `final_postcondition`: machine-readable PASS/FAIL reason.

## Native competitor matrix

Native/passive competitors must run through their own idiomatic interface rather
than being driven by OpenChrome unless the row is explicitly marked `passive`.
For each competitor row, record:

| Field | Requirement |
| --- | --- |
| install command | Exact package/version or git SHA. |
| launch command | Exact command and environment. |
| browser ownership | Whether it launches Chrome, attaches to CDP, or uses an extension. |
| artifact path | JSON/log/screenshot path for every repetition. |
| skip reason | Required when the competitor cannot run in the operator environment. |

## Promotion rule

A #1257/#1300/#1301/#1302 task-success claim is headline-eligible only when every
compared adapter has either a valid row or an explicit skip row reviewed in the
same PR. A #1299 cost claim is headline-eligible only when every successful and
failed attempt has token/cost metadata from the same pricing snapshot.
