# Browser Task Signatures

`BrowserTaskSignature` is a deterministic boundary for browser work. It is not a prompt, optimizer, or LLM policy. A signature declares task inputs, allowed OpenChrome tools, success/stop/failure contracts, loop guards, and optional budgets so a host or compiled plan can decide whether to continue without natural-language interpretation.

## Minimal example

```json
{
  "version": 1,
  "id": "fixture.search.success",
  "description": "Search form reaches result state",
  "inputs": {
    "query": { "type": "string", "required": true, "redaction": "none" },
    "password": { "type": "string", "required": false, "redaction": "secret" }
  },
  "allowedTools": ["navigate", "find", "interact", "read_page"],
  "success": { "kind": "dom_text", "selector": "#result", "contains": "Searched: cats" },
  "loopGuards": [{ "kind": "max_observation_calls", "limit": 2, "window": 4 }],
  "budgets": { "maxToolCalls": 8, "maxWallMs": 30000 }
}
```

## Semantics

- `allowedTools` is a hard preflight boundary for signature-bound `execute_plan` calls. If a compiled plan references a tool outside the allow-list, the plan is rejected before any step runs.
- `success`, `stopWhen`, and `failureWhen` reuse the existing outcome-contract DSL from `src/contracts/types.ts` and are validated by the same assertion validator.
- `loopGuards` deterministically stop repeated same-tool, observation, or non-progress calls within a window.
- `budgets` stop work once `maxToolCalls` or `maxWallMs` is exhausted.
- Inputs marked `redaction: "secret"` should be passed through `redactTaskSignatureInputs` before logs or reports.

## Current integration

`execute_plan` accepts an optional `taskSignature` object. No-signature calls preserve the previous response shape: the `taskSignature` field is absent unless the caller supplies one. Signature-bound execution enforces preflight allow-lists plus loop/budget status; contract assertion evaluation is exposed through `evaluateTaskSignature` for callers that have an `EvalContext` or assertion evaluator.

## Non-goals

No server-side LLM calls, DSPy/Python dependency, natural-language signature inference, or replacement of the existing outcome-contract DSL.
