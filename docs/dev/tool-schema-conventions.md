# Tool Schema Conventions

This document describes the six schema-shape rules enforced by `scripts/lint-tool-schemas.mjs`
on every MCP tool exposed by openchrome.

These rules are derived from [apify-mcp-server](https://github.com/apify/apify-mcp-server)
(Apache-2.0) and codify hard-won LLM compatibility lessons: clients silently truncate
or mis-render long descriptions and large enums.

## Rules

### 1. `description_length` — Tool description ≤ 500 chars

Each tool's top-level `description` field must be at most **500 characters**.

Configurable via `OPENCHROME_LINT_DESCRIPTION_MAX` env var.

### 2. `field_description_length` — Input property description ≤ 300 chars

Each property inside `inputSchema.properties` must have a `description` of at most
**300 characters**.

### 3. `enum_total_length` — Enum combined length ≤ 2000 chars

For properties of type `enum`, `JSON.stringify(values).length` must be ≤ **2000**.
This prevents clients from dropping or truncating large enum arrays.

### 4. `required_prefix` — Required fields start with `REQUIRED `

Every field listed in `inputSchema.required` must have a `description` that begins
with the literal token **`REQUIRED `** (uppercase, one trailing space).

This ensures LLM clients that do not honour JSON-Schema `required: [...]` still
surface required-ness to the model.

Example:
```json
{
  "url": {
    "type": "string",
    "description": "REQUIRED The URL to navigate to."
  }
}
```

### 5. `name_pattern` — Tool name format

Tool names must match `^[a-z][a-z0-9_]{2,63}$`:
- Lowercase letters, digits, and underscores only.
- Starts with a lowercase letter.
- Between 3 and 64 characters total.

### 6. `duplicate_name` — No two tools share a name

The MCP tool registry must expose unique names. The lint script catches accidental
duplicates that would otherwise silently overwrite earlier registrations.

## Enforcement

The CI workflow runs `npm run lint:tool-schemas` on every PR that touches
`src/tools/**` or `src/index.ts`.

Known violations are tracked in `scripts/lint-tool-schemas.baseline.json`.
New violations that are not in the baseline fail CI. The baseline operates as a
**one-way ratchet**: `--update-baseline` refuses to add new entries (only shrinkage
is allowed).

## Commands

```bash
# Check against current baseline (CI gate)
npm run lint:tool-schemas

# Regenerate baseline after fixing violations (shrinkage only)
node dist/index.js serve --introspect-tools-list > /tmp/oc-tools.json
node scripts/lint-tool-schemas.mjs /tmp/oc-tools.json --update-baseline
```

## Relationship to other lint scripts

| Script | What it checks |
|---|---|
| `lint-changed-src.js` | TypeScript code style on changed files |
| `lint-tool-schemas.mjs` | Schema-shape budgets (this doc) |
| `lint-tool-tiers` | Tool tier boundary (dep-cruiser) |
