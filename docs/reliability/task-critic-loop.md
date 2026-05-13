# Bounded task critic loop

The task critic loop is an opt-in helper above existing browser tools. It does not change direct `navigate`, `act`, `interact`, or `execute_plan` behavior.

Contract:

1. Run at most `maxAttempts` attempts.
2. Treat raw tool success as evidence, not task success.
3. Require a structured critic verdict before retrying or completing.
4. Stop on `success`, `terminal_failure`, or `needs_user`.
5. Retry only on `retryable_failure` while budget remains.
6. Return a compact final result with attempts, verdict, evidence used/missing, and next safe action.

Critic verdict schema:

```ts
{
  status: 'success' | 'retryable_failure' | 'terminal_failure' | 'needs_user',
  reason: string,
  evidence_used: string[],
  missing_evidence: string[],
  next_strategy: string,
}
```

Malformed verdicts become terminal failures instead of throwing or looping.
