# Research recipes

Composable recipes for multi-source research workflows over the openchrome
MCP surface. Each recipe lists the exact MCP tool calls a host LLM should
make and where its own synthesis happens. openchrome never calls an LLM
itself (P3): the server emits structured browser observations; the host
model composes them into prose.

| Recipe | Goal | Tools touched |
|---|---|---|
| [topic-survey.md](topic-survey.md) | Survey a public fixture and capture a bounded landing-page fact set before deeper crawl/extract work. | `crawl_sitemap`, `extract_data`, `validate_page`, `batch_execute` |
| [single-page-deep-extract.md](single-page-deep-extract.md) | Extract a small structured row set from one high-value public page, then verify it before synthesis. | `read_page`, `extract_data`, `oc_assert`, `batch_execute` |
| [changelog-watch.md](changelog-watch.md) | Compare two deterministic observations of a stable page and only summarize when drift is detected. | `oc_evidence_bundle`, `read_page`, `batch_execute` |
| [action-cache-v2.md](action-cache-v2.md) | Interpret `act` cache status and verify page-fingerprint drift behavior. | `act` |
| [fast-profile.md](fast-profile.md) | Enable and verify the opt-in low-token runtime profile. | `oc_get_connection_info`, `read_page` |
| [multi-source-news-digest.md](multi-source-news-digest.md) | Pull headlines from several news sources and produce a one-screen daily digest. | `navigate`, `read_page`, `crawl` |
| [fit-markdown.md](fit-markdown.md) | Return raw and fit markdown with deterministic prune/BM25 filters. | `read_page`, `crawl`, `crawl_sitemap` |
| [docs-changelog-diff.md](docs-changelog-diff.md) | Compare two snapshots of a docs page (e.g. before/after a release) and explain what changed. | `navigate`, `read_page` |
| [semantic-extract-data.md](semantic-extract-data.md) | Use query-based semantic `extract_data` host fallback with bounded chunks. | `extract_data` |
| [competitive-feature-matrix.md](competitive-feature-matrix.md) | Build a structured feature-matrix table across several vendor pages. | `navigate`, `extract_data`, `read_page` |
| [semantic-login-flow.md](semantic-login-flow.md) | Resolve semantic query refs, drive plan actions, and verify with an Outcome Contract. | `oc_query`, `fill_form`, `interact`, `oc_assert`, `oc_evidence_bundle`, `execute_plan` |
| [safe-plan-contract.md](safe-plan-contract.md) | Run reusable compiled browser workflows with v2 allow-list validation and bounded execution evidence. | `execute_plan` |

## How recipes are structured

Every recipe follows the same shape so they stay copy-paste-runnable:

1. **Goal** — one paragraph stating the research question.
2. **Inputs** — what the host LLM needs from the user (URLs, schema, etc.).
3. **Plan** — numbered list of MCP tool calls with input shapes and expected output shapes.
4. **Synthesis** — what the host LLM does with the observations (no server-side LLM).
5. **Verification** — a step the operator can run by hand to confirm the recipe still works against the current site.

## Why this is docs and not a tool

A dedicated `oc_research_plan` tool was considered (see issue #858) and
rejected: a competent host LLM produces the same plan ad-hoc from the
existing tool descriptions, and `src/orchestration/plan-registry.ts`
already covers the deterministic-template case. Documenting the recipes
keeps the value (concrete, runnable patterns) without adding surface area
to the server.
