# Safe plan contract

Use compiled plans for repeatable browser workflows only when the plan can prove
its execution boundary before any tool runs. Safe plans opt into the v2 contract
with `contractVersion: 2`.

## Goal

Run a reusable browser workflow through `execute_plan` while preserving a clear
tool allow-list, bounded recovery, deterministic success criteria, and step
evidence for review.

## Inputs

- A registry plan whose compiled JSON includes:
  - `contractVersion: 2`
  - non-empty `allowedTools`
  - explicit `successCriteria`
  - positive `timeout` on every plan and recovery step
- Runtime `params` required by the plan templates.
- Optional `taskSignature` when the host also wants deterministic runtime budget
  and loop guards.

## Safe contract fields

```json
{
  "contractVersion": 2,
  "allowedTools": ["navigate", "read_page", "extract_data"],
  "steps": [
    {
      "order": 1,
      "tool": "navigate",
      "args": { "tabId": "${tabId}", "url": "${targetUrl}" },
      "timeout": 10000,
      "risk": "interactive"
    }
  ],
  "errorHandlers": [],
  "successCriteria": { "requiredFields": ["targetUrl"] }
}
```

`risk` is descriptive metadata for reviewers. Enforcement is based on the
allow-list, handler existence, timeouts, bounded recovery steps, and template
syntax.

## Plan

1. Store the compiled plan through the plan registry.
2. Call `execute_plan` with `planId`, `tabId`, and required `params`.
3. If the v2 contract is invalid, execution fails before the first tool call.
4. Inspect the response `evidence` array:
   - `source: "plan"` for primary steps
   - `source: "recovery"` for recovery-handler steps
   - `outcome: "success" | "error" | "empty"`

## Verification

Safe plans reject:

- unknown tools
- tools not present in `allowedTools`
- missing or non-positive step timeouts
- malformed `${param}` substitutions
- missing `successCriteria`
- recovery handlers with more than 10 steps

Legacy plans without `contractVersion: 2` keep the previous compatibility path.
