# WebVoyager Phase-1 task set

10 contract-eval tasks chosen to exercise the full DSL (`url`, `dom_text`,
`dom_count`, logical operators) against real public web content. **No new
operators are introduced**; every task's `contract` validates against
`src/contracts/types.ts` as committed on `develop`.

## Selection criteria (committed contract)

- **Anonymous public access.** No login, no captcha, no payment, no
  geofencing.
- **Content immutable or change-cycle >= 5 years.** Versioned specs
  (RFC / WHATWG / TC39), encyclopedia entries about historical facts,
  reserved domains. **Excludes** live-updating numbers (GitHub stars,
  HN top story, npm latest version).
- **DSL-supported.** If a task would need a new contract operator, the
  task is rejected. Brittleness mitigation uses `or`-of-acceptable
  strings inside an `and`-contract — never a new operator.
- **No proprietary content.** Wikipedia, MDN, WHATWG, RFC editor,
  arxiv.org, doc.rust-lang.org, tc39.es — all freely accessible and
  redistributable.

## Per-task rationale

| # | Task | Why it's here |
| ---: | --- | --- |
| 01 | `task-01-example-com-title` | Smoke task. RFC-2606 reserved domain; "Example Domain" H1 has been stable since at least 2013. Frozen transcript. |
| 02 | `task-02-mdn-fetch-syntax` | MDN syntax block for the Fetch global; canonical signature `fetch(resource)`. |
| 03 | `task-03-wikipedia-eiffel-height` | Encyclopedia entry; physical fact (330 m). `or` covers regular vs non-breaking space without inventing operators. |
| 04 | `task-04-rfc-9110-section-9-title` | RFCs are immutable by IETF policy. Frozen transcript. |
| 05 | `task-05-w3c-html-section-definition` | WHATWG Living Standard text. The phrase "represents a generic section" is the canonical normative definition. |
| 06 | `task-06-arxiv-2401-13919-abstract` | arXiv preprint metadata (authors) is immutable per arXiv policy. |
| 07 | `task-07-rust-string-trim-method` | Tests link-following: `String::trim` redirects to `str::trim`, URL anchor encodes the semantic landing. |
| 08 | `task-08-mdn-array-map-return` | MDN "Return value" wording for `Array.prototype.map()` has been stable for years. |
| 09 | `task-09-wikipedia-speed-of-light` | Physical constant defined by the SI in 1983; the literal digit sequence cannot drift. |
| 10 | `task-10-tc39-ecma262-strict-mode` | Trivial reachability for the canonical ECMAScript spec. Frozen transcript. |

## Transcript freeze policy

Tasks 01, 04, 10 ship with hand-authored mock transcripts sufficient to
exercise the replay+contract path end-to-end. The other 7 are marked
`pending: true` and are skipped by the mock runner (recorded as
`pending` in the report). A follow-up PR records real transcripts via
the claude adapter and removes the `pending` flag.

Any change to a task spec OR a meaningful model behaviour change
requires explicit re-recording — the recording PR title must include
`[transcript-rerecord: <task names>]`.
