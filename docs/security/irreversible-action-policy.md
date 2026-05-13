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

## Operator guidance

Use this matrix as the common policy source for ToolAnnotations, dry-run previews, elicitation hooks, and TaskRun checkpoints. Future tool integrations should call the shared helper before executing a destructive commit path and should include the returned decision in structured tool output when blocked.
