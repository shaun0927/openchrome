# `oc_vitals`

`oc_vitals` captures a read-only Web Vitals snapshot from an existing tab using
browser `performance` entries only. It does **not** install the `web-vitals`
package and does not mutate the page.

## Input

```json
{
  "tabId": "page-1",
  "timeoutMs": 5000
}
```

`tabId` is required. `timeoutMs` defaults to 5000ms and is clamped to
100..30000ms.

## Output

```json
{
  "action": "oc_vitals",
  "tabId": "page-1",
  "source": "performance_entries",
  "noDependency": true,
  "vitals": {
    "lcp": {"valueMs": 1234, "rating": "good", "element": "@e7", "occurredAtMs": 1100},
    "cls": {"value": 0.05, "rating": "good", "largestShift": {"valueMs": 12, "value": 0.03}},
    "inp": {"valueMs": 180, "rating": "good", "interactionCount": 3},
    "ttfb": {"valueMs": 220, "rating": "good"},
    "fcp": {"valueMs": 900, "rating": "good"}
  }
}
```

When the browser has no interaction timing entries, `inp` is `null` and
`inpNullReason` is `"no-interaction"` (or `"unsupported"` if event timing entries
exist but no interaction id is exposed). LCP `element` prefers an existing alias
attribute such as `data-oc-ref="@e7"`; otherwise it returns a stable CSS selector
best-effort fallback.

## Rating thresholds

- LCP: good `<=2500ms`, poor `>4000ms`
- CLS: good `<=0.1`, poor `>0.25`
- INP: good `<=200ms`, poor `>500ms`
- TTFB: good `<=800ms`, poor `>1800ms`
- FCP: good `<=1800ms`, poor `>3000ms`
