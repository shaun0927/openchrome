# Recipe: competitive feature matrix

## Goal

Build a structured table where rows are vendors and columns are
features, then hand it to the host LLM for prose commentary. The
extraction is deterministic and server-side; the prose is host-side.

## Inputs

- `vendors: { name: string; url: string }[]` — typically 3 to 8.
- `feature_schema: { feature: string; selector_hint?: string }[]` — the
  columns you want filled. `selector_hint` is optional natural-language
  guidance for `extract_data`.

## Plan

For each `vendor` in `vendors`:

1. `mcp__openchrome__navigate` `{ url: vendor.url }`.
2. `mcp__openchrome__extract_data` `{ instruction, schema }` where:
   - `instruction` describes what to find. Example: "Extract whether
     this vendor's pricing page advertises a free tier, SSO support,
     and per-seat vs per-usage billing."
   - `schema` is a JSON schema matching `feature_schema`. Example:
     ```json
     {
       "type": "object",
       "properties": {
         "free_tier": { "type": "boolean" },
         "sso_support": { "type": "boolean" },
         "billing_model": { "type": "string", "enum": ["per-seat", "per-usage", "hybrid", "unknown"] }
       },
       "required": ["free_tier", "sso_support", "billing_model"]
     }
     ```
   - Returns: `{ extracted: <object matching schema>, source_url }`.
3. **Optional** — when `extract_data` returns a low-confidence value
   (e.g. `billing_model: "unknown"`), fall back to
   `mcp__openchrome__read_page` `{ mode: "markdown", max_chars: 6000 }`
   and let the host LLM read the raw prose.

## Synthesis (host LLM)

The host receives an array of `{ vendor, extracted }` records. It
assembles the matrix locally (a literal table — no server help needed)
and writes commentary on patterns: which features are table stakes,
which are differentiators, which are outliers.

No server-side LLM. The structured extraction comes from
`extract_data`, which is deterministic given the same schema and page.

## Verification

Use three stable vendor pages where the matrix answer is
well-known:

1. `mcp__openchrome__navigate` to `https://www.anthropic.com/pricing`.
2. `mcp__openchrome__extract_data` with the schema above. Confirm
   `free_tier`, `sso_support`, and `billing_model` come back populated.
3. Repeat for `https://openai.com/pricing` and
   `https://stripe.com/pricing`.
4. Confirm the three rows of the matrix differ from each other in at
   least one column — if they're identical, the schema is wrong or
   the pages are being JS-gated.

If step 2 returns an empty `extracted` object, the page is rendered
post-load; combine with `mcp__openchrome__wait_for` against a
known-stable selector before re-running `extract_data`.

## Out of scope

- Multilingual matrices — translate downstream in the host.
- Behind-login pages — pair with `oc_skill_recall` and re-run.
- Live price tracking — schedule the recipe externally; openchrome
  itself does not run cron.
