# Irreversible action policy matrix

OpenChrome classifies high-risk browser actions deterministically so host agents can preview, checkpoint, or elicit confirmation before committing side effects. The policy is not an LLM judge and does not gate read-only browsing.

## Default matrix

| Tool/action | Risk | Trigger | Required prerequisite |
| --- | --- | --- | --- |
| `read_page`, `tabs_context`, `query_dom` | read_only | always | none |
| `cookies` | destructive | delete/delete-all/clear/remove | `dryRun:true`, then elicitation |
| `storage` | destructive | clear/delete/remove | `dryRun:true`, then elicitation |
| `oc_stop` | destructive | always | elicitation and checkpoint ≤ 5 minutes old |
| `oc_reap_orphans` | destructive | always | `dryRun:true`, then elicitation |
| `request_intercept` | external_side_effect | broad block/abort rules | `dryRun:true` preview |
| `file_upload` | external_side_effect | always | elicitation and checkpoint ≤ 5 minutes old |
| `act`/`interact` | irreversible | deterministic submit/payment/delete text | elicitation, checkpoint ≤ 5 minutes old, contract precheck |
| `navigate` | external_side_effect | URL outside task `allowedDomains` | blocked until URL/domain policy changes |

## Structured decisions

`evaluateToolRiskPolicy()` returns one of:

- `allow` — no gate required or all prerequisites are satisfied.
- `preview_required` — run the documented dry-run/preview path before commit.
- `elicitation_required` — host confirmation support is required.
- `checkpoint_required` — create or refresh a task/session checkpoint first.
- `blocked` — deterministic policy forbids this action, such as navigation outside `allowedDomains`.

Every denial includes `policy`, `reason`, `missing`, and `suggested_next_action` fields for auditability.

## Where this runs: facts in core, enforcement in pilot

This split follows the portability-harness contract (P4 facts-before-decisions,
P7 core-boring/pilot-experimental). There is exactly **one** deterministic
classifier — `evaluateToolRiskPolicy()` / `getEffectiveToolRiskPolicy()` in
`src/security/tool-risk-policy.ts`.

- **Core surfaces the decision as a fact.** The read-only `oc_policy` tool
  exposes the matrix and the structured decision. Core tool dispatch does **not**
  block an action on the host's behalf; it returns facts and the host agent
  decides. This is deliberate — core making a blocking judgment would violate
  P4/P7.
- **Pilot enforces.** When the contract runtime is enabled (`--pilot` +
  `OPENCHROME_CONTRACT_RUNTIME=1`), `runWithContract` fires the
  `beforeIrreversibleAction` hook (`src/pilot/runtime/`) immediately before an
  irreversible action, applying preview / checkpoint / elicitation / abort per
  the contract's `on_fail` policy. With pilot off, no enforcement runs and core
  behavior is unchanged.

> Note: a second, never-wired keyword classifier
> (`src/harness/irreversible-action.ts`, `guardIrreversibleBrowserAction`) was
> removed to keep a single source of truth. Risk classification lives in
> `tool-risk-policy.ts`; enforcement lives in the pilot runtime hook.

## Operator guidance

Use this matrix as the common policy source for ToolAnnotations, dry-run previews, elicitation hooks, and TaskRun checkpoints. Future tool integrations should call the shared helper before executing a destructive commit path and should include the returned decision in structured tool output when blocked.

## Inspecting policy at runtime

Use the read-only `oc_policy` tool to inspect or evaluate the effective policy without executing the target action.

- `oc_policy({"action":"matrix"})` returns the static policy matrix.
- `oc_policy({"action":"evaluate","tool":"cookies","args":{"action":"delete-all"}})` returns the same structured decision helper used by policy consumers, for example `preview_required` with missing `dryRun`.
- `oc_policy({"action":"evaluate","tool":"navigate","args":{"url":"https://example.com"},"allowedDomains":["localhost"]})` shows the deterministic allowed-domain decision.

`oc_policy` is read-only and never performs the high-risk action it evaluates.
