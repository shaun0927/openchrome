# Extension Connector Phase 0 — Go/No-Go Memo

> **DRAFT — populate after running the measurement.**
> This template ships with the PR so reviewers have the schema ready.
> The results table rows below are placeholders; fill them in by running:
>
> ```
> node scripts/experiments/B1-phase0-measure.mjs --arm=openchrome
> node scripts/experiments/B1-phase0-measure.mjs --arm=browsermcp
> ```
>
> Once both tables are populated, replace `<pending — fill from measurement>`
> entries with actual values and remove this preamble block.

## Metadata

| Field | Value |
|-------|-------|
| Date | `<pending — fill from measurement>` |
| Reviewer | `<pending — fill from measurement>` |
| Machine | `<pending — fill from measurement (OS, CPU, RAM)>` |
| Chrome version | `<pending — fill from measurement>` |
| BrowserMCP version | `<pending — fill from measurement (git SHA or release tag)>` |
| OpenChrome version | 1.11.0 |
| Fixture version | `tests/fixtures/waf-targets.json` v1 |

## Hypothesis

> H1: On the 5-URL target set, BrowserMCP successfully loads the page to first
> contentful paint and produces a non-empty ARIA snapshot on **at least 3 of 5**
> targets where OpenChrome's headed-CDP+stealth mode currently fails.

## Operational Pass/Fail Definition

A target is **loaded successfully** iff ALL of the following are true:

1. Top-level navigation reaches HTTP status 200.
2. No element matching any challenge-interstitial selector (see fixture
   `challenge_selectors`) is present in the post-load DOM.
3. `document.querySelector('h1, h2, [role=heading]')` exists and
   `textContent.length > 0`.

A target **fails** if any condition above is false. No human judgement is part
of the verdict.

## Results Table — OpenChrome arm (headed CDP + stealth)

> Run: `node scripts/experiments/B1-phase0-measure.mjs --arm=openchrome`

| Slot | URL | HTTP | Challenge | Heading | Pass? | Screenshot |
|------|-----|------|-----------|---------|-------|------------|
| C1 | `https://example.com/` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [C1-openchrome.png](B1-phase0-evidence/C1-openchrome.png) |
| C2 | `https://news.ycombinator.com/` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [C2-openchrome.png](B1-phase0-evidence/C2-openchrome.png) |
| T1 | `https://nowsecure.nl/` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [T1-openchrome.png](B1-phase0-evidence/T1-openchrome.png) |
| T2 | `https://www.amazon.com/dp/B07XJ8C8F5` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [T2-openchrome.png](B1-phase0-evidence/T2-openchrome.png) |
| T3 | `https://www.zillow.com/homes/Seattle-WA_rb/` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [T3-openchrome.png](B1-phase0-evidence/T3-openchrome.png) |

**Baseline validity check**: If C1 or C2 fail under the OpenChrome arm, the
measurement is invalid — regenerate before drawing any conclusions.

## Results Table — BrowserMCP arm (extension, no CDP)

> Run: `node scripts/experiments/B1-phase0-measure.mjs --arm=browsermcp`
> (prints step-by-step instructions; reviewer fills in results manually)

| Slot | URL | HTTP | Challenge | Heading | Pass? | Screenshot |
|------|-----|------|-----------|---------|-------|------------|
| C1 | `https://example.com/` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [C1-browsermcp.png](B1-phase0-evidence/C1-browsermcp.png) |
| C2 | `https://news.ycombinator.com/` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [C2-browsermcp.png](B1-phase0-evidence/C2-browsermcp.png) |
| T1 | `https://nowsecure.nl/` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [T1-browsermcp.png](B1-phase0-evidence/T1-browsermcp.png) |
| T2 | `https://www.amazon.com/dp/B07XJ8C8F5` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [T2-browsermcp.png](B1-phase0-evidence/T2-browsermcp.png) |
| T3 | `https://www.zillow.com/homes/Seattle-WA_rb/` | `<pending>` | `<pending>` | `<pending>` | `<pending>` | [T3-browsermcp.png](B1-phase0-evidence/T3-browsermcp.png) |

## Decision Rule

**Go (file Phase 1 follow-up issue)** iff:
- BrowserMCP passes on **3 or more** of T1/T2/T3, **AND**
- OpenChrome fails on those **same slots**.

**No-go (close as "no evidence for H1")** otherwise.

Verdict: `<pending — fill from measurement>`

## Methodology

1. Fixed target set committed in `tests/fixtures/waf-targets.json` (v1).
   Substitutions are allowed only if a URL becomes unreachable before the memo
   is filed; each substitution must be noted here with rationale.
2. OpenChrome arm run by `B1-phase0-measure.mjs --arm=openchrome` on the
   reviewer's local machine (headed Chrome, no proxy).
3. BrowserMCP arm measured manually per the instructions printed by
   `B1-phase0-measure.mjs --arm=browsermcp` using BrowserMCP's published
   extension (no fork) in a profile-isolated Chrome.
4. Both arms measured on the same machine in the same session to control for
   network conditions.
5. Screenshots captured per target stored in `docs/experiments/B1-phase0-evidence/`.
6. Pass/fail evaluated objectively per the operational definition above — no
   human judgement in the verdict.

## Recommendation

`<pending — fill from measurement>`

(Example if go: "BrowserMCP passed T1/T2/T3 while OpenChrome failed all three.
File Phase 1 follow-up to implement the extension connector.")

(Example if no-go: "BrowserMCP did not meet the 3-of-3 threshold on targets
where OpenChrome fails. Close as no evidence for H1; revisit if target set
changes.")

## References

- Issue: #892 (BrowserMCP adoption B-1: extension connector Phase 0 spike)
- Fixture: [`tests/fixtures/waf-targets.json`](../../tests/fixtures/waf-targets.json)
- Measurement script: [`scripts/experiments/B1-phase0-measure.mjs`](../../scripts/experiments/B1-phase0-measure.mjs)
- BrowserMCP repository: https://github.com/BrowserMCP/mcp (Apache-2.0)
- OpenChrome stealth: issue #453 (closed)
- Anti-patterns to avoid in any Phase 1: BrowserMCP `0.0.0.0` WS binding (#158),
  `kill -9` port-holder pattern (#143/#151)
