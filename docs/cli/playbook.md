# oc playbook — Declarative YAML Scenario Runner

`oc playbook run` executes a declarative YAML (or JSON) scenario file against the OpenChrome MCP server. `oc playbook validate` checks the same expanded calls against the current package's registered MCP tool schemas without executing browser actions or starting Chrome. The playbook layer remains a thin client, not a new orchestration tier.

Inspired by [Midscene's YAML scripting](https://midscenejs.com/). Unlike Midscene, OpenChrome's substrate is deterministic, so each step carries an inline **Outcome Contract** assertion instead of an LLM judgement.

---

## Quick start

```bash
# One-shot run (spawns a dedicated server child, then terminates it)
oc playbook run tests/fixtures/playbook/sanity.yaml

# Preflight against the registered MCP tool manifest; no Chrome/CDP startup
oc playbook validate tests/fixtures/playbook/sanity.yaml

# Reuse a running daemon
oc playbook run sanity.yaml --reuse --json | jq '.summary'

# Variable override + Markdown report
oc playbook run sanity.yaml --vars url=https://iana.org --out report.md
```

---

## Grammar reference

```yaml
name: <string>           # optional — appears in reports
vars:                    # optional — key/value defaults; CLI --vars override these
  KEY: value
steps:
  - id: <string>         # optional stable author-supplied step label
    <verb>:              # exactly one verb per step
      <arg>: <value>     # verb-specific args (see table below)
```

### Minimal example

```yaml
steps:
  - id: open_home
    navigate:
      url: https://example.com
```

### Full example

```yaml
name: example.com sanity
vars:
  url: https://example.com
  heading: Example
steps:
  - id: open_home
    navigate:
      url: ${url}
  - id: verify_heading
    assert:
      kind: dom_text
      selector: h1
      pattern: ${heading}
  - interact:
      query: "More information…"
  - wait_for:
      type: "navigation"
  - assert:
      kind: url
      pattern: "iana\\.org"
  - page_screenshot:
      path: /tmp/sanity.png
  - read_page:
      mode: ax
  - javascript_tool:
      code: "document.title"
  - act:
      instruction: "scroll down"
```

## Stable step IDs

Each step may include an optional author-supplied `id` alongside exactly one
verb. IDs make reports and run/validation diagnostics stable when earlier steps
are inserted or reordered.

Rules:

- IDs must match `^[a-z][a-z0-9_-]{0,63}$`.
- IDs must be unique within one playbook.
- IDs use lowercase ASCII and are compared exactly.
- IDs are metadata and are never forwarded to MCP tool arguments.
- Numeric `index` remains 0-based and is always present in run results.
- A missing ID remains absent; OpenChrome does not synthesize IDs from indexes.
- IDs do not create graph edges, jumps, dependencies, or control flow.

Legacy playbooks without IDs continue to parse and run unchanged. Plain and
Markdown reports also preserve their previous layout when no step has an ID;
the Markdown `ID` column appears only when at least one result carries an ID.

---

## Supported verbs (9 total)

| Verb | MCP tool | Key args | Notes |
|------|----------|----------|-------|
| `navigate` | `navigate` | `url` | Navigates the active tab |
| `interact` | `interact` | `query` | Clicks/activates an element by human-readable target; use `ref` only for a snapshot ref ID |
| `act` | `act` | `instruction` | Free-form action instruction (e.g. `"scroll down"`) |
| `fill_form` | `fill_form` | `fields` | Fills multiple form fields at once |
| `wait_for` | `wait_for` | `type`, `value` | Waits for a supported condition such as `navigation`, `selector`, `function`, or `url_match` |
| `page_screenshot` | `page_screenshot` | `path` | Captures a screenshot to disk |
| `read_page` | `read_page` | `mode` | Reads page content (`"ax"`, `"dom"`, `"css"`, `"semantic"`, or `"markdown"`) |
| `javascript_tool` | `javascript_tool` | `code` | Evaluates JavaScript in the page context and returns the result |
| `assert` | `oc_assert` | `kind`, `pattern`, … | Inline Outcome Contract assertion; see [Assertions](#assertions) |

All non-`assert` verbs forward their YAML args object directly to the MCP tool unchanged.

After a successful tool result that returns `tabId`, the runner reuses that tab for later same-tab browser verbs (`interact`, `act`, `fill_form`, `wait_for`, `page_screenshot`, `read_page`, `javascript_tool`) when the step does not set `tabId` explicitly. This keeps fixture playbooks runnable without hard-coding ephemeral tab IDs while preserving explicit `tabId` overrides.

---

## Assertions

`assert` steps expand to `oc_assert`. A compact assertion DSL is wrapped as `contract`; an explicit `{ contract, evidence }` object is forwarded unchanged. The step passes iff the server returns `verdict === "pass"`. Any other verdict (`"fail"`, `"inconclusive"`) counts as a failure for exit-code purposes.

### dom_text

```yaml
- assert:
    kind: dom_text
    selector: h1
    pattern: "Example"   # substring or regex
```

Expands to:
```json
{ "contract": { "kind": "dom_text", "selector": "h1", "pattern": "Example" } }
```

### url

```yaml
- assert:
    kind: url
    pattern: "iana\\.org"   # regex; escape backslashes in YAML
```

### Compound: and / or / not

```yaml
- assert:
    kind: and
    children:
      - { kind: dom_text, selector: "h1", pattern: "Example" }
      - { kind: url, pattern: "example\\.com" }
```

The playbook layer does **not** evaluate the assertion DSL. Compact `assert:` YAML is wrapped as `contract` for `oc_assert`; explicit `contract`/`evidence` payloads are forwarded unchanged.

---

## Variable substitution

Syntax: `${IDENTIFIER}` in any string scalar.

Rules:

1. **Merge order**: the `vars:` block in the playbook is the base; CLI `--vars KEY=VALUE` overrides.
2. **Plain identifiers** (`${url}`, `${BASE_URL}`) are resolved from the merged map.
3. **`${SECRET:NAME}`** — looked up from the secrets layer (issue #834) when that feature has merged. Until then, the value is looked up from the merged var map and a warning is emitted to stderr:
   ```
   [playbook] WARNING: SECRET:MY_TOKEN is a secret reference; masking layer (#834) not yet merged. Value will be used as-is from var map if present.
   ```
   **Security caveat**: do **not** commit playbook files that contain literal secret values in the `vars:` block. Use `${SECRET:NAME}` with the secrets layer, or supply secrets via `--vars SECRET:NAME=<value>` from a shell secret (e.g. `$(op read op://vault/item/field)`).
4. **Unknown variable** — exits with code `2` and an error naming the missing var and step index.

### Examples

```yaml
vars:
  base: https://example.com

steps:
  - navigate:
      url: ${base}/login       # → https://example.com/login
  - fill_form:
      fields:
        username: ${USER}      # → must be supplied via --vars USER=alice
        password: ${SECRET:DB_PASS}  # → resolved from secrets layer
```

CLI override:
```bash
oc playbook run login.yaml --vars base=https://staging.example.com --vars USER=bob
```

---

## Fail-fast semantics

The playbook executes **sequentially**. When a step fails:

1. The step is marked `failed` in the report.
2. All subsequent steps are marked `skipped` — their MCP tools are **not** called.
3. The runner disconnects and exits with code `1`.

Abbreviated output (`--json`) after step 1 fails in a 3-step playbook. The
complete schema also includes `tool`, `args`, and optional `result` fields as
documented below:

```json
{
  "name": "fail-fast fixture",
  "steps": [
    { "index": 0, "verb": "navigate", "status": "ok",      "durationMs": 45 },
    { "index": 1, "id": "verify_heading", "verb": "assert", "status": "failed", "durationMs": 12, "error": "Step 1 [verify_heading] (assert): assert verdict=\"fail\"" },
    { "index": 2, "verb": "interact", "status": "skipped", "durationMs": 0 }
  ],
  "summary": { "ok": false, "total": 3, "passed": 1, "failed": 1, "skipped": 1 }
}
```

A `--continue-on-error` flag (to collect all failures before stopping) is tracked in a follow-up issue.

---

## Registered schema validation

`oc playbook validate <file>` parses variables and expands all steps exactly like the runner, then invokes the existing registration-only `serve --introspect-tools-list` path once and validates the expanded arguments against each registered tool's `inputSchema`. It does not open an MCP session, issue `tools/call`, start Chrome, connect CDP, initialize runtime journals, write `.openchrome` state, or execute playbook actions.

```bash
oc playbook validate sanity.yaml
oc playbook validate sanity.yaml --vars url=https://iana.org --json
```

Validation reports missing tools, required properties, wrong types, enum/combinator failures, object and array constraints, and open-schema warnings. Diagnostics include step indexes, optional stable IDs, paths, and schema locations, but never include substituted argument values. Warnings do not fail validation.

This command proves **registered-schema conformance**, not that every tool call will succeed at runtime. Conditional rules implemented only by a tool handler, browser state, selector availability, authentication, or page content can still fail during `playbook run`.

Validation exit codes are `0` for no schema errors, `1` for schema or missing-tool errors, `2` for usage/parse/variable errors, and `3` for manifest discovery or parsing failures.

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | All steps and all asserts passed. |
| `1` | At least one step or assert failed (structured failure report on stdout under `--json`). |
| `2` | Usage / parse error / unknown variable. |
| `3` | I/O, spawn, or transport failure (MCP server unreachable). |

---

## CLI flags

```
oc playbook run <file> [options]

Options:
  --vars <k=v>   Variable override (repeatable). CLI values override the vars: block.
  --out <path>   Write a Markdown report to this file path.
  --reuse        Connect to an existing `openchrome serve` daemon instead of
                 spawning a new one-shot server.
  --json         Print the full RunResult as JSON on stdout (see schema below).

oc playbook validate <file> [options]

Options:
  --vars <k=v>   Variable override (repeatable). CLI values override the vars: block.
  --reuse        Reserved for session-scoped daemon validation; exits with code 2.
  --json         Print structured schema diagnostics as JSON on stdout.
```

`validate` does not accept `--out` because validation produces diagnostics rather than a run report. Passing the global `--reuse` flag to validation exits with code `2`: daemon-aware validation is deferred until the session-scoped tool-disclosure contract is available on the release branch. Using the registered local manifest avoids mutating a shared daemon's tool visibility.

### JSON output schema (`--json`)

```ts
{
  name: string | undefined,
  steps: Array<{
    index:      number,           // 0-based
    id?:        string,           // optional stable author-supplied label
    verb:       string,           // playbook verb (e.g. "navigate")
    tool:       string,           // MCP tool name (e.g. "oc_assert")
    args:       object,           // args sent to the MCP tool
    status:     "ok" | "failed" | "skipped",
    durationMs: number,           // 0 for skipped steps
    result?:    unknown,          // raw MCP response content
    error?:     string            // present on failed steps
  }>,
  summary: {
    ok:      boolean,  // true iff failed === 0 && skipped === 0
    total:   number,
    passed:  number,
    failed:  number,
    skipped: number
  }
}
```

---

## JSON-format playbooks

The same parser accepts `.json` files using the identical top-level shape:

```json
{
  "name": "example.com sanity (JSON)",
  "vars": { "url": "https://example.com" },
  "steps": [
    { "id": "open_home", "navigate": { "url": "${url}" } },
    { "id": "verify_heading", "assert": { "kind": "dom_text", "selector": "h1", "pattern": "Example" } }
  ]
}
```

Dispatch is based on file extension (`.yaml`/`.yml` → YAML parser; `.json` → `JSON.parse`).

---

## Server reuse (`--reuse`)

Without `--reuse`, the runner spawns its own `openchrome serve --server-mode` child process for the duration of the playbook and terminates it on completion.

For `oc playbook run`, `--reuse` currently falls through to one-shot spawn with a stderr warning until the legacy runner transport is replaced.

`oc playbook validate` intentionally does not reuse a daemon in this release. It reads the local registered manifest through the no-Chrome introspection path.

---

## Security caveats

- **Run-report secret exposure**: Until issue #834 (secrets layer) merges, secret values are passed through in plaintext. `oc playbook run --json` includes those values unmasked in each step's `args` field. `oc playbook validate`, including `--json`, omits substituted argument values from diagnostics.
- **Playbook files in version control**: Treat playbook files like code. Do not embed credentials in the `vars:` block; use `${SECRET:NAME}` references or supply values at runtime via `--vars`.
- **Untrusted playbooks**: `javascript_tool` steps execute arbitrary JavaScript in the browser context. Only run playbook files from trusted sources.
- **Scope**: The playbook runner is a client of the MCP server. It does not gain capabilities beyond what `openchrome serve` exposes.

---

## Out of scope (follow-up issues)

- `if` / `loop` / `parallel` constructs
- Importing or chaining playbooks
- `--continue-on-error` flag
- Recording a playbook from a live session
- Built-in Jest integration
- Web UI for editing playbooks
- Validation against a running daemon's session-scoped tool manifest
