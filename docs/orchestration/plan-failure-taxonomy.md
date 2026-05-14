# Plan failure taxonomy

`execute_plan` failures include deterministic metadata so hosts can decide how to recover without OpenChrome mutating or rerunning plans automatically.

## Failure shape

```json
{
  "failure": {
    "class": "step_error | empty_result | timeout | contract_failed | stale_ref | auth_redirect | unknown",
    "stepOrder": 1,
    "tool": "find",
    "message": "bounded explanation"
  },
  "recoveryCandidates": [
    {
      "source": "error_handler",
      "condition": "step1_error",
      "action": "refresh refs",
      "message": "Declared recovery handler ..."
    }
  ]
}
```

Recovery candidates are metadata only. A declared `PlanErrorHandler` may still run through the pre-existing executor path; otherwise candidates are returned for the caller to inspect.

## Registry stats

`PlanRegistry.updateStats` accepts an optional failure class and persists `stats.failureClassCounts` alongside existing aggregate counters and confidence. Success confidence remains based on `successCount / totalExecutions`.

## Non-goals

This taxonomy does not generate new plans, execute undeclared recovery steps, bypass security checks, or lower domain/tool restrictions.
