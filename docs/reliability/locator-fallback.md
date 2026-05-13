# Locator fallback extension point

`interact` supports an opt-in locator fallback extension point for recovery from stale refs, missing elements, and ambiguous selector resolution. The default path is unchanged: no fallback provider is called unless `locatorFallback.enabled=true` (or `OPENCHROME_LOCATOR_FALLBACK=1`) is set.

The provider contract returns bounded candidates with `selector`/`backendNodeId`/`ref`, `confidence`, `reason`, and `provider`. OpenChrome validates candidates for visibility and clickability before any action is executed. The default provider is no-op, so enabled fallback fails safely unless a host/test registers a provider.

Example:

```json
{
  "tabId": "tab-1",
  "query": "Submit order",
  "action": "click",
  "locatorFallback": { "enabled": true, "minConfidence": 0.8 }
}
```

Result metadata includes `locatorFallback.provider`, `accepted`, and selected candidate confidence/reason when the fallback path is used.
