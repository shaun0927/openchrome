# Research recipes

Composable recipes for multi-source research workflows over the openchrome
MCP surface. Each recipe lists the exact MCP tool calls a host LLM should
make and where its own synthesis happens. openchrome never calls an LLM
itself (P3): the server emits structured browser observations; the host
model composes them into prose.

| Recipe | Goal | Tools touched |
|---|---|---|
| [fast-profile.md](fast-profile.md) | Enable and verify the opt-in low-token runtime profile. | `oc_get_connection_info`, `read_page` |
| [multi-source-news-digest.md](multi-source-news-digest.md) | Pull headlines from several news sources and produce a one-screen daily digest. | `navigate`, `read_page`, `crawl` |
| [docs-changelog-diff.md](docs-changelog-diff.md) | Compare two snapshots of a docs page (e.g. before/after a release) and explain what changed. | `navigate`, `read_page` |
| [competitive-feature-matrix.md](competitive-feature-matrix.md) | Build a structured feature-matrix table across several vendor pages. | `navigate`, `extract_data`, `read_page` |

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
